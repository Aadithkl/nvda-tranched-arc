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
import { RegimeVault } from "../../src/vaults/RegimeVault.sol";
import { TrancheAccountant } from "../../src/vaults/TrancheAccountant.sol";
import { SeniorVault } from "../../src/vaults/SeniorVault.sol";
import { JuniorVault } from "../../src/vaults/JuniorVault.sol";
import { HookShareToken } from "../../src/core/HookShareToken.sol";
import { IHookSharePipe } from "../../src/interfaces/IHookSharePipe.sol";

contract RegimeVaultTest is Test {
    using PoolIdLibrary for PoolKey;

    IPoolManager internal manager;
    DemoRouter internal router;
    PoolGuardSimulator internal simulator;
    PoolGuardHook internal hook;
    RegimeVault internal vault;
    NVDAPriceOracle internal oracle;
    TestToken internal usdc;
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
        usdc = new TestToken("USD Coin", "mUSDC", 6);
        nvda = new TestToken("NVIDIA", "mNVDA", 18);

        oracle = new NVDAPriceOracle(8, address(this));
        oracle.setWriter(address(this), true);
        oracle.setMaxStaleness(1 hours);
        oracle.updatePrice(200e8, 2, uint32(block.timestamp), bytes32(0));

        address token0 = address(usdc) < address(nvda) ? address(usdc) : address(nvda);
        address token1 = token0 == address(usdc) ? address(nvda) : address(usdc);
        quoteIsToken0 = token0 == address(usdc);
        initialTick = quoteIsToken0 ? int24(196260) : int24(-196260);
        expiry = uint64(block.timestamp + 1 days);

        hook = _mineAndDeploy();
        key = PoolKey({
            currency0: Currency.wrap(token0),
            currency1: Currency.wrap(token1),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });

        vault = new RegimeVault(
            IPoolManager(address(manager)),
            hook,
            key,
            IERC20(address(usdc)),
            IERC20(address(nvda)),
            address(oracle),
            expiry,
            address(this)
        );

        hook.setVault(address(vault));
        hook.transferOwnership(address(vault));
        vault.acceptHookOwnership();
        vault.setKeeper(keeper);
        vault.setGuardParams(_defaultParams());

        usdc.mint(address(this), 2_000e6);
        usdc.approve(address(vault), type(uint256).max);
        vault.wrapUSDC(1_000e6, address(this));

        usdc.mint(address(vault), 40e6);
        nvda.mint(address(vault), 1e18);
        vault.fundHook(40e6, 1e18);
        vault.initializeHook(key, TickMath.getSqrtPriceAtTick(initialTick));
        _alignOracle();

        accountant = new TrancheAccountant(address(this));
        accountant.setHook(address(vault));
        vault.setAccountant(address(accountant));
        share = vault.shareToken();
        senior = new SeniorVault(
            IERC20(address(share)),
            usdc,
            nvda,
            IHookSharePipe(address(vault)),
            address(this),
            address(accountant),
            expiry
        );
        junior = new JuniorVault(
            IERC20(address(share)),
            usdc,
            nvda,
            IHookSharePipe(address(vault)),
            address(this),
            address(accountant),
            expiry
        );
        accountant.setVaults(address(senior), address(junior));

        usdc.approve(address(vault), type(uint256).max);
        usdc.approve(address(senior), type(uint256).max);
        usdc.approve(address(junior), type(uint256).max);
        usdc.approve(address(router), type(uint256).max);
        nvda.approve(address(router), type(uint256).max);
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

    // ------------------------------------------------------------------
    // Tranche flow
    // ------------------------------------------------------------------

    function test_depositUSDC_mintsTrancheShares() public {
        usdc.mint(address(this), 10_000e6);
        senior.depositUSDC(1_000e6, address(this));

        assertGt(senior.balanceOf(address(this)), 0);
        assertGt(accountant.seniorPrincipal(), 995e6);
        assertGt(vault.totalManagedAssets(), 995e6);
        assertEq(share.balanceOf(address(senior)), senior.totalAssets());
    }

    function test_wrapUnwrapUSDC() public {
        usdc.mint(address(this), 1_000e6);
        uint256 heldBefore = vault.shareToken().balanceOf(address(this));
        uint256 shares = vault.wrapUSDC(500e6, address(this));
        assertGt(shares, 0);
        assertEq(vault.shareToken().balanceOf(address(this)), heldBefore + shares);

        uint256 before = usdc.balanceOf(address(this));
        uint256 out = vault.unwrapUSDC(shares, address(this), 0);
        assertGe(out, 499e6);
        assertLe(out, 500e6);
        assertEq(usdc.balanceOf(address(this)) - before, out);
    }

    function test_unwrapEquity_paysAtOracleWithFee() public {
        vault.setConversionFeeBps(50);
        nvda.mint(address(vault), 10e18);
        usdc.mint(address(this), 1_000e6);
        uint256 shares = vault.wrapUSDC(100e6, address(this));

        uint256 mid8 = uint256(uint192(oracle.getPrice().mid));
        uint256 expected = vault.convertToUsdc(shares) * 1e20 / mid8;
        uint256 net = expected - (expected * 50) / 10_000;

        uint256 out = vault.unwrapEquity(shares, address(this), 0);
        assertGt(out, 0);
        assertApproxEqRel(out, net, 0.01e18);
    }

    function test_unwrapProportional() public {
        nvda.mint(address(vault), 5e18);
        usdc.mint(address(this), 1_000e6);
        uint256 shares = vault.wrapUSDC(400e6, address(this));

        uint256 supply = share.totalSupply();
        uint256 usdcUnits = usdc.balanceOf(address(vault)) + usdc.balanceOf(address(hook));
        uint256 equityUnits = nvda.balanceOf(address(vault)) + nvda.balanceOf(address(hook));
        uint256 expectedUsdc = usdcUnits * shares / supply;
        uint256 expectedEquity = equityUnits * shares / supply;

        (uint256 outUsdc, uint256 outEquity) = vault.unwrapProportional(shares, address(this), 0, 0);
        assertEq(outUsdc, expectedUsdc);
        assertEq(outEquity, expectedEquity);
    }

    // ------------------------------------------------------------------
    // Allocator
    // ------------------------------------------------------------------

    function test_allocator_fundPauseRecallRedeploy() public {
        usdc.mint(address(vault), 1_000e6);
        uint256 hookBefore = usdc.balanceOf(address(hook));
        vault.fundHook(500e6, 0);
        assertEq(usdc.balanceOf(address(hook)), hookBefore + 500e6);

        vault.setHookDeployEnabled(false);
        assertFalse(hook.deployEnabled());

        vm.prank(keeper);
        vault.recallFromHook();
        assertFalse(hook.guardPresent());
        assertGt(usdc.balanceOf(address(vault)), 400e6);

        vm.expectRevert();
        vault.deployGuard();

        vault.setHookDeployEnabled(true);
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
        usdc.mint(address(this), 10e6);
        vm.expectRevert(RegimeVault.TradingClosed.selector);
        vault.wrapUSDC(10e6, address(this));
    }

    // ------------------------------------------------------------------
    // Settlement
    // ------------------------------------------------------------------

    function test_finalizeSettlement_waterfall() public {
        usdc.mint(address(this), 10_000e6);
        senior.depositUSDC(1_000e6, address(this));
        junior.depositUSDC(200e6, address(this));

        vm.warp(expiry + 1);
        vault.finalizeSettlement();

        assertTrue(vault.settled());
        assertTrue(hook.exited());
        assertTrue(senior.matured());
        assertTrue(junior.matured());

        uint256 seniorBal = usdc.balanceOf(address(senior));
        uint256 juniorBal = usdc.balanceOf(address(junior));
        assertApproxEqAbs(seniorBal, 1_050e6, 2);
        assertGt(juniorBal, 0);
        assertEq(usdc.balanceOf(address(vault)), 0);

        uint256 seniorShares = senior.balanceOf(address(this));
        uint256 before = usdc.balanceOf(address(this));
        senior.redeemAtExpiry(seniorShares, address(this));
        assertGe(usdc.balanceOf(address(this)) - before, 1_049e6);
    }

    function test_finalizeSettlement_beforeExpiry_reverts() public {
        vm.expectRevert(RegimeVault.NotExpired.selector);
        vault.finalizeSettlement();
    }

    function test_finalizeSettlement_twice_reverts() public {
        usdc.mint(address(this), 2_000e6);
        senior.depositUSDC(1_000e6, address(this));
        junior.depositUSDC(200e6, address(this));
        vm.warp(expiry + 1);
        vault.finalizeSettlement();
        vm.expectRevert(RegimeVault.AlreadySettled.selector);
        vault.finalizeSettlement();
    }

    function test_finalizeSettlement_haircut_unfundedGuarantee() public {
        usdc.mint(address(this), 30_000e6);
        senior.depositUSDC(25_000e6, address(this));

        vm.warp(expiry + 1);
        vm.expectRevert(RegimeVault.SettlementNotReady.selector);
        vault.finalizeSettlement();

        vault.finalizeSettlementHaircut();
        assertTrue(vault.settled());
        assertGe(usdc.balanceOf(address(senior)), 25_000e6);
    }

    // ------------------------------------------------------------------
    // Rebalancing venue
    // ------------------------------------------------------------------

    function test_rebalanceSwap_equityToUsdc() public {
        PoolKey memory venueKey = PoolKey({
            currency0: key.currency0, currency1: key.currency1, fee: 3000, tickSpacing: 60, hooks: IHooks(address(0))
        });
        router.initializePool(venueKey, TickMath.getSqrtPriceAtTick(initialTick));
        usdc.mint(address(this), 100_000e6);
        nvda.mint(address(this), 100e18);
        router.addLiquidity(
            venueKey, initialTick - 6000, initialTick + 6000, 5e13, type(uint256).max, type(uint256).max, address(this)
        );

        vault.setRebalanceVenue(venueKey, address(router));
        nvda.mint(address(vault), 1e15);

        uint256 before = usdc.balanceOf(address(vault));
        vm.prank(keeper);
        vault.rebalanceSwap(true, 1e15, 2_975_000, block.timestamp + 60);
        assertGt(usdc.balanceOf(address(vault)) - before, 2_970_000);
    }
}

