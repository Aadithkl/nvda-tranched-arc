// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";
import { IPoolManager } from "v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "v4-core/src/types/PoolId.sol";
import { Currency } from "v4-core/src/types/Currency.sol";
import { IHooks } from "v4-core/src/interfaces/IHooks.sol";
import { Hooks } from "v4-core/src/libraries/Hooks.sol";
import { TickMath } from "v4-core/src/libraries/TickMath.sol";
import { HookMiner } from "v4-periphery/test/shared/HookMiner.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { DemoRouter } from "../../src/router/DemoRouter.sol";
import { TestToken } from "../../src/test-only/TestToken.sol";
import { NVDAPriceOracle } from "../../src/oracle/NVDAPriceOracle.sol";
import { PoolGuardHook } from "../../src/hook/PoolGuardHook.sol";
import { PoolGuardSimulator } from "../../src/hook/PoolGuardSimulator.sol";
import { GuardParams } from "../../src/hook/libraries/GuardParams.sol";
import { LedgerVault } from "../../src/vaults/LedgerVault.sol";
import { VaultStrategyController } from "../../src/strategy/VaultStrategyController.sol";
import { TrancheAccountant } from "../../src/vaults/TrancheAccountant.sol";
import { SeniorVault } from "../../src/vaults/SeniorVault.sol";
import { JuniorVault } from "../../src/vaults/JuniorVault.sol";
import { HookShareToken } from "../../src/core/HookShareToken.sol";
import { IHookSharePipe } from "../../src/interfaces/IHookSharePipe.sol";

contract LedgerVaultTest is Test {
    using PoolIdLibrary for PoolKey;

    IPoolManager internal manager;
    DemoRouter internal router;
    PoolGuardSimulator internal simulator;
    PoolGuardHook internal hook;
    LedgerVault internal vault;
    NVDAPriceOracle internal oracle;
    TestToken internal quote;
    TestToken internal nvda;

    TrancheAccountant internal accountant;
    SeniorVault internal senior;
    JuniorVault internal junior;
    HookShareToken internal share;

    PoolKey internal key;
    address internal keeper = makeAddr("keeper");
    bool internal quoteIsToken0;
    int24 internal initialTick;
    uint64 internal expiry;

    uint128 internal constant GUARD_L = 5e11;
    uint128 internal constant BASE_L = 1e11;

    function setUp() public {
        manager = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        router = new DemoRouter(manager);
        simulator = new PoolGuardSimulator();
        quote = new TestToken("USD Coin", "mUSDC", 6);
        nvda = new TestToken("NVIDIA", "mNVDA", 18);

        oracle = new NVDAPriceOracle(8, address(this));
        oracle.setWriter(address(this), true);
        oracle.setMaxStaleness(1 hours);
        oracle.updatePrice(200e8, 2, uint32(block.timestamp), bytes32(0));

        address token0 = address(quote) < address(nvda) ? address(quote) : address(nvda);
        address token1 = token0 == address(quote) ? address(nvda) : address(quote);
        quoteIsToken0 = token0 == address(quote);
        initialTick = quoteIsToken0 ? int24(196260) : int24(-196260);
        // Long book life: the 24h knob timelock must fit comfortably before expiry.
        expiry = uint64(block.timestamp + 30 days);

        hook = _mineAndDeploy();
        key = PoolKey({
            currency0: Currency.wrap(token0),
            currency1: Currency.wrap(token1),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });

        vault = new LedgerVault(
            IPoolManager(address(manager)),
            hook,
            key,
            IERC20(address(quote)),
            IERC20(address(nvda)),
            address(oracle),
            expiry,
            address(this)
        );

        hook.setVault(address(vault));
        hook.transferOwnership(address(vault));
        vault.acceptHookOwnership();
        vault.setGuardParams(_defaultParams());
        vault.setKeeper(keeper);

        accountant = new TrancheAccountant(address(this));
        accountant.setHook(address(vault));
        vault.setAccountant(address(accountant));
        share = vault.shareToken();
        senior = new SeniorVault(
            IERC20(address(share)),
            quote,
            nvda,
            IHookSharePipe(address(vault)),
            address(this),
            address(accountant),
            expiry
        );
        junior = new JuniorVault(
            IERC20(address(share)),
            quote,
            nvda,
            IHookSharePipe(address(vault)),
            address(this),
            address(accountant),
            expiry
        );
        accountant.setVaults(address(senior), address(junior));

        _wrapAsSenior(1_000e6, address(this));
        quote.mint(address(this), 2_000e6);

        quote.mint(address(vault), 40e6);
        nvda.mint(address(vault), 1e18);
        vm.prank(keeper);
        vault.fundHook(40e6, 1e18);
        vault.initializeHook(key, TickMath.getSqrtPriceAtTick(initialTick));
        _alignOracle();

        quote.approve(address(vault), type(uint256).max);
        quote.approve(address(senior), type(uint256).max);
        quote.approve(address(junior), type(uint256).max);
        quote.approve(address(router), type(uint256).max);
        nvda.approve(address(router), type(uint256).max);
    }

    /// @notice Wrap doors admit registered tranches only (D2) — seed through senior.
    function _wrapAsSenior(uint256 amount, address receiver) internal returns (uint256 shares) {
        quote.mint(address(senior), amount);
        vm.startPrank(address(senior));
        quote.approve(address(vault), amount);
        shares = vault.wrapQuote(amount, receiver);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _defaultParams() internal pure returns (GuardParams.Params memory) {
        return GuardParams.Params({
            guardTickWidth: 600,
            baseTickWidth: 6000,
            guardLiquidity: GUARD_L,
            baseLiquidity: BASE_L,
            minEvBps: 0,
            recheckMaxDeviationBps: 50,
            recheckInterval: 300,
            maxPriceAge: 300,
            allowedSessionsMask: 0
        });
    }

    function _mineAndDeploy() internal returns (PoolGuardHook deployed) {
        uint160 flags = uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG);
        bytes memory args = abi.encode(
            IPoolManager(address(manager)), simulator, address(oracle), address(nvda), address(0), address(this)
        );
        (address expected, bytes32 salt) = HookMiner.find(address(this), flags, type(PoolGuardHook).creationCode, args);
        deployed = new PoolGuardHook{ salt: salt }(
            IPoolManager(address(manager)), simulator, address(oracle), address(nvda), address(0), address(this)
        );
        assertEq(address(deployed), expected);
    }

    function _alignOracle() internal {
        oracle.updatePrice(int192(int256(hook.poolPrice1e18() / 1e10)), 2, uint32(block.timestamp), bytes32(0));
    }

    /// @notice Runs a knob through the 24h timelock queue, then re-stamps the oracle
    ///         (warping past staleness would otherwise freeze price reads).
    function _executeKnob(VaultStrategyController controller, bytes32 key) internal {
        uint256 lastMid = uint256(uint192(oracle.getPrice().mid));
        (, uint64 at) = controller.pendingKnobs(key);
        vm.expectRevert(abi.encodeWithSelector(VaultStrategyController.TimelockActive.selector, at));
        controller.executeKnob(key);
        vm.warp(at);
        controller.executeKnob(key);
        oracle.updatePrice(int192(int256(lastMid)), 2, uint32(block.timestamp), bytes32(0));
    }

    // ------------------------------------------------------------------
    // Tranche flow
    // ------------------------------------------------------------------

    function test_depositQuote_mintsTrancheShares() public {
        quote.mint(address(this), 10_000e6);
        junior.depositQuote(400e6, address(this));
        senior.depositQuote(1_000e6, address(this));

        assertGt(senior.balanceOf(address(this)), 0);
        assertGt(accountant.seniorPrincipal(), 995e6);
        assertGt(vault.totalManagedAssets(), 995e6);
        assertEq(share.balanceOf(address(senior)), senior.totalAssets());
    }

    function test_wrapUnwrapQuote() public {
        uint256 heldBefore = vault.shareToken().balanceOf(address(this));
        uint256 shares = _wrapAsSenior(500e6, address(this));
        assertGt(shares, 0);
        assertEq(vault.shareToken().balanceOf(address(this)), heldBefore + shares);

        uint256 before = quote.balanceOf(address(this));
        uint256 out = vault.unwrapQuote(shares, address(this), 0);
        assertGe(out, 499e6);
        assertLe(out, 500e6);
        assertEq(quote.balanceOf(address(this)) - before, out);
    }

    function test_unwrapEquity_paysAtOracleWithFee() public {
        vault.setConversionFeeBps(50);
        nvda.mint(address(vault), 10e18);
        uint256 shares = _wrapAsSenior(100e6, address(this));

        uint256 mid8 = uint256(uint192(oracle.getPrice().mid));
        uint256 expected = vault.convertToQuote(shares) * 1e20 / mid8;
        uint256 net = expected - (expected * 50) / 10_000;

        uint256 out = vault.unwrapEquity(shares, address(this), 0);
        assertGt(out, 0);
        assertApproxEqRel(out, net, 0.01e18);
    }

    function test_unwrapProportional() public {
        nvda.mint(address(vault), 5e18);
        uint256 shares = _wrapAsSenior(400e6, address(this));

        uint256 supply = share.totalSupply();
        uint256 quoteUnits = quote.balanceOf(address(vault)) + quote.balanceOf(address(hook));
        uint256 equityUnits = nvda.balanceOf(address(vault)) + nvda.balanceOf(address(hook));
        uint256 expectedUsdc = quoteUnits * shares / supply;
        uint256 expectedEquity = equityUnits * shares / supply;

        (uint256 outUsdc, uint256 outEquity) = vault.unwrapProportional(shares, address(this), 0, 0);
        assertEq(outUsdc, expectedUsdc);
        assertEq(outEquity, expectedEquity);
    }

    // ------------------------------------------------------------------
    // Allocator
    // ------------------------------------------------------------------

    function test_allocator_fundPauseRecallRedeploy() public {
        quote.mint(address(vault), 1_000e6);
        uint256 hookBefore = quote.balanceOf(address(hook));
        vm.prank(keeper);
        vault.fundHook(500e6, 0);
        assertEq(quote.balanceOf(address(hook)), hookBefore + 500e6);

        vm.prank(keeper);
        vault.setHookDeployEnabled(false);
        assertFalse(hook.deployEnabled());

        vm.prank(keeper);
        vault.recallFromHook();
        assertFalse(hook.guardPresent());
        assertGt(quote.balanceOf(address(vault)), 400e6);

        vm.expectRevert();
        vault.deployGuard();

        vm.prank(keeper);
        vault.setHookDeployEnabled(true);
        vm.prank(keeper);
        vault.fundHook(500e6, 5e17);
        vm.prank(keeper);
        vault.deployGuard();
        assertTrue(hook.guardPresent());
    }

    function test_recenter_viaVault_keeper() public {
        vm.prank(keeper);
        vault.recenterGuard();
        assertTrue(hook.guardPresent());
    }

    function test_expiry_blocksWrap() public {
        vm.warp(expiry + 1);
        quote.mint(address(senior), 10e6);
        vm.startPrank(address(senior));
        quote.approve(address(vault), 10e6);
        vm.expectRevert(LedgerVault.TradingClosed.selector);
        vault.wrapQuote(10e6, address(this));
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // Settlement
    // ------------------------------------------------------------------

    function test_finalizeSettlement_waterfall() public {
        quote.mint(address(this), 10_000e6);
        junior.depositQuote(400e6, address(this));
        senior.depositQuote(1_000e6, address(this));

        vm.warp(expiry + 1);
        vault.finalizeSettlement();

        assertTrue(vault.settled());
        assertTrue(hook.exited());
        assertTrue(senior.matured());
        assertTrue(junior.matured());

        uint256 seniorBal = quote.balanceOf(address(senior));
        uint256 juniorBal = quote.balanceOf(address(junior));
        assertApproxEqAbs(seniorBal, 1_050e6, 2);
        assertGt(juniorBal, 0);
        assertEq(quote.balanceOf(address(vault)), 0);

        uint256 seniorShares = senior.balanceOf(address(this));
        uint256 before = quote.balanceOf(address(this));
        senior.redeemAtExpiry(seniorShares, address(this));
        assertGe(quote.balanceOf(address(this)) - before, 1_049e6);
    }

    function test_finalizeSettlement_beforeExpiry_reverts() public {
        vm.expectRevert(LedgerVault.NotExpired.selector);
        vault.finalizeSettlement();
    }

    function test_finalizeSettlement_twice_reverts() public {
        quote.mint(address(this), 2_000e6);
        junior.depositQuote(400e6, address(this));
        senior.depositQuote(1_000e6, address(this));
        vm.warp(expiry + 1);
        vault.finalizeSettlement();
        vm.expectRevert(LedgerVault.AlreadySettled.selector);
        vault.finalizeSettlement();
    }

    function test_finalizeSettlement_haircut_unfundedGuarantee() public {
        // Floor-compliant entry (junior-led, >=25% junior): underfunding at entry is now
        // structurally impossible (floor 25% >> escrow 5%), so manufacture real losses —
        // swap quote to equity through the controller, then crash equity value.
        PoolKey memory venueKey = PoolKey({
            currency0: key.currency0, currency1: key.currency1, fee: 3000, tickSpacing: 60, hooks: IHooks(address(0))
        });
        router.initializePool(venueKey, TickMath.getSqrtPriceAtTick(initialTick));
        quote.mint(address(this), 50_000_000e6);
        nvda.mint(address(this), 500_000e18);
        router.addLiquidity(
            venueKey, initialTick - 600, initialTick + 600, 5e17, type(uint256).max, type(uint256).max, address(this)
        );

        VaultStrategyController controller = new VaultStrategyController(address(this));
        controller.setVault(address(vault));
        controller.setAgent(address(this), true);
        vault.setKeeper(address(controller));
        _executeKnob(controller, controller.proposeRebalanceVenue(venueKey, address(router)));

        // Floor-compliant book against the seeded 1000e6 idle: junior-led.
        junior.depositQuote(400e6, address(this));
        senior.depositQuote(1_000e6, address(this));

        // Destroy quote value TWAP-style: many small swaps into equity (each inside the
        // 1% oracle floor), then crash equity. Must clear ~1400e6 of quote leg.
        for (uint256 i = 0; i < 14; ++i) {
            uint256 chunkOut = vault.quoteToEquity(100e6);
            controller.submitRebalance(false, 100e6, chunkOut * 99 / 100, block.timestamp + 60);
        }
        oracle.updatePrice(1, 2, uint32(block.timestamp), bytes32(0)); // equity value -> ~0

        vm.warp(expiry + 2 days);
        vm.expectRevert(LedgerVault.SettlementNotReady.selector);
        vault.finalizeSettlement();

        vault.finalizeSettlementHaircut();
        assertTrue(vault.settled());
        uint256 seniorBal = quote.balanceOf(address(senior));
        assertGt(seniorBal, 0, "senior salvages the quote remainder");
        assertLt(seniorBal, 1_050e6, "haircut: guarantee not covered");
    }

    // ------------------------------------------------------------------
    // Rebalancing venue
    // ------------------------------------------------------------------

    function test_rebalanceSwap_equityToQuote() public {
        PoolKey memory venueKey = PoolKey({
            currency0: key.currency0, currency1: key.currency1, fee: 3000, tickSpacing: 60, hooks: IHooks(address(0))
        });
        router.initializePool(venueKey, TickMath.getSqrtPriceAtTick(initialTick));
        quote.mint(address(this), 100_000e6);
        nvda.mint(address(this), 100e18);
        router.addLiquidity(
            venueKey, initialTick - 6000, initialTick + 6000, 5e13, type(uint256).max, type(uint256).max, address(this)
        );

        // Swap now lives in the bottom-layer controller; the vault only pulls funds for it.
        VaultStrategyController controller = new VaultStrategyController(address(this));
        controller.setVault(address(vault));
        controller.setAgent(address(this), true);
        vault.setKeeper(address(controller));
        _executeKnob(controller, controller.proposeRebalanceVenue(venueKey, address(router)));
        nvda.mint(address(vault), 1e15);

        uint256 before = quote.balanceOf(address(vault));
        controller.submitRebalance(true, 1e15, 2_975_000, block.timestamp + 60);
        assertGt(quote.balanceOf(address(vault)) - before, 2_970_000);
    }
}

