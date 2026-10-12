// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";
import { IPoolManager } from "v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "v4-core/src/types/PoolKey.sol";
import { PoolIdLibrary } from "v4-core/src/types/PoolId.sol";
import { Currency } from "v4-core/src/types/Currency.sol";
import { IHooks } from "v4-core/src/interfaces/IHooks.sol";
import { Hooks } from "v4-core/src/libraries/Hooks.sol";
import { TickMath } from "v4-core/src/libraries/TickMath.sol";
import { HookMiner } from "v4-periphery/test/shared/HookMiner.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { TestToken } from "../../src/test-only/TestToken.sol";
import { NVDAPriceOracle } from "../../src/oracle/NVDAPriceOracle.sol";
import { PoolGuardHook } from "../../src/hook/PoolGuardHook.sol";
import { PoolGuardSimulator } from "../../src/hook/PoolGuardSimulator.sol";
import { GuardParams } from "../../src/hook/libraries/GuardParams.sol";
import { LedgerVault } from "../../src/vaults/LedgerVault.sol";
import { StrategyModule } from "../../src/adapters/StrategyModule.sol";
import { ERC4626Adapter } from "../../src/adapters/ERC4626Adapter.sol";
import { MorphoBlueLendAdapter } from "../../src/adapters/MorphoBlueLendAdapter.sol";
import { MorphoLoopAdapter } from "../../src/adapters/MorphoLoopAdapter.sol";
import { IStrategyAdapter } from "../../src/adapters/IStrategyAdapter.sol";
import { IMorpho } from "../../src/adapters/IMorpho.sol";
import { MockMorpho } from "../../src/test-only/MockMorpho.sol";
import { MockAccountant } from "../../src/test-only/MockAccountant.sol";
import { MockERC4626 } from "../../src/test-only/MockERC4626.sol";
import { MockVaultBase, MockMorphoOracle } from "../../src/test-only/MockStrategyFakes.sol";

contract StrategyModuleTest is Test {
    TestToken internal quote;
    TestToken internal nvda;

    StrategyModule internal module;
    MockVaultBase internal mockVault;
    MockERC4626 internal venue4626;
    ERC4626Adapter internal lendAdapter;

    address internal allocator = makeAddr("allocator");
    address internal sentinel = makeAddr("sentinel");

    function setUp() public {
        quote = new TestToken("USD Coin", "mUSDC", 6);
        nvda = new TestToken("NVIDIA", "mNVDA", 18);

        module = new StrategyModule(address(this), address(quote));
        mockVault = new MockVaultBase(address(quote), address(module));
        module.setVault(address(mockVault));
        module.setAllocator(allocator);
        module.setSentinel(sentinel);
        module.setTimelock(0);

        venue4626 = new MockERC4626(address(quote));
        lendAdapter = new ERC4626Adapter(address(module), address(venue4626), address(quote));

        quote.mint(address(mockVault), 10_000e6);
        mockVault.setBaseAssets(10_000e6);
    }

    // ------------------------------------------------------------------
    // Configuration, roles, timelock
    // ------------------------------------------------------------------

    function _enableLendAdapter() internal {
        module.submitAdapter(address(lendAdapter), true, false, 5_000e6, 4_000);
        module.executeAdapter(address(lendAdapter));
    }

    function test_submitExecute_timelock() public {
        module.setTimelock(24 hours);
        module.submitAdapter(address(lendAdapter), true, false, 5_000e6, 4_000);

        vm.expectRevert();
        module.executeAdapter(address(lendAdapter));

        vm.warp(block.timestamp + 24 hours + 1);
        module.executeAdapter(address(lendAdapter));
        (bool enabled,,,,) = module.adapters(address(lendAdapter));
        assertTrue(enabled);
    }

    function test_sentinel_deRiskOnly() public {
        _enableLendAdapter();

        vm.prank(sentinel);
        module.lowerCaps(address(lendAdapter), 1_000e6, 1_000);
        (,,, uint256 abs, uint16 rel) = module.adapters(address(lendAdapter));
        assertEq(abs, 1_000e6);
        assertEq(rel, 1_000);

        vm.prank(sentinel);
        vm.expectRevert(StrategyModule.CapsNotDecreasing.selector);
        module.lowerCaps(address(lendAdapter), 2_000e6, 1_000);

        vm.prank(sentinel);
        module.disableAdapter(address(lendAdapter));
        (bool enabled,,,,) = module.adapters(address(lendAdapter));
        assertFalse(enabled);

        vm.prank(allocator);
        vm.expectRevert(abi.encodeWithSelector(StrategyModule.NotOwnerOrSentinel.selector, allocator));
        module.disableAdapter(address(lendAdapter));
    }

    function test_cancelPending() public {
        module.setTimelock(24 hours);
        module.submitAdapter(address(lendAdapter), true, false, 5_000e6, 4_000);
        vm.prank(sentinel);
        module.cancelPending(address(lendAdapter));
        (bool isPending,,,,,) = module.pending(address(lendAdapter));
        assertFalse(isPending);
    }

    // ------------------------------------------------------------------
    // ERC-4626 lend adapter
    // ------------------------------------------------------------------

    function test_lendAdapter_allocateDeallocate() public {
        _enableLendAdapter();

        vm.prank(allocator);
        module.allocate(address(lendAdapter), 500e6);

        assertEq(quote.balanceOf(address(venue4626)), 500e6);
        assertEq(lendAdapter.realAssets(), 500e6);
        assertEq(module.totalAssets(), 500e6);

        vm.prank(allocator);
        uint256 got = module.deallocate(address(lendAdapter), 200e6);
        assertEq(got, 200e6);
        assertEq(quote.balanceOf(address(mockVault)), 9_700e6);
        assertEq(lendAdapter.realAssets(), 300e6);
    }

    function test_adapter_rejectsDirectCalls() public {
        vm.expectRevert(abi.encodeWithSelector(IStrategyAdapter.NotAuthority.selector, address(this)));
        lendAdapter.deposit(1e6);
    }

    function test_absoluteCap() public {
        module.submitAdapter(address(lendAdapter), true, false, 600e6, 9_000);
        module.executeAdapter(address(lendAdapter));

        vm.prank(allocator);
        module.allocate(address(lendAdapter), 500e6);

        vm.prank(allocator);
        vm.expectRevert(abi.encodeWithSelector(StrategyModule.CapExceeded.selector, uint256(700e6), uint256(600e6)));
        module.allocate(address(lendAdapter), 200e6);
    }

    function test_relativeCap() public {
        // 10% of (base 10_000e6 + current 0) = 1_000e6
        module.submitAdapter(address(lendAdapter), true, false, 100_000e6, 1_000);
        module.executeAdapter(address(lendAdapter));

        vm.prank(allocator);
        vm.expectRevert(
            abi.encodeWithSelector(StrategyModule.RelativeCapExceeded.selector, uint256(1_100e6), uint256(1_000e6))
        );
        module.allocate(address(lendAdapter), 1_100e6);
    }

    function test_pullToVault_routing() public {
        MockERC4626 venueB = new MockERC4626(address(quote));
        ERC4626Adapter adapterB = new ERC4626Adapter(address(module), address(venueB), address(quote));

        _enableLendAdapter();
        module.submitAdapter(address(adapterB), true, false, 5_000e6, 9_000);
        module.executeAdapter(address(adapterB));

        vm.startPrank(allocator);
        module.allocate(address(lendAdapter), 100e6);
        module.allocate(address(adapterB), 400e6);
        vm.stopPrank();

        uint256 vaultBefore = quote.balanceOf(address(mockVault));
        vm.prank(address(mockVault));
        uint256 pulled = module.pullToVault(250e6);

        assertEq(pulled, 250e6);
        assertEq(quote.balanceOf(address(mockVault)) - vaultBefore, 250e6);
        assertEq(lendAdapter.realAssets(), 0);
        assertEq(adapterB.realAssets(), 250e6);
    }

    // ------------------------------------------------------------------
    // Morpho lend adapter
    // ------------------------------------------------------------------

    function _morphoMarketParams(address oracle) internal view returns (IMorpho.MarketParams memory) {
        return IMorpho.MarketParams({
            loanToken: address(quote), collateralToken: address(nvda), oracle: oracle, irm: address(0), lltv: 0.86e18
        });
    }

    function test_morphoLendAdapter_flow() public {
        MockMorpho morpho = new MockMorpho();
        MockMorphoOracle oracle = new MockMorphoOracle(2e27);
        MorphoBlueLendAdapter adapter = new MorphoBlueLendAdapter(
            address(module), address(morpho), _morphoMarketParams(address(oracle)), address(quote)
        );

        module.submitAdapter(address(adapter), true, false, 1_000_000e6, 10_000);
        module.executeAdapter(address(adapter));
        quote.mint(address(mockVault), 200_000e6);
        mockVault.setBaseAssets(200_000e6);

        vm.prank(allocator);
        module.allocate(address(adapter), 100_000e6);

        assertApproxEqRel(adapter.realAssets(), 100_000e6, 0.001e18);
        assertEq(quote.balanceOf(address(morpho)), 100_000e6);

        vm.prank(allocator);
        uint256 got = module.deallocate(address(adapter), 10_000e6);
        assertApproxEqAbs(got, 10_000e6, 2);
        assertEq(quote.balanceOf(address(mockVault)), 210_000e6 - 100_000e6 + got);
    }

    // ------------------------------------------------------------------
    // Morpho loop sleeve
    // ------------------------------------------------------------------

    function _loopSetup() internal returns (MorphoLoopAdapter loop) {
        MockMorpho morpho = new MockMorpho();
        MockMorphoOracle oracle = new MockMorphoOracle(2e27); // $2000 NVDA, loan 6-dec, coll 18-dec
        IMorpho.MarketParams memory params = _morphoMarketParams(address(oracle));
        loop = new MorphoLoopAdapter(address(module), address(morpho), params, address(quote), 6_000, 1.2e18);
        module.submitAdapter(address(loop), false, true, 1_000_000e6, 9_000);
        module.executeAdapter(address(loop));
        nvda.mint(address(mockVault), 10e18);
        vm.prank(address(mockVault));
        nvda.approve(address(module), type(uint256).max);

        // Seed the market with loan-side liquidity so the sleeve can borrow.
        quote.mint(address(this), 10_000e6);
        quote.approve(address(morpho), type(uint256).max);
        morpho.supply(params, 10_000e6, 0, address(this), "");
    }

    function test_loop_collateralBorrowRepay() public {
        MorphoLoopAdapter loop = _loopSetup();

        vm.prank(allocator);
        module.allocateCollateral(address(loop), 1e18);

        assertApproxEqAbs(loop.exposure(), 2_000e6, 2);
        assertEq(loop.debt(), 0);
        assertApproxEqAbs(loop.realAssets(), 2_000e6, 2);

        // 60% of 86% LLTV of $2000 collateral = $1032 max debt
        vm.prank(allocator);
        module.borrow(address(loop), 500e6);
        assertEq(quote.balanceOf(address(mockVault)), 10_000e6 + 500e6);
        assertApproxEqAbs(loop.debt(), 500e6, 2e6);
        assertApproxEqAbs(loop.healthFactor(), 3.44e18, 0.01e18);

        vm.prank(allocator);
        vm.expectRevert();
        module.borrow(address(loop), 600e6);

        uint256 vaultBefore = quote.balanceOf(address(mockVault));
        vm.prank(allocator);
        module.deleverage(address(loop), 200e6, 0.5e18);

        assertEq(quote.balanceOf(address(mockVault)), vaultBefore - 200e6);
        assertApproxEqAbs(loop.debt(), 300e6, 2e6);
        assertEq(loop.collateralBalance(), 0.5e18);
    }

    function test_loop_excludedFromPullToVault() public {
        MorphoLoopAdapter loop = _loopSetup();
        vm.prank(allocator);
        module.allocateCollateral(address(loop), 1e18);

        vm.prank(address(mockVault));
        uint256 pulled = module.pullToVault(1_000e6);
        assertEq(pulled, 0);
    }

    function test_loop_exitAll() public {
        MorphoLoopAdapter loop = _loopSetup();
        vm.startPrank(allocator);
        module.allocateCollateral(address(loop), 1e18);
        module.borrow(address(loop), 500e6);
        vm.stopPrank();

        vm.prank(address(mockVault));
        module.exitAll();

        assertEq(loop.collateralBalance(), 0);
        assertEq(loop.debt(), 0);
        assertEq(nvda.balanceOf(address(mockVault)), 10e18);
        // vault paid back the 500e6 debt from its own (borrowed) balance
        assertApproxEqAbs(quote.balanceOf(address(mockVault)), 10_000e6, 10);
    }

    // ------------------------------------------------------------------
    // Real vault integration
    // ------------------------------------------------------------------

    LedgerVault internal vault;
    PoolGuardHook internal hook;
    PoolGuardSimulator internal simulator;
    NVDAPriceOracle internal oracle;
    PoolKey internal key;

    function _deployRealVault() internal {
        IPoolManager manager = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        simulator = new PoolGuardSimulator();
        oracle = new NVDAPriceOracle(8, address(this));
        oracle.setWriter(address(this), true);
        oracle.setMaxStaleness(1 hours);
        oracle.updatePrice(200e8, 2, uint32(block.timestamp), bytes32(0));

        address token0 = address(quote) < address(nvda) ? address(quote) : address(nvda);
        address token1 = token0 == address(quote) ? address(nvda) : address(quote);
        int24 initialTick = token0 == address(quote) ? int24(196260) : int24(-196260);

        uint160 flags = uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG);
        bytes memory args = abi.encode(manager, simulator, address(oracle), address(nvda), address(0), address(this));
        (address expectedHook, bytes32 salt) =
            HookMiner.find(address(this), flags, type(PoolGuardHook).creationCode, args);
        hook = new PoolGuardHook{ salt: salt }(
            manager, simulator, address(oracle), address(nvda), address(0), address(this)
        );
        assertEq(address(hook), expectedHook);

        key = PoolKey({
            currency0: Currency.wrap(token0),
            currency1: Currency.wrap(token1),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });

        vault = new LedgerVault(
            manager, hook, key, IERC20(address(quote)), IERC20(address(nvda)), address(oracle), 0, address(this)
        );
        hook.setVault(address(vault));
        hook.transferOwnership(address(vault));
        vault.acceptHookOwnership();
        // Band-open for init (`initializeBook` enforces the band on live-oracle inits).
        vault.setGuardParams(
            GuardParams.Params({
                guardTickWidth: 600,
                baseTickWidth: 6000,
                guardLiquidity: 5e11,
                baseLiquidity: 1e11,
                minEvBps: 0,
                recheckMaxDeviationBps: 0,
                recheckInterval: 300,
                maxPriceAge: 300,
                allowedSessionsMask: 0
            })
        );
        // Zero-NAV bootstrap so share granularity stays fine for later deposits.
        // Wrap doors admit registered tranches only (D2) — gate at this test contract.
        vault.setAccountant(address(new MockAccountant(address(this), address(this))));
        quote.mint(address(this), 200e6);
        quote.approve(address(vault), type(uint256).max);
        vault.wrapQuote(100e6, address(this));

        quote.mint(address(vault), 100e6);
        nvda.mint(address(vault), 1e18);
        vault.fundHook(40e6, 1e18);
        vault.initializeHook(key, TickMath.getSqrtPriceAtTick(initialTick));
        oracle.updatePrice(int192(int256(hook.poolPrice1e18() / 1e10)), 2, uint32(block.timestamp), bytes32(0));
        // Arm the deviation band now that init price and oracle agree.
        vault.setGuardParams(
            GuardParams.Params({
                guardTickWidth: 600,
                baseTickWidth: 6000,
                guardLiquidity: 5e11,
                baseLiquidity: 1e11,
                minEvBps: 0,
                recheckMaxDeviationBps: 50,
                recheckInterval: 300,
                maxPriceAge: 300,
                allowedSessionsMask: 0
            })
        );
    }

    function test_realVault_navRoutingAndSettlementExit() public {
        _deployRealVault();
        vault.setStrategyModule(address(module));

        module.setVault(address(vault));
        module.submitAdapter(address(lendAdapter), true, false, 1_000_000e6, 10_000);
        module.executeAdapter(address(lendAdapter));

        quote.mint(address(vault), 1_000e6);
        uint256 baseBefore = vault.baseManagedAssets();

        // C3: no standing allowance — one-shot keeper approval per pull.
        vault.approveStrategy(address(quote), 400e6);
        vm.prank(allocator);
        module.allocate(address(lendAdapter), 400e6);
        // NAV is conserved by allocation: value moves from base assets into the adapter.
        assertEq(vault.totalManagedAssets(), baseBefore);
        assertEq(vault.baseManagedAssets(), baseBefore - 400e6);
        assertEq(module.totalAssets(), 400e6);

        // Wrap shares, then drain the vault into the strategy so the redemption must route there.
        quote.mint(address(this), 1_000e6);
        quote.approve(address(vault), type(uint256).max);
        uint256 shares = vault.wrapQuote(1_000e6, address(this));

        uint256 toDrain = quote.balanceOf(address(vault));
        vault.approveStrategy(address(quote), toDrain);
        vm.prank(allocator);
        module.allocate(address(lendAdapter), toDrain);
        assertEq(quote.balanceOf(address(vault)), 0);
        uint256 allocated = 400e6 + toDrain;

        uint256 balanceBefore = quote.balanceOf(address(this));
        uint256 out = vault.unwrapQuote(shares, address(this), 0);

        assertApproxEqAbs(quote.balanceOf(address(this)) - balanceBefore, 1_000e6, 2e6);
        assertGt(out, 0);
        assertLt(lendAdapter.realAssets(), allocated, "redemption pulled from the strategy");

        // Settlement path: vault unwinds every adapter back to itself.
        vm.prank(address(vault));
        module.exitAll();
        assertEq(lendAdapter.realAssets(), 0);
    }
}

