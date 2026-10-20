// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";
import { IPoolManager } from "v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "v4-core/src/types/PoolKey.sol";
import { PoolIdLibrary } from "v4-core/src/types/PoolId.sol";
import { Currency } from "v4-core/src/types/Currency.sol";
import { IHooks } from "v4-core/src/interfaces/IHooks.sol";
import { Hooks } from "v4-core/src/libraries/Hooks.sol";
import { StateLibrary } from "v4-core/src/libraries/StateLibrary.sol";
import { TickMath } from "v4-core/src/libraries/TickMath.sol";
import { SwapParams } from "v4-core/src/types/PoolOperation.sol";
import { HookMiner } from "v4-periphery/test/shared/HookMiner.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { DemoRouter } from "../../src/router/DemoRouter.sol";
import { TestToken } from "../../src/test-only/TestToken.sol";
import { NVDAPriceOracle } from "../../src/oracle/NVDAPriceOracle.sol";
import { PoolGuardHook } from "../../src/hook/PoolGuardHook.sol";
import { PoolGuardSimulator } from "../../src/hook/PoolGuardSimulator.sol";
import { GuardParams } from "../../src/hook/libraries/GuardParams.sol";
import { LedgerVault } from "../../src/vaults/LedgerVault.sol";
import { TrancheAccountant } from "../../src/vaults/TrancheAccountant.sol";
import { SeniorVault } from "../../src/vaults/SeniorVault.sol";
import { JuniorVault } from "../../src/vaults/JuniorVault.sol";
import { IHookSharePipe } from "../../src/interfaces/IHookSharePipe.sol";

/// @notice Full static-book lifecycle: deposits -> EV+ swap keeps the guard -> toxic swap pulls it
///         mid-swap (thin) -> lazy redeploy -> permissionless recheck -> allocator pause/recall/
///         refund -> expiry settlement -> terminal redemptions. Also asserts simulate-vs-execution
///         equivalence of the IL-guard decision.
contract StaticBookE2ETest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

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
        expiry = uint64(block.timestamp + 1 days);

        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
                | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
        );
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
            manager, hook, key, IERC20(address(quote)), IERC20(address(nvda)), address(oracle), expiry, address(this)
        );
        hook.setVault(address(vault));
        hook.transferOwnership(address(vault));
        vault.acceptHookOwnership();
        vault.setGuardParams(_openParams());
        vault.setKeeper(keeper);

        accountant = new TrancheAccountant(address(this));
        accountant.setHook(address(vault));
        vault.setAccountant(address(accountant));
        senior = new SeniorVault(
            IERC20(address(vault.shareToken())),
            quote,
            nvda,
            IHookSharePipe(address(vault)),
            address(this),
            address(accountant),
            expiry
        );
        junior = new JuniorVault(
            IERC20(address(vault.shareToken())),
            quote,
            nvda,
            IHookSharePipe(address(vault)),
            address(this),
            address(accountant),
            expiry
        );
        accountant.setVaults(address(senior), address(junior));

        // Bootstrap at zero NAV, then fund the hook from the vault.
        _wrapAsSenior(1_000e6, address(this));
        quote.mint(address(this), 2_000e6);
        quote.mint(address(vault), 40e6);
        nvda.mint(address(vault), 1e18);
        vm.prank(keeper);
        vault.fundHook(40e6, 1e18);
        vault.initializeHook(key, TickMath.getSqrtPriceAtTick(initialTick));
        _alignOracle();
        // Arm the deviation band now that init price and oracle agree.
        vm.prank(keeper);
        vault.setGuardParams(_defaultParams());

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

    /// @notice Band-open staging params: `initializeBook` enforces the deviation band
    ///         on live-oracle inits, so fixtures init open then arm the band post-align.
    function _openParams() internal pure returns (GuardParams.Params memory) {
        GuardParams.Params memory p = _defaultParams();
        p.recheckMaxDeviationBps = 0;
        return p;
    }

    function _alignOracle() internal {
        oracle.updatePrice(int192(int256(hook.poolPrice1e18() / 1e10)), 2, uint32(block.timestamp), bytes32(0));
    }

    function _setOracleMultiple(uint256 mult) internal {
        oracle.updatePrice(int192(int256(hook.poolPrice1e18() / 1e10 * mult)), 2, uint32(block.timestamp), bytes32(0));
    }

    /// @dev Buying equity always pays QUOTE: zeroForOne == (QUOTE is token0).
    function _buyEquitySwap(uint256 usdcIn) internal returns (SwapParams memory params) {
        params = SwapParams({
            zeroForOne: quoteIsToken0,
            amountSpecified: -int256(usdcIn),
            sqrtPriceLimitX96: quoteIsToken0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        });
        router.swapExactIn(key, quoteIsToken0, usdcIn, 0, address(this));
    }

    function test_fullBookLifecycle() public {
        // 1. Tranche deposits (junior-led, floor-compliant)
        quote.mint(address(this), 10_000e6);
        junior.depositQuote(400e6, address(this));
        senior.depositQuote(1_000e6, address(this));
        assertTrue(hook.guardPresent());
        assertEq(hook.effectiveLiquidity(), uint128(GUARD_L + BASE_L));

        quote.mint(address(this), 100e6);

        // 2. EV+ swap: simulate then execute; the guard must stay (equivalence)
        (bool ok, int256 ev, uint256 notional,,) = hook.simulateEv(
            SwapParams({
                zeroForOne: quoteIsToken0,
                amountSpecified: -int256(1e4),
                sqrtPriceLimitX96: quoteIsToken0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            })
        );
        assertTrue(ok && ev >= 0 && notional > 0);
        _buyEquitySwap(1e4);
        assertTrue(hook.guardPresent(), "guard stays on EV+ flow");

        // 3. Toxic swap: simulate shows negative EV, execution pulls mid-swap (thin to base)
        _setOracleMultiple(3);
        (ok, ev,,,) = hook.simulateEv(
            SwapParams({
                zeroForOne: quoteIsToken0,
                amountSpecified: -int256(1e4),
                sqrtPriceLimitX96: quoteIsToken0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            })
        );
        assertTrue(ok);
        assertLt(ev, int256(0));
        _buyEquitySwap(1e4);
        assertFalse(hook.guardPresent(), "guard pulled on toxic flow");
        assertEq(hook.effectiveLiquidity(), uint128(BASE_L), "swap priced against base only");

        // 4. Lazy redeploy on the next EV+ swap
        _alignOracle();
        _buyEquitySwap(1e4);
        assertTrue(hook.guardPresent(), "lazy redeploy on EV+");

        // 5. Pull again, then permissionless time recheck re-arms
        _setOracleMultiple(3);
        _buyEquitySwap(1e4);
        assertFalse(hook.guardPresent());

        vm.warp(block.timestamp + 301);
        _alignOracle();
        vm.prank(makeAddr("anyone"));
        hook.recheckGuard();
        assertTrue(hook.guardPresent(), "permissionless recheck re-arms");

        // 6. Allocator: park in standby, recall, refund, redeploy
        vm.prank(keeper);
        vault.setHookDeployEnabled(false);
        vm.prank(keeper);
        vault.recallFromHook();
        assertFalse(hook.guardPresent());

        vm.prank(keeper);
        vault.setHookDeployEnabled(true);
        vm.prank(keeper);
        vault.fundHook(200e6, 2e17);
        vm.prank(keeper);
        vault.deployGuard();
        assertTrue(hook.guardPresent());

        // 7. Expiry settlement and terminal redemptions
        vm.warp(expiry + 1);
        vault.finalizeSettlement();
        assertTrue(vault.settled());
        assertTrue(hook.exited());

        uint256 srShares = senior.balanceOf(address(this));
        uint256 usdcBefore = quote.balanceOf(address(this));
        senior.redeemAtExpiry(srShares, address(this));
        uint256 seniorPaid = quote.balanceOf(address(this)) - usdcBefore;
        assertGe(seniorPaid, 1_040e6, "senior gets principal + most of escrow");

        uint256 jrShares = junior.balanceOf(address(this));
        (uint256 jUsdc, uint256 jEquity) = junior.redeemAtExpiry(jrShares, address(this));
        assertGt(jUsdc + jEquity, 0, "junior residual paid");
    }

    function test_simulateMatchesExecution_evMinus() public {
        quote.mint(address(this), 100e6);
        _setOracleMultiple(3);

        SwapParams memory params = SwapParams({
            zeroForOne: quoteIsToken0,
            amountSpecified: -int256(5e5),
            sqrtPriceLimitX96: quoteIsToken0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        });
        (bool ok, int256 ev,,,) = hook.simulateEv(params);
        assertTrue(ok);
        assertLt(ev, int256(0));

        uint160 sqrtBefore = _slot0Sqrt();
        router.swapExactIn(key, params.zeroForOne, 5e5, 0, address(this));
        assertFalse(hook.guardPresent());
        // execution moved the price (the swap went through, thin)
        assertTrue(_slot0Sqrt() != sqrtBefore);
    }

    function test_simulateMatchesExecution_evPlus() public {
        quote.mint(address(this), 100e6);
        SwapParams memory params = SwapParams({
            zeroForOne: quoteIsToken0,
            amountSpecified: -int256(5e5),
            sqrtPriceLimitX96: quoteIsToken0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        });
        (bool ok, int256 ev, uint256 notional,,) = hook.simulateEv(params);
        assertTrue(ok);
        assertGe(ev, int256(0));
        assertGt(notional, 0);

        router.swapExactIn(key, params.zeroForOne, 5e5, 0, address(this));
        assertTrue(hook.guardPresent());
    }

    function _slot0Sqrt() internal view returns (uint160 sqrtPriceX96) {
        (sqrtPriceX96,,,) = manager.getSlot0(hook.activePoolId());
    }
}

