// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";
import { IPoolManager } from "v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "v4-core/src/types/PoolKey.sol";
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
import { TrancheAccountant } from "../../src/vaults/TrancheAccountant.sol";
import { SeniorVault } from "../../src/vaults/SeniorVault.sol";
import { JuniorVault } from "../../src/vaults/JuniorVault.sol";
import { IHookSharePipe } from "../../src/interfaces/IHookSharePipe.sol";

/// @notice Tranching economics: senior capped at principal-slice mid-life (never upside),
///         junior residual uncapped, fee/fine schedule, principal tracked at paid value.
contract TrancheEconomicsTest is Test {
    IPoolManager internal manager;
    PoolGuardHook internal hook;
    LedgerVault internal vault;
    NVDAPriceOracle internal oracle;
    TestToken internal quote;
    TestToken internal nvda;
    TrancheAccountant internal accountant;
    SeniorVault internal senior;
    JuniorVault internal junior;
    PoolKey internal key;
    uint64 internal expiry;
    address internal user = makeAddr("user");

    function setUp() public {
        manager = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        PoolGuardSimulator simulator = new PoolGuardSimulator();
        quote = new TestToken("USD Coin", "mUSDC", 6);
        nvda = new TestToken("NVIDIA", "mNVDA", 18);

        oracle = new NVDAPriceOracle(8, address(this));
        oracle.setWriter(address(this), true);
        oracle.setMaxStaleness(1 hours);
        oracle.updatePrice(200e8, 2, uint32(block.timestamp), bytes32(0));

        address token0 = address(quote) < address(nvda) ? address(quote) : address(nvda);
        address token1 = token0 == address(quote) ? address(nvda) : address(quote);
        int24 initialTick = token0 == address(quote) ? int24(196260) : int24(-196260);
        expiry = uint64(block.timestamp + 30 days);

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
            manager, hook, key, IERC20(address(quote)), IERC20(address(nvda)), address(oracle), expiry, address(this)
        );
        hook.setVault(address(vault));
        hook.transferOwnership(address(vault));
        vault.acceptHookOwnership();
        // Band-open for init (`initializeBook` enforces the band on live-oracle
        // inits); the band is armed after alignment below.
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

        // Owner bootstrap while no accountant is set (D2 bootstrap window): shares stay
        // with the deployer, never inside a tranche vault.
        quote.mint(address(this), 1e6);
        quote.approve(address(vault), 1e6);
        vault.wrapQuote(1e6, address(this));

        // Owner bootstrap while no accountant is set (D2 bootstrap window): shares stay
        // with the deployer, never inside a tranche vault (which would poison tranche
        // share issuance). Must precede setAccountant below.
        quote.mint(address(this), 1e6);
        quote.approve(address(vault), 1e6);
        vault.wrapQuote(1e6, address(this));

        accountant = new TrancheAccountant(address(this));
        accountant.setHook(address(vault));
        accountant.setKeeper(address(this));
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
        quote.mint(address(vault), 40e6);
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

        quote.mint(user, 100_000e6);
        vm.prank(user);
        quote.approve(address(senior), type(uint256).max);
        vm.prank(user);
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

    /// @notice Junior-led, floor-compliant (25%): junior first, then senior.
    function _depositBoth() internal returns (uint256 srShares, uint256 jrShares) {
        vm.prank(user);
        jrShares = junior.depositQuote(400e6, user);
        vm.prank(user);
        srShares = senior.depositQuote(1_000e6, user);
    }

    function _exitSeniorAll(address who, uint256 srShares) internal returns (uint256 out) {
        vm.prank(who);
        senior.requestRedeem(srShares, who, who);
        accountant.fulfillRedeem(true, who);
        vm.prank(who);
        out = senior.claimAndUnwrapQuote(srShares, who, who);
    }

    function _exitJuniorAll(address who, uint256 jrShares) internal returns (uint256 out) {
        vm.prank(who);
        junior.requestRedeem(jrShares, who, who);
        accountant.fulfillRedeem(false, who);
        vm.prank(who);
        out = junior.claimAndUnwrapQuote(jrShares, who, who);
    }

    /// @notice Fat book, senior exits: pinned at principal slice, never the upside.
    function test_seniorCapped_goodMarket() public {
        (uint256 srShares,) = _depositBoth();
        emit log_named_uint("DBG preDon srHookBal", vault.shareToken().balanceOf(address(senior)));
        quote.mint(address(vault), 5_000e6); // inflate NAV ~5x: upside belongs to junior

        vm.prank(user);
        senior.requestRedeem(srShares, user, user);
        accountant.fulfillRedeem(true, user);
        uint256 locked = accountant.claimableSenior();
        emit log_named_uint("DBG lockedShares", locked);
        emit log_named_uint("DBG lockedValue", vault.convertToQuote(locked));
        emit log_named_uint("DBG srHookBal2", vault.shareToken().balanceOf(address(senior)));

        vm.prank(user);
        uint256 out = senior.claimAndUnwrapQuote(srShares, user, user);
        assertGe(out, 999e6);
        assertLe(out, 1_001e6);
    }

    /// @notice Same fat book, junior exits: captures the upside, uncapped. Junior backing
    ///         (~200e6 deposit) appreciates with pool NAV; payout is a multiple of deposit
    ///         while senior stays pinned — upside flows to residual, as designed.
    function test_juniorCapturesUpside() public {
        _depositBoth();
        quote.mint(address(vault), 5_000e6);

        uint256 out = _exitJuniorAll(user, junior.balanceOf(user));
        assertGe(out, 1_500e6, "upside captured: multiple of deposit");
        assertLe(out, 5_700e6, "never senior's pocket: pool minus senior promise");
    }

    /// @notice Underwater book: senior shares the loss, no top-up mid-life.
    function test_seniorUnderwater_paysNAV() public {
        // H6 spot band models dislocation protection: this scenario crashes the
        // oracle with no arbitrageur to realign spot, so exits open via band-off
        // (production: arb realigns spot in seconds, then exits flow).
        vault.setMaxUnwrapDeviationBps(0);
        vm.prank(user);
        junior.depositQuote(400e6, user);
        vm.prank(user);
        uint256 srShares = senior.depositQuote(1_000e6, user);
        // Crash equity value: pool left with quote leg only, below senior principal.
        oracle.updatePrice(1e6, 2, uint32(block.timestamp), bytes32(0));

        uint256 out = _exitSeniorAll(user, srShares);
        assertLt(out, 1_000e6, "shared loss, no mid-life top-up");
        assertGt(out, 0);
    }

    /// @notice Day-1 full exit: deposit in, deposit out — zero profit possible.
    function test_dayOne_noProfit() public {
        (uint256 srShares,) = _depositBoth();
        uint256 out = _exitSeniorAll(user, srShares);
        assertApproxEqAbs(out, 1_000e6, 3e6);
    }

    /// @notice Rebalance never pre-loads premium shares: senior backing stays principal-only.
    function test_rebalance_principalOnly() public {
        _depositBoth();
        quote.mint(address(vault), 5_000e6);
        accountant.rebalance();

        uint256 seniorBacking = vault.convertToQuote(vault.shareToken().balanceOf(address(senior)));
        assertLe(seniorBacking, 1_001e6, "no escrow enrichment mid-life");
    }

    /// @notice Principal tracks paid value: unchanged at request, reduced at claim.
    function test_principal_reducedAtClaimNotRequest() public {
        vm.prank(user);
        junior.depositQuote(400e6, user);
        vm.prank(user);
        uint256 srShares = senior.depositQuote(1_000e6, user);
        uint256 principalBefore = accountant.seniorPrincipal();
        assertGt(principalBefore, 999e6);

        vm.prank(user);
        senior.requestRedeem(srShares, user, user);
        assertEq(accountant.seniorPrincipal(), principalBefore, "request does not move principal");

        accountant.fulfillRedeem(true, user);
        uint256 before = quote.balanceOf(user);
        vm.prank(user);
        senior.claimAndUnwrapQuote(srShares, user, user);
        uint256 paid = quote.balanceOf(user) - before;
        assertEq(accountant.seniorPrincipal(), principalBefore - paid, "claim reduces by paid value");
    }

    /// @notice Fee 0.2% + decaying fine 0.3%: mid-term exit pays net, exact to dust.
    function test_feeFine_exact() public {
        vault.setExitFees(20, 30);
        (uint256 srShares,) = _depositBoth();

        vm.warp(block.timestamp + 15 days); // half term: fine = 15bps, total 35bps
        oracle.updatePrice(int192(int256(hook.poolPrice1e18() / 1e10)), 2, uint32(block.timestamp), bytes32(0));
        uint256 out = _exitSeniorAll(user, srShares);
        assertApproxEqAbs(out, 1_000e6 * 9965 / 10_000, 3e6);
    }

    /// @notice Fee schedule locks on first set, including the conversion fee.
    function test_feeSchedule_oneShot() public {
        vault.setConversionFeeBps(50);
        vault.setExitFees(20, 30);
        vm.expectRevert(LedgerVault.FeeScheduleLocked.selector);
        vault.setExitFees(10, 10);
        vm.expectRevert(LedgerVault.FeeScheduleLocked.selector);
        vault.setConversionFeeBps(10);
    }

    /// @notice Terminal claims are fee-free: senior gets the full guarantee.
    function test_settlement_feeFree() public {
        vault.setExitFees(20, 30);
        (uint256 srShares,) = _depositBoth();
        vm.warp(expiry + 1);
        vault.finalizeSettlement();

        uint256 guarantee = accountant.seniorGuaranteeQuote();
        // Bound the rate-floor dust BEFORE redeeming (the burn zeroes the supply).
        uint256 dustBound = senior.totalSupply() / 1e18 + 2;
        vm.prank(user);
        (uint256 usdcOut,) = senior.redeemAtExpiry(srShares, user);
        // Fee-free, but NOT dust-free: the frozen rate is floored at 1e18 precision,
        // so redemption loses up to `supply / 1e18` units (~ppm at offset-6 share
        // granularity). A fee haircut would be 20bps+ (~200k units) — orders away.
        assertLe(usdcOut, guarantee, "never overpays the guarantee");
        assertGe(usdcOut, guarantee > dustBound ? guarantee - dustBound : 0, "no fee haircut at settlement");
    }
}
