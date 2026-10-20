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
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { TestToken } from "../../src/test-only/TestToken.sol";
import { NVDAPriceOracle } from "../../src/oracle/NVDAPriceOracle.sol";
import { PoolGuardHook } from "../../src/hook/PoolGuardHook.sol";
import { PoolGuardSimulator } from "../../src/hook/PoolGuardSimulator.sol";
import { GuardParams } from "../../src/hook/libraries/GuardParams.sol";
import { LedgerVault } from "../../src/vaults/LedgerVault.sol";
import { TrancheAccountant } from "../../src/vaults/TrancheAccountant.sol";
import { SeniorVault } from "../../src/vaults/SeniorVault.sol";
import { JuniorVault } from "../../src/vaults/JuniorVault.sol";
import { StrategyModule } from "../../src/adapters/StrategyModule.sol";
import { ERC4626Adapter } from "../../src/adapters/ERC4626Adapter.sol";
import { MorphoLoopAdapter } from "../../src/adapters/MorphoLoopAdapter.sol";
import { IMorpho } from "../../src/adapters/IMorpho.sol";
import { MockMorpho } from "../../src/test-only/MockMorpho.sol";
import { MockMorphoOracle } from "../../src/test-only/MockStrategyFakes.sol";
import { IHookSharePipe } from "../../src/interfaces/IHookSharePipe.sol";
import { MockERC4626 } from "../../src/test-only/MockERC4626.sol";
import { VaultReadiness } from "../../src/vaults/VaultReadiness.sol";

/// @notice Expiry & withdrawal lifecycle: slow halt (soft step + permissionless haltIfExpired),
///         settlement readiness, haircut path, post-settlement request -> fulfill -> claim at
///         frozen rates, pending-at-expiry journeys, closed-session oracle gates, and the
///         guard-recall funding fallback for redemptions.
contract ExpiryWithdrawalsTest is Test {
    using PoolIdLibrary for PoolKey;
    using Math for uint256;

    IPoolManager internal manager;
    PoolGuardSimulator internal simulator;
    PoolGuardHook internal hook;
    LedgerVault internal vault;
    NVDAPriceOracle internal oracle;
    TestToken internal quote;
    TestToken internal nvda;

    TrancheAccountant internal accountant;
    SeniorVault internal senior;
    JuniorVault internal junior;

    StrategyModule internal module;
    MockERC4626 internal venue4626;
    ERC4626Adapter internal lendAdapter;

    PoolKey internal key;
    uint64 internal expiry;
    VaultReadiness internal readiness;

    function setUp() public {
        manager = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        simulator = new PoolGuardSimulator();
        quote = new TestToken("USD Coin", "mUSDC", 6);
        nvda = new TestToken("NVIDIA", "mNVDA", 18);

        oracle = new NVDAPriceOracle(8, address(this));
        oracle.setWriter(address(this), true);
        oracle.setMaxStaleness(1 hours);
        oracle.updatePrice(200e8, 2, uint32(block.timestamp), bytes32(0));

        address token0 = address(quote) < address(nvda) ? address(quote) : address(nvda);
        address token1 = token0 == address(quote) ? address(nvda) : address(quote);
        int24 initialTick = token0 == address(quote) ? int24(196260) : int24(-196260);
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

        // Zero-NAV bootstrap, then fund the hook and initialize the book.
        // (Tranches are wired below; seeding goes through senior — wrap doors are gated.)
        quote.mint(address(this), 200e6);
        quote.mint(address(vault), 150e6);
        nvda.mint(address(vault), 2e18);
        vault.fundHook(150e6, 1e18);
        vault.initializeHook(key, TickMath.getSqrtPriceAtTick(initialTick));
        oracle.updatePrice(int192(int256(hook.poolPrice1e18() / 1e10)), 2, uint32(block.timestamp), bytes32(0));
        // Arm the deviation band now that init price and oracle agree.
        vault.setGuardParams(_guardParams());

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
        _wrapAsSenior(100e6, address(this));

        module = new StrategyModule(address(this), address(quote));
        module.setVault(address(vault));
        module.setAllocator(address(this));
        module.setTimelock(0);
        vault.setStrategyModule(address(module));

        venue4626 = new MockERC4626(address(quote));
        lendAdapter = new ERC4626Adapter(address(module), address(venue4626), address(quote));
        module.submitAdapter(address(lendAdapter), true, false, 1_000_000e6, 10_000);
        module.executeAdapter(address(lendAdapter));

        readiness = new VaultReadiness();

        quote.approve(address(senior), type(uint256).max);
        quote.approve(address(junior), type(uint256).max);
    }

    /// @notice Wrap doors admit registered tranches only (D2) — seed through senior.
    function _wrapAsSenior(uint256 amount, address receiver) internal returns (uint256 shares) {
        quote.mint(address(senior), amount);
        vm.startPrank(address(senior));
        quote.approve(address(vault), amount);
        shares = vault.wrapQuote(amount, receiver);
        vm.stopPrank();
    }

    function _guardParams() internal pure returns (GuardParams.Params memory) {
        return GuardParams.Params({
            guardTickWidth: 600,
            baseTickWidth: 6000,
            guardLiquidity: 5e12,
            baseLiquidity: 1e12,
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
        GuardParams.Params memory p = _guardParams();
        p.recheckMaxDeviationBps = 0;
        return p;
    }

    function _depositSenior(uint256 amount) internal {
        quote.mint(address(this), amount);
        senior.depositQuote(amount, address(this));
    }

    function _depositJunior(uint256 amount) internal {
        quote.mint(address(this), amount);
        junior.depositQuote(amount, address(this));
    }

    function _warpToExpiry() internal {
        vm.warp(expiry + 1);
    }

    // ------------------------------------------------------------------
    // Slow halt
    // ------------------------------------------------------------------

    function test_softStep_thenHaltIfExpired() public {
        assertTrue(hook.guardPresent());

        // Soft step: deployments off; a recenter must not redeploy the guard.
        vault.setHookDeployEnabled(false);
        assertFalse(hook.deployEnabled());
        vault.recenterGuard();
        assertFalse(hook.guardPresent(), "no redeploy after soft halt");

        // Hard halt requires expiry and is permissionless.
        vm.expectRevert(LedgerVault.NotExpired.selector);
        vault.haltIfExpired();

        _warpToExpiry();
        uint256 vaultBefore = quote.balanceOf(address(vault));
        vm.prank(makeAddr("anyone"));
        vault.haltIfExpired();

        assertTrue(hook.exited());
        assertEq(hook.effectiveLiquidity(), 0, "base + guard pulled");
        (int24 lo, int24 hi, uint128 baseL) = hook.basePosition();
        lo;
        hi;
        assertEq(baseL, 0);
        assertGt(quote.balanceOf(address(vault)), vaultBefore, "inventory swept to vault");

        // Idempotent.
        vm.prank(makeAddr("someone-else"));
        vault.haltIfExpired();
        assertTrue(hook.exited());
    }

    // ------------------------------------------------------------------
    // Readiness & settlement
    // ------------------------------------------------------------------

    function test_settlementReadiness_and_finalize() public {
        _depositJunior(400e6);
        _depositSenior(1_000e6);

        _warpToExpiry();
        vault.haltIfExpired();

        VaultReadiness.SettlementReadiness memory r = readiness.settlementReadiness(address(vault));
        assertTrue(r.halted);
        assertEq(r.shortfall, 0);
        assertEq(r.loopDebt, 0);
        assertEq(r.pendingSeniorShares, 0);
        assertTrue(r.ready);

        vault.finalizeSettlement();
        assertTrue(vault.settled());
        assertFalse(readiness.settlementReadiness(address(vault)).ready, "not ready after settlement");
        assertTrue(senior.matured());
        assertTrue(junior.matured());
    }

    function test_haircutPath_ownerEscapeHatch() public {
        // Floor-compliant entry (underfunding at entry is structurally impossible now:
        // floor 25% >> escrow 5% overcollateralizes the guarantee from the first deposit).
        // The haircut path is the owner escape hatch — always available at/after expiry.
        _depositJunior(400e6);
        _depositSenior(1_000e6);

        _warpToExpiry();
        vault.haltIfExpired();

        vault.finalizeSettlementHaircut();
        assertTrue(vault.settled());
        assertTrue(senior.matured());
        assertTrue(junior.matured());
    }

    // ------------------------------------------------------------------
    // Post-settlement exit: request -> fulfill -> claim
    // ------------------------------------------------------------------

    function test_postSettlement_requestFulfillClaim_senior() public {
        _depositJunior(400e6);
        _depositSenior(1_000e6);
        _warpToExpiry();
        vault.haltIfExpired();
        vault.finalizeSettlement();

        uint256 shares = senior.balanceOf(address(this));
        uint256 requestShares = shares / 2;

        // Withdraw request on the senior vault is allowed post-settlement.
        senior.requestRedeem(requestShares, address(this), address(this));
        assertEq(senior.pendingRedeemRequest(0, address(this)), requestShares);

        // Anyone can fulfill at the frozen rates.
        vm.prank(makeAddr("anyone"));
        senior.fulfillRedeemMatured(address(this));
        assertEq(senior.pendingRedeemRequest(0, address(this)), 0);
        assertEq(senior.maxRedeem(address(this)), requestShares);

        uint256 expected = requestShares.mulDiv(senior.quotePerShare1e18(), 1e18);
        uint256 before = quote.balanceOf(address(this));
        (uint256 usdcOut,) = senior.claimMatured(address(this));
        assertEq(quote.balanceOf(address(this)) - before, usdcOut);
        assertApproxEqAbs(usdcOut, expected, 2);

        // The rest is paid via the direct expiry redemption.
        uint256 rest = shares - requestShares;
        uint256 before2 = quote.balanceOf(address(this));
        senior.redeemAtExpiry(rest, address(this));
        assertGt(quote.balanceOf(address(this)) - before2, 0);
        assertEq(senior.balanceOf(address(this)), 0);
    }

    function test_postSettlement_requestFulfillClaim_junior_getsUsdcAndEquity() public {
        _depositJunior(200e6);
        _warpToExpiry();
        vault.haltIfExpired();
        vault.finalizeSettlement();

        uint256 shares = junior.balanceOf(address(this));
        junior.requestRedeem(shares, address(this), address(this));
        vm.prank(makeAddr("anyone"));
        junior.fulfillRedeemMatured(address(this));

        uint256 usdcBefore = quote.balanceOf(address(this));
        uint256 nvdaBefore = nvda.balanceOf(address(this));
        (uint256 usdcOut, uint256 equityOut) = junior.claimMatured(address(this));

        assertGt(usdcOut, 0);
        assertGt(equityOut, 0, "junior receives the equity leg");
        assertEq(quote.balanceOf(address(this)) - usdcBefore, usdcOut);
        assertEq(nvda.balanceOf(address(this)) - nvdaBefore, equityOut);
    }

    function test_pendingAtExpiry_flowsThroughSettlement() public {
        _depositJunior(400e6);
        _depositSenior(1_000e6);

        // Request BEFORE expiry: shares burn into pending state (no cancel exists).
        uint256 shares = senior.balanceOf(address(this));
        senior.requestRedeem(shares, address(this), address(this));
        assertEq(senior.balanceOf(address(this)), 0);

        _warpToExpiry();
        vault.haltIfExpired();
        vault.finalizeSettlement();

        // Frozen rates cover pending shares too: the payout must distribute the
        // FULL settlement leg the senior vault received (every pending share is
        // still entitled once the books close).
        uint256 seniorLeg = quote.balanceOf(address(senior));
        assertGt(seniorLeg, 1_000e6, "senior leg covers the principal");
        assertGt(senior.quotePerShare1e18(), 0);
        vm.prank(makeAddr("anyone"));
        senior.fulfillRedeemMatured(address(this));
        uint256 expected = shares.mulDiv(senior.quotePerShare1e18(), 1e18);

        uint256 before = quote.balanceOf(address(this));
        (uint256 usdcOut,) = senior.claimMatured(address(this));
        assertApproxEqAbs(usdcOut, expected, 2);
        assertEq(quote.balanceOf(address(this)) - before, usdcOut);
        assertApproxEqAbs(usdcOut, seniorLeg, 2, "full leg distributed across pending shares");
    }

    function test_claimMatured_withoutClaimable_reverts() public {
        _depositJunior(40e6);
        _depositSenior(100e6);
        _warpToExpiry();
        vault.haltIfExpired();
        vault.finalizeSettlement();

        vm.expectRevert(TrancheVaultErrors.NothingToClaim.selector);
        senior.claimMatured(address(this));
    }

    // ------------------------------------------------------------------
    // Closed-session gates
    // ------------------------------------------------------------------

    function test_oracleClosed_gatesPriceOps_butProportionalWorks() public {
        uint256 shares = _wrapAsSenior(100e6, address(this));

        // Close the market (session None -> oracle invalid).
        oracle.updatePrice(200e8, 0, uint32(block.timestamp), bytes32(0));
        assertFalse(oracle.getPrice().valid);

        // Gate passes for the tranche, so the oracle check is what fires.
        quote.mint(address(senior), 10e6);
        vm.startPrank(address(senior));
        quote.approve(address(vault), 10e6);
        vm.expectRevert(LedgerVault.OracleInvalid.selector);
        vault.wrapQuote(10e6, address(this));
        vm.stopPrank();

        vm.expectRevert(LedgerVault.OracleInvalid.selector);
        vault.unwrapQuote(shares, address(this), 0);

        vm.expectRevert(LedgerVault.OracleInvalid.selector);
        vault.unwrapEquity(shares, address(this), 0);

        // Proportional is oracle-free and still works.
        (uint256 outUsdc, uint256 outEquity) = vault.unwrapProportional(shares / 2, address(this), 0, 0);
        assertGt(outUsdc + outEquity, 0);
    }

    // ------------------------------------------------------------------
    // Guard-recall funding fallback
    // ------------------------------------------------------------------

    /// @dev Primes a redemption that idle, hook-idle and strategy liquidity cannot cover, leaving
    ///      the guard position as the only funding source. Returns the wrapped share amount.
    function _primeShortRedemption() internal returns (uint256 shares) {
        // Reset the hook: everything back to the vault, guard out.
        vault.recallFromHook();

        // Re-fund and redeploy the guard; the leftover hook idle becomes the ladder's step-2 source.
        // NOTE: the guard is (re)deployed at 3x liquidity for the prime so its quote leg
        // (~28e6) comfortably covers the primed shortfall below. Share granularity is
        // ~NAV/1000 (virtual offset, ~6e6/share here), so the shortfall must exceed a
        // couple of shares of rounding either way — hence 20e6, not 2e6.
        vault.fundHook(100e6, 1e18);
        GuardParams.Params memory bigGuard = _guardParams();
        bigGuard.guardLiquidity = 15e12;
        vault.setGuardParams(bigGuard);
        vault.deployGuard();
        assertTrue(hook.guardPresent());

        (uint256 idleUsdc,) = hook.inventory();
        uint256 payout = idleUsdc + 20e6; // shortfall the guard must cover

        // Drain the vault into the strategy, then disable the adapter so it cannot fund redemptions.
        // No standing allowance — one-shot keeper approval per pull.
        vault.approveStrategy(address(quote), quote.balanceOf(address(vault)));
        module.allocate(address(lendAdapter), quote.balanceOf(address(vault)));
        module.disableAdapter(address(lendAdapter));

        // Wrap the payout, then drain again so only hook idle + guard remain.
        shares = _wrapAsSenior(payout, address(this));
        module.submitAdapter(address(lendAdapter), true, false, 1_000_000e6, 10_000);
        module.executeAdapter(address(lendAdapter));
        vault.approveStrategy(address(quote), quote.balanceOf(address(vault)));
        module.allocate(address(lendAdapter), quote.balanceOf(address(vault)));
        module.disableAdapter(address(lendAdapter));

        assertEq(quote.balanceOf(address(vault)), 0);
    }

    function test_guardRecallFundsRedemption() public {
        uint256 shares = _primeShortRedemption();
        assertTrue(hook.guardPresent());

        uint256 before = quote.balanceOf(address(this));
        uint256 out = vault.unwrapQuote(shares, address(this), 0);

        assertGt(out, 0);
        assertEq(quote.balanceOf(address(this)) - before, out);
        assertFalse(hook.guardPresent(), "guard recalled to fund the redemption");
    }

    function test_guardRecall_disabled_revertsWhenShort() public {
        uint256 shares = _primeShortRedemption();
        vault.setGuardRecallOnWithdraw(false);

        vm.expectPartialRevert(LedgerVault.InsufficientQuote.selector);
        vault.unwrapQuote(shares, address(this), 0);
        assertTrue(hook.guardPresent(), "guard untouched when the recall fallback is off");
    }

    // ------------------------------------------------------------------
    // Module expiry gate
    // ------------------------------------------------------------------

    function test_strategyModule_blocksNewAllocationsAfterExpiry() public {
        quote.mint(address(vault), 100e6);
        vault.approveStrategy(address(quote), 50e6);
        module.allocate(address(lendAdapter), 50e6);

        _warpToExpiry();
        vm.expectRevert(StrategyModule.BookExpired.selector);
        module.allocate(address(lendAdapter), 10e6);

        // De-risking stays available.
        uint256 got = module.deallocate(address(lendAdapter), 10e6);
        assertEq(got, 10e6);
    }

    // ------------------------------------------------------------------
    // Loop-sleeve settlement funding
    // ------------------------------------------------------------------

    /// @notice With NO standing allowance on the vault, settlement must still fund
    ///         `exitAll`'s loop-debt pull — it approves exactly `totalLoopDebt()`,
    ///         unwinds, and resets the allowance to zero.
    ///         (Earlier mock-vault tests hid this because the mock constructor
    ///         granted a max approval to the module.)
    function test_settlement_unwindsLoopDebt() public {
        _depositJunior(400e6);
        _depositSenior(1_000e6);

        // Wire a loop sleeve and open a levered position.
        MockMorpho morpho = new MockMorpho();
        MockMorphoOracle morphOracle = new MockMorphoOracle(2e27); // $2000 NVDA, 1e36 scale
        IMorpho.MarketParams memory mp = IMorpho.MarketParams({
            loanToken: address(quote),
            collateralToken: address(nvda),
            oracle: address(morphOracle),
            irm: address(0),
            lltv: 0.86e18
        });
        MorphoLoopAdapter loop =
            new MorphoLoopAdapter(address(module), address(morpho), mp, address(quote), 6_000, 1.2e18);
        module.submitAdapter(address(loop), false, true, 1_000_000e6, 9_000);
        module.executeAdapter(address(loop));

        // Seed loan-side liquidity so the sleeve can borrow.
        quote.mint(address(this), 10_000e6);
        quote.approve(address(morpho), type(uint256).max);
        morpho.supply(mp, 10_000e6, 0, address(this), "");

        // Fund the collareral + borrow with one-shot keeper approvals only.
        nvda.mint(address(vault), 10e18);
        vault.approveStrategy(address(nvda), 0.7e18);
        module.allocateCollateral(address(loop), 0.7e18);
        module.borrow(address(loop), 700e6);
        assertGt(loop.debt(), 0, "loop debt opened");
        // No standing allowance sits on the vault.
        assertEq(quote.allowance(address(vault), address(module)), 0);

        // Settle: pulls the book home, funds the loan repayment from the vault,
        // unwinds the sleeve, and distributes the waterfall.
        _warpToExpiry();
        vault.finalizeSettlement();

        assertTrue(vault.settled());
        assertEq(loop.debt(), 0, "loop debt repaid by settlement");
        assertEq(module.totalLoopDebt(), 0);
        assertEq(quote.allowance(address(vault), address(module)), 0, "allowance reset after unwind");
    }
}

/// @dev Local view of TrancheVault errors for selector assertions.
interface TrancheVaultErrors {
    error NothingToClaim();
}

