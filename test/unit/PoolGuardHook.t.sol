// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { PoolManager } from "v4-core/src/PoolManager.sol";
import { IPoolManager } from "v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "v4-core/src/types/PoolId.sol";
import { Currency } from "v4-core/src/types/Currency.sol";
import { IHooks } from "v4-core/src/interfaces/IHooks.sol";
import { Hooks } from "v4-core/src/libraries/Hooks.sol";
import { LPFeeLibrary } from "v4-core/src/libraries/LPFeeLibrary.sol";
import { TickMath } from "v4-core/src/libraries/TickMath.sol";
import { CustomRevert } from "v4-core/src/libraries/CustomRevert.sol";
import { StateLibrary } from "v4-core/src/libraries/StateLibrary.sol";
import { SwapParams } from "v4-core/src/types/PoolOperation.sol";
import { HookMiner } from "v4-periphery/test/shared/HookMiner.sol";
import { DemoRouter } from "../../src/router/DemoRouter.sol";
import { TestToken } from "../../src/test-only/TestToken.sol";
import { NVDAPriceOracle } from "../../src/oracle/NVDAPriceOracle.sol";
import { PoolGuardHook } from "../../src/hook/PoolGuardHook.sol";
import { PoolGuardSimulator } from "../../src/hook/PoolGuardSimulator.sol";
import { GuardParams } from "../../src/hook/libraries/GuardParams.sol";

contract PoolGuardHookTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    PoolManager internal manager;
    DemoRouter internal router;
    PoolGuardHook internal hook;
    PoolGuardSimulator internal simulator;
    NVDAPriceOracle internal oracle;
    TestToken internal quote;
    TestToken internal nvda;

    PoolKey internal key;
    PoolId internal poolId;
    address internal vault = makeAddr("vault");
    bool internal equityIsToken1;
    int24 internal initialTick;

    uint128 internal constant GUARD_L = 5e11;
    uint128 internal constant BASE_L = 1e11;
    int24 internal constant GUARD_W = 600;
    int24 internal constant BASE_W = 6000;
    uint32 internal constant RECHECK_INTERVAL = 300;

    function setUp() public {
        manager = new PoolManager(address(this));
        router = new DemoRouter(IPoolManager(address(manager)));
        simulator = new PoolGuardSimulator();
        quote = new TestToken("USD Coin", "mUSDC", 6);
        nvda = new TestToken("NVIDIA", "mNVDA", 18);

        oracle = new NVDAPriceOracle(8, address(this));
        oracle.setWriter(address(this), true);
        oracle.setMaxStaleness(1 hours);
        _pushMid(200e8);

        address token0 = address(quote) < address(nvda) ? address(quote) : address(nvda);
        address token1 = token0 == address(quote) ? address(nvda) : address(quote);
        equityIsToken1 = token1 == address(nvda);
        initialTick = equityIsToken1 ? int24(196260) : int24(-196260);

        hook = _mineAndDeploy(address(oracle), address(nvda), vault);
        key = PoolKey({
            currency0: Currency.wrap(token0),
            currency1: Currency.wrap(token1),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        poolId = key.toId();

        hook.setGuardParams(_openParams());
        quote.mint(address(hook), 1_000_000e6);
        nvda.mint(address(hook), 10_000e18);

        hook.initializeBook(key, TickMath.getSqrtPriceAtTick(initialTick));
        _alignOracle();
        // Init band check runs on live-oracle inits: stage open, then arm the band.
        hook.setGuardParams(_defaultParams());

        quote.mint(address(this), 10_000_000e6);
        nvda.mint(address(this), 10_000e18);
        quote.approve(address(router), type(uint256).max);
        nvda.approve(address(router), type(uint256).max);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _defaultParams() internal pure returns (GuardParams.Params memory) {
        return GuardParams.Params({
            guardTickWidth: GUARD_W,
            baseTickWidth: BASE_W,
            guardLiquidity: GUARD_L,
            baseLiquidity: BASE_L,
            minEvBps: 0,
            recheckMaxDeviationBps: 50,
            recheckInterval: RECHECK_INTERVAL,
            maxPriceAge: 300,
            allowedSessionsMask: 0
        });
    }

    /// @notice Band-open staging params: `initializeBook` enforces the deviation band
    ///         on live-oracle inits, so fixtures init open then arm the band post-align.
    function _openParams() internal pure returns (GuardParams.Params memory) {
        GuardParams.Params memory p = _defaultParams();
        p.recheckMaxDeviationBps = 0;
        return p;
    }

    function _mineAndDeploy(address oracle_, address equity_, address vault_)
        internal
        returns (PoolGuardHook deployed)
    {
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
                | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
        );
        bytes memory args =
            abi.encode(IPoolManager(address(manager)), simulator, oracle_, equity_, vault_, address(this));
        (address expected, bytes32 salt) = HookMiner.find(address(this), flags, type(PoolGuardHook).creationCode, args);
        deployed = new PoolGuardHook{ salt: salt }(
            IPoolManager(address(manager)), simulator, oracle_, equity_, vault_, address(this)
        );
        assertEq(address(deployed), expected);
    }

    function _pushMid(uint256 mid8) internal {
        oracle.updatePrice(int192(int256(mid8)), 2, uint32(block.timestamp), bytes32(0));
    }

    function _alignOracle() internal {
        _pushMid(hook.poolPrice1e18() / 1e10);
    }

    /// @dev Buying equity always pays QUOTE: output is the equity token.
    function _buyEquityZeroForOne() internal view returns (bool) {
        return equityIsToken1;
    }

    function _swapParams(bool zeroForOne, uint256 usdcIn) internal pure returns (SwapParams memory) {
        return SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: -int256(usdcIn),
            sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        });
    }

    function _swap(bool zeroForOne, uint256 usdcIn) internal {
        router.swapExactIn(key, zeroForOne, usdcIn, 0, address(this));
    }

    function _wrapped(bytes4 hookFn, bytes memory reason) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            address(hook),
            hookFn,
            reason,
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    function _guardPresent() internal view returns (bool present) {
        present = hook.guardPresent();
    }

    // ------------------------------------------------------------------
    // Book / permissions
    // ------------------------------------------------------------------

    function test_permissions_and_book() public view {
        Hooks.Permissions memory p = hook.getHookPermissions();
        assertTrue(p.beforeInitialize);
        assertTrue(p.beforeSwap);
        assertTrue(p.beforeAddLiquidity);
        assertTrue(p.beforeRemoveLiquidity);
        assertFalse(p.afterSwap);
        assertFalse(p.beforeSwapReturnDelta);
        assertFalse(p.afterSwapReturnDelta);

        assertTrue(hook.poolInitialized());
        assertTrue(_guardPresent());
        assertEq(hook.effectiveLiquidity(), uint128(GUARD_L + BASE_L));
        (int24 bLo, int24 bHi, uint128 bL) = hook.basePosition();
        assertGt(bHi, bLo);
        assertEq(bL, BASE_L);
    }

    function test_initializeBook_twice_reverts() public {
        vm.expectRevert(PoolGuardHook.BookAlreadyInitialized.selector);
        hook.initializeBook(key, TickMath.getSqrtPriceAtTick(initialTick));
    }

    function test_initializeBook_dynamicFee_reverts() public {
        PoolGuardHook fresh = _mineAndDeploy(address(oracle), address(nvda), vault);
        fresh.setGuardParams(_defaultParams());
        quote.mint(address(fresh), 1_000_000e6);
        nvda.mint(address(fresh), 10_000e18);
        PoolKey memory dynKey = key;
        dynKey.fee = LPFeeLibrary.DYNAMIC_FEE_FLAG;
        dynKey.hooks = IHooks(address(fresh));
        vm.expectRevert(PoolGuardHook.DynamicFeeForbidden.selector);
        fresh.initializeBook(dynKey, TickMath.getSqrtPriceAtTick(initialTick));
    }

    function test_initializeBook_offMarket_reverts() public {
        PoolGuardHook fresh = _mineAndDeploy(address(oracle), address(nvda), vault);
        fresh.setGuardParams(_defaultParams());
        quote.mint(address(fresh), 1_000_000e6);
        nvda.mint(address(fresh), 10_000e18);
        // Oracle is live and 3x off the init tick: deviation is 2/3 = 6666bps.
        _pushMid(hook.poolPrice1e18() / 1e10 * 3);
        PoolKey memory freshKey = key;
        freshKey.hooks = IHooks(address(fresh));
        vm.expectRevert(abi.encodeWithSelector(PoolGuardHook.InitPriceOffMarket.selector, 6666, 50));
        fresh.initializeBook(freshKey, TickMath.getSqrtPriceAtTick(initialTick));
    }

    function test_initializeBook_strayCaller_reverts() public {
        PoolKey memory strayKey = key;
        strayKey.fee = 500;
        strayKey.tickSpacing = 10;
        vm.expectRevert(
            _wrapped(
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(PoolGuardHook.UnauthorizedInitialization.selector, address(router))
            )
        );
        router.initializePool(strayKey, TickMath.getSqrtPriceAtTick(initialTick));
    }

    // ------------------------------------------------------------------
    // Private LP
    // ------------------------------------------------------------------

    function test_publicLp_blocked() public {
        // The pool is book-private: external LPs cannot add dust ticks that dilute the
        // guard or grief the EV simulator.
        vm.expectRevert();
        router.addLiquidity(
            key,
            initialTick - 6000,
            initialTick + 6000,
            int256(uint256(1e12)),
            type(uint256).max,
            type(uint256).max,
            address(this)
        );
        assertEq(hook.effectiveLiquidity(), uint128(GUARD_L + BASE_L));
        assertTrue(_guardPresent());
    }

    // ------------------------------------------------------------------
    // IL guard
    // ------------------------------------------------------------------

    function test_evPull_onToxicSwap() public {
        _pushMid(hook.poolPrice1e18() / 1e10 * 3);

        (bool ok, int256 ev, uint256 notional,,) = hook.simulateEv(_swapParams(_buyEquityZeroForOne(), 1e6));
        assertTrue(ok);
        assertGt(notional, 0);
        assertLt(ev, int256(0));

        _swap(_buyEquityZeroForOne(), 1e6);

        assertFalse(_guardPresent());
        assertEq(hook.effectiveLiquidity(), uint128(BASE_L));
    }

    function test_lazyRedeploy_onNextEvPlusSwap() public {
        _pushMid(hook.poolPrice1e18() / 1e10 * 3);
        _swap(_buyEquityZeroForOne(), 1e6);
        assertFalse(_guardPresent());

        _alignOracle();
        (bool ok, int256 ev, uint256 notional,,) = hook.simulateEv(_swapParams(_buyEquityZeroForOne(), 1e6));
        assertTrue(ok);
        assertGt(notional, 0);
        assertGe(ev, int256(0));

        _swap(_buyEquityZeroForOne(), 1e6);
        assertTrue(_guardPresent());
    }

    function test_lazyRedeploy_unwindsClaimsWithZeroIdle() public {
        // Remove the fixture's surplus: the hook now holds only deployed positions.
        (uint256 idleQuote, uint256 idleEquity) = hook.inventory();
        hook.withdrawInventory(idleQuote, idleEquity);

        // Toxic flow pulls the guard; proceeds are minted as ERC-6909 claims.
        _pushMid(hook.poolPrice1e18() / 1e10 * 3);
        _swap(_buyEquityZeroForOne(), 1e4);
        assertFalse(_guardPresent());
        assertGt(hook.claims(address(quote)) + hook.claims(address(nvda)), 0, "claims hold principal");

        // A tiny EV+ swap must redeem the claims and re-arm without a manual unwind.
        // Top up just enough to cover the small price move; the tell is that the
        // claims are consumed, not left sitting behind idle inventory.
        quote.mint(address(hook), 1e6);
        nvda.mint(address(hook), 1e18);
        _alignOracle();
        _swap(_buyEquityZeroForOne(), 1e4);
        assertTrue(_guardPresent(), "guard re-armed from claims");
        assertEq(hook.claims(address(quote)), 0, "quote claims consumed");
        assertEq(hook.claims(address(nvda)), 0, "equity claims consumed");
    }

    function test_standby_stillPullsOnToxicFlow() public {
        hook.setDeployEnabled(false);
        assertTrue(_guardPresent());

        _pushMid(hook.poolPrice1e18() / 1e10 * 3);
        _swap(_buyEquityZeroForOne(), 1e6);
        assertFalse(_guardPresent());
    }

    function test_claims_mintedOnInSwapPull_andUnwound() public {
        _pushMid(hook.poolPrice1e18() / 1e10 * 3);
        _swap(_buyEquityZeroForOne(), 1e6);

        uint256 claims0 = manager.balanceOf(address(hook), key.currency0.toId());
        uint256 claims1 = manager.balanceOf(address(hook), key.currency1.toId());
        assertGt(claims0 + claims1, 0);

        hook.unwindClaims();
        assertLt(manager.balanceOf(address(hook), key.currency0.toId()), claims0 + 1);
        assertEq(manager.balanceOf(address(hook), key.currency1.toId()), 0);
    }

    // ------------------------------------------------------------------
    // Recheck
    // ------------------------------------------------------------------

    function test_recheck_respectsIntervalAndDeviation() public {
        _pushMid(hook.poolPrice1e18() / 1e10 * 3);
        _swap(_buyEquityZeroForOne(), 1e6);
        assertFalse(_guardPresent());

        vm.expectRevert(PoolGuardHook.RecheckNotDue.selector);
        hook.recheckGuard();

        vm.warp(block.timestamp + RECHECK_INTERVAL);
        vm.expectEmit(false, false, false, false, address(hook));
        emit PoolGuardHook.RecheckSkipped(0);
        hook.recheckGuard();
        assertFalse(_guardPresent());

        vm.warp(block.timestamp + RECHECK_INTERVAL);
        _alignOracle();
        assertTrue(hook.recheckDue());
        hook.recheckGuard();
        assertTrue(_guardPresent());
    }

    // ------------------------------------------------------------------
    // Capital movement
    // ------------------------------------------------------------------

    function test_recallToVault_keepsBase() public {
        hook.recallToVault();

        assertFalse(_guardPresent());
        assertEq(hook.effectiveLiquidity(), uint128(BASE_L));
        (uint256 quoteIdle, uint256 equityIdle) = hook.inventory();
        assertEq(quoteIdle, 0);
        assertEq(equityIdle, 0);
        assertGt(quote.balanceOf(vault), 0);
        assertGt(nvda.balanceOf(vault), 0);
    }

    function test_pullAll_and_rearm() public {
        hook.pullAll();
        assertTrue(hook.exited());
        assertEq(hook.effectiveLiquidity(), 0);

        quote.mint(address(hook), 1_000_000e6);
        nvda.mint(address(hook), 10_000e18);
        hook.rearm();

        assertFalse(hook.exited());
        assertTrue(_guardPresent());
        assertEq(hook.effectiveLiquidity(), uint128(GUARD_L + BASE_L));
    }

    function test_recenter_guard() public {
        hook.recenterGuard();
        assertTrue(_guardPresent());
        assertEq(hook.effectiveLiquidity(), uint128(GUARD_L + BASE_L));

        hook.setDeployEnabled(false);
        hook.recenterGuard();
        assertFalse(_guardPresent());
        assertEq(hook.effectiveLiquidity(), uint128(BASE_L));

        hook.setDeployEnabled(true);
        hook.deployGuard();
        assertTrue(_guardPresent());
        assertEq(hook.effectiveLiquidity(), uint128(GUARD_L + BASE_L));
    }

    // ------------------------------------------------------------------
    // Oracle guard
    // ------------------------------------------------------------------

    function test_swap_reverts_whenOracleStale() public {
        uint256 updatedAt = oracle.getPrice().updatedAt;
        vm.warp(block.timestamp + 301);
        vm.expectRevert(
            _wrapped(IHooks.beforeSwap.selector, abi.encodeWithSelector(PoolGuardHook.OracleStale.selector, updatedAt))
        );
        _swap(_buyEquityZeroForOne(), 1e6);
    }

    function test_swap_reverts_whenOracleInvalid() public {
        oracle.updatePrice(200e8, 0, uint32(block.timestamp), bytes32(0));
        vm.expectRevert(
            _wrapped(IHooks.beforeSwap.selector, abi.encodeWithSelector(PoolGuardHook.OracleInvalid.selector))
        );
        _swap(_buyEquityZeroForOne(), 1e6);
    }

    function test_swap_sessionMask_enforced() public {
        GuardParams.Params memory p = _defaultParams();
        p.allowedSessionsMask = 1 << 2;
        hook.setGuardParams(p);

        _pushMid(200e8);
        oracle.updatePrice(200e8, 4, uint32(block.timestamp), bytes32(0));
        vm.expectRevert(
            _wrapped(IHooks.beforeSwap.selector, abi.encodeWithSelector(PoolGuardHook.SessionNotAllowed.selector, 3))
        );
        _swap(_buyEquityZeroForOne(), 1e6);
    }

    // ------------------------------------------------------------------
    // Invariants
    // ------------------------------------------------------------------

    function test_staticFee_afterAllFlows() public {
        _pushMid(hook.poolPrice1e18() / 1e10 * 3);
        _swap(_buyEquityZeroForOne(), 1e6);
        _alignOracle();
        _swap(_buyEquityZeroForOne(), 1e6);
        hook.unwindClaims();
        hook.recallToVault();

        (uint160 sqrtPrice,, uint24 protocolFee, uint24 lpFee) = IPoolManager(address(manager)).getSlot0(poolId);
        assertGt(sqrtPrice, 0);
        assertEq(protocolFee, 0);
        assertEq(lpFee, 3000);
    }

    function test_guard_liquidityNeverExceedsConfigured() public {
        assertEq(hook.effectiveLiquidity(), uint128(GUARD_L + BASE_L));
        _pushMid(hook.poolPrice1e18() / 1e10 * 3);
        _swap(_buyEquityZeroForOne(), 1e6);
        assertLe(hook.effectiveLiquidity(), uint128(GUARD_L + BASE_L));
        assertGe(hook.effectiveLiquidity(), uint128(BASE_L));
    }
}
