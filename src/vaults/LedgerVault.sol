// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IPoolManager } from "v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "v4-core/src/types/PoolKey.sol";
import { Currency, CurrencyLibrary } from "v4-core/src/types/Currency.sol";
import { TickMath } from "v4-core/src/libraries/TickMath.sol";
import { StateLibrary } from "v4-core/src/libraries/StateLibrary.sol";
import { HookShareToken } from "../core/HookShareToken.sol";
import { IHookSharePipe } from "../interfaces/IHookSharePipe.sol";
import { ITrancheAccountant } from "../interfaces/ITrancheAccountant.sol";
import { ITrancheHookValue } from "../interfaces/ITrancheHookValue.sol";
import { INVDAPriceOracle } from "../interfaces/INVDAPriceOracle.sol";
import { IBookHook } from "../interfaces/IBookHook.sol";
import { IStrategyModule } from "../adapters/IStrategyModule.sol";
import { GuardParams } from "../hook/libraries/GuardParams.sol";
import { LiquidityAmounts } from "../hook/libraries/LiquidityAmounts.sol";
import { LedgerSettlement } from "./LedgerSettlement.sol";

interface IHubOwnable {
    function acceptOwnership() external;
}

interface IVenuePool {
    function deposit(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

/// @notice Combined vault of the static-fee book: the tranche layer's share issuer, NAV/value
///         source, wrap/unwrap pipe, settlement engine and capital allocator â€” replacing both the
///         v3 hook-share duties and `TranchePipeModule`. It owns the book (`IBookHook`: a lone
///         `PoolGuardHook` or a `DualBookHub`, hook admin is
///         proxied through the bounded functions below) and connects the unchanged
///         `TrancheVault`/`SeniorVault`/`JuniorVault`/`TrancheAccountant` flow to it.
///
///         Capital flow: deposits -> vault; vault decides how much sits in the hook (guard/base)
///         vs the lending venue; the hook pulls its guard on adverse flow by itself, and the vault
///         can recall it, pause deployments and park capital in lending whenever it wants.
contract LedgerVault is IHookSharePipe, ITrancheHookValue, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Math for uint256;
    using StateLibrary for IPoolManager;
    using CurrencyLibrary for Currency;

    // Share denomination. Genesis prices one quote unit at 1e15 hook-shares on any book
    // ($1 -> 1e15 on 6-dec, 1 WETH -> 1e15 on 18-dec), so `TrancheVault.creditSettlement`'s
    // 1e18 per-share rate keeps sub-cent precision on either book.
    uint256 public constant SHARE_SCALE = 1e6;
    uint256 internal constant VIRTUAL_SHARES = 1e3;

    /// @notice Virtual asset offset, scaled to the quote (one-millionth of a quote unit:
    ///         1 unit on 6-dec, 1e12 wei on 18-dec). Single source of truth; the 7575 entry
    ///         reads it from here so previews can never drift from execution.
    function virtualAssets() public view returns (uint256) {
        uint8 quoteDec = quoteDecimals;
        return quoteDec >= 6 ? 10 ** (quoteDec - 6) : 1;
    }
    uint16 public constant MAX_CONVERSION_FEE_BPS = 100;
    uint16 internal constant BPS = 10_000;

    IPoolManager public immutable poolManager;
    IBookHook public immutable hook;
    HookShareToken public immutable shareToken;
    IERC20 public immutable quote;
    IERC20 public immutable equity;
    address public immutable priceOracle;
    uint8 public immutable oracleDecimals;
    uint8 public immutable quoteDecimals;
    uint8 public immutable equityDecimals;
    uint64 public immutable expiry;

    address public keeper;
    address public accountant;
    uint16 public conversionFeeBps;
    /// @notice One-shot exit schedule (D5 fee lock): flat redemption fee + early-exit fine
    ///         decaying to zero at expiry, both pool-kept. Set once, then locked forever.
    uint16 public redemptionFeeBps;
    uint16 public maxFineBps;
    uint64 public startTimestamp;
    bool public feeScheduleLocked;
    bool public settled;
    /// @notice When true, redemptions that exhaust idle/hook/venue/strategy liquidity recall the
    ///         guard position (and claims) as a last resort. Base stays until halt/settlement.
    bool public guardRecallOnWithdraw = true;
    /// @notice H6: max |spot − oracle| deviation (bps) allowed on wrap/unwrap.
    ///         Guards the thin-book pump: spot inflated far above oracle cannot mint
    ///         cheap shares or `unwrapQuote` at inflated `convertToQuote`. Zero disables.
    uint16 public maxUnwrapDeviationBps = 500;
    /// @notice Terminal halt flag (H12): once set after expiry, keeper re-enable /
    ///         redeploy paths stay closed — `_halt` cannot be undone into settlement.
    bool public halted;
    /// @notice Medium: vault-level oracle freshness bound (seconds). The hook enforces
    ///         its own `maxPriceAge` on swaps; pricing paths (`_oracleMid`) previously
    ///         accepted anything the oracle itself called valid. Zero disables.
    ///         Production wiring: set <= the hook's `maxPriceAge`.
    uint32 public maxOracleAge;

    IVenuePool public venue;
    IERC20 public aToken;
    address public strategyModule;

    PoolKey internal _venueKey;

    event KeeperUpdated(address indexed keeper);
    event AccountantUpdated(address indexed accountant);
    event VenueUpdated(address indexed venue, address indexed aToken);
    event StrategyModuleUpdated(address indexed module);
    event GuardRecallOnWithdrawSet(bool enabled);
    event GuardRecalledForWithdrawal(uint256 shortfall);
    event Halted(uint256 timestamp);
    event ConversionFeeBpsUpdated(uint16 bps);
    event ExitFeesUpdated(uint16 feeBps, uint16 fineBps);
    event HookFunded(uint256 quoteAmount, uint256 equityAmount);
    event QuoteWrapped(address indexed caller, address indexed receiver, uint256 quoteAmount, uint256 shares);
    event QuoteUnwrapped(address indexed caller, address indexed receiver, uint256 shares, uint256 quoteAmount);
    event EquityUnwrapped(address indexed caller, address indexed receiver, uint256 shares, uint256 equityAmount);
    event ProportionalUnwrapped(
        address indexed caller, address indexed receiver, uint256 shares, uint256 quoteAmount, uint256 equityAmount
    );
    event Supplied(uint256 amount);
    event Withdrawn(uint256 amount);
    event RebalancePulled(address indexed token, uint256 amount);
    // NOTE: settlement logic + `SettlementFinalized` live in `LedgerSettlement`
    // (delegatecall library, EIP-170 room); the error stubs below stay so existing
    // selectors (`LedgerVault.AlreadySettled`, ...) keep resolving — the library
    // declares identical errors, so onchain selectors are unchanged.

    error ZeroAddress();
    error ZeroAmount();
    error NotKeeper(address caller);
    error NotTranche(address caller);
    error TradingClosed();
    error OracleInvalid();
    error SlippageExceeded(uint256 received, uint256 minOut);
    error ConversionFeeTooHigh(uint16 feeBps);
    error FeeTooHigh(uint16 bps);
    error FeeScheduleLocked();
    error VenueUnset();
    error InsufficientQuote(uint256 requested, uint256 available);
    error InsufficientEquity(uint256 requested, uint256 available);
    error NotExpired();
    error AlreadySettled();
    error AccountantUnset();
    error VaultsUnset();
    error SettlementNotReady();
    error InvalidOracleDecimals(uint8 decimals);
    error SpotDeviation(uint256 deviationBps, uint16 maxDeviationBps);
    error IsHalted();

    /// @notice Keeper-only once a keeper is set; before that (deploy bootstrap) the owner
    ///         may act. Owner recovery is replacing the keeper, never acting around it —
    ///         routine money moves flow through the strategy alone (Q1).
    modifier onlyKeeper() {
        address keeper_ = keeper;
        if (msg.sender != keeper_ && (keeper_ != address(0) || msg.sender != owner())) {
            revert NotKeeper(msg.sender);
        }
        _;
    }

    constructor(
        IPoolManager poolManager_,
        IBookHook hook_,
        PoolKey memory key_,
        IERC20 quote_,
        IERC20 equity_,
        address priceOracle_,
        uint64 expiry_,
        address owner_
    ) Ownable(owner_ == address(0) ? msg.sender : owner_) {
        if (
            address(poolManager_) == address(0) || address(hook_) == address(0) || address(quote_) == address(0)
                || address(equity_) == address(0) || priceOracle_ == address(0)
        ) revert ZeroAddress();
        if (Currency.unwrap(key_.currency0) != address(quote_) && Currency.unwrap(key_.currency1) != address(quote_)) {
            revert ZeroAddress();
        }
        if (Currency.unwrap(key_.currency0) != address(equity_) && Currency.unwrap(key_.currency1) != address(equity_))
        {
            revert ZeroAddress();
        }
        uint8 decimals_ = INVDAPriceOracle(priceOracle_).decimals();
        if (decimals_ > 18) revert InvalidOracleDecimals(decimals_);

        poolManager = poolManager_;
        hook = hook_;
        quote = quote_;
        equity = equity_;
        priceOracle = priceOracle_;
        oracleDecimals = decimals_;
        quoteDecimals = IERC20MetadataLite(address(quote_)).decimals();
        equityDecimals = IERC20MetadataLite(address(equity_)).decimals();
        expiry = expiry_;
        _venueKey = key_;
        shareToken = new HookShareToken(address(this), address(quote_));
    }

    // ---------------------------------------------------------------------
    // Roles & configuration
    // ---------------------------------------------------------------------

    function setKeeper(address newKeeper) external onlyOwner {
        if (newKeeper == address(0)) revert ZeroAddress();
        keeper = newKeeper;
        emit KeeperUpdated(newKeeper);
    }

    function setAccountant(address newAccountant) external onlyOwner {
        if (newAccountant == address(0)) revert ZeroAddress();
        accountant = newAccountant;
        emit AccountantUpdated(newAccountant);
    }

    function setConversionFeeBps(uint16 bps) external onlyOwner {
        if (feeScheduleLocked) revert FeeScheduleLocked();
        if (bps > MAX_CONVERSION_FEE_BPS) revert ConversionFeeTooHigh(bps);
        conversionFeeBps = bps;
        emit ConversionFeeBpsUpdated(bps);
    }

    /// @notice One-shot exit schedule: flat redemption fee (farming friction) + early-exit fine
    ///         ceiling decaying linearly to zero at expiry. Both pool-kept, both locked forever
    ///         on first set — set the conversion fee first if you want it. Suggested: 20 + 30
    ///         (≈0.5% combined on day one). Settlement and matured claims are always fee-free.
    function setExitFees(uint16 feeBps_, uint16 fineBps_) external onlyOwner {
        if (feeScheduleLocked) revert FeeScheduleLocked();
        if (feeBps_ > MAX_CONVERSION_FEE_BPS) revert FeeTooHigh(feeBps_);
        if (fineBps_ > MAX_CONVERSION_FEE_BPS) revert FeeTooHigh(fineBps_);
        redemptionFeeBps = feeBps_;
        maxFineBps = fineBps_;
        feeScheduleLocked = true;
        emit ExitFeesUpdated(feeBps_, fineBps_);
    }

    /// @notice Early-exit fine in bps, decaying linearly from maxFineBps at book start to zero
    ///         at expiry (terminal exits are free). Clock starts on the first wrap.
    function _fineBps() internal view returns (uint256) {
        uint256 maxFine = maxFineBps;
        if (maxFine == 0) return 0;
        uint64 exp = expiry;
        if (exp == 0 || block.timestamp >= exp) return 0;
        uint64 start = startTimestamp;
        if (start == 0 || block.timestamp <= start || exp <= start) return maxFine;
        unchecked {
            return maxFine * (exp - block.timestamp) / (exp - start);
        }
    }

    /// @notice Applies fee + fine to a gross payout. Retained spread benefits whoever stays.
    ///         Floor-safe: combined rate is capped far below 100%, so this cannot underflow.
    function _deductExitFees(uint256 gross) internal view returns (uint256 net) {
        uint256 bps = uint256(redemptionFeeBps) + _fineBps();
        if (bps == 0) return gross;
        net = gross - Math.mulDiv(gross, bps, BPS);
    }

    function setVenue(address lendingPool, address aToken_) external onlyOwner {
        if (lendingPool == address(0) || aToken_ == address(0)) revert ZeroAddress();
        venue = IVenuePool(lendingPool);
        aToken = IERC20(aToken_);
        emit VenueUpdated(lendingPool, aToken_);
    }

    /// @notice Attaches the strategy module with NO standing allowances (C3).
    ///         The old code granted `type(uint).max` to an instantly-swappable module,
    ///         so `setStrategyModule(evil)` drained the vault via `transferFrom`.
    ///         Allocator flow is now: keeper `approveStrategy(token, amount)` (exact) ->
    ///         allocator `StrategyModule.allocate/...` (consumes it) -> keeper revokes
    ///         any remainder. Set to zero to detach (revokes both).
    function setStrategyModule(address module) external onlyOwner {
        // Revoke from the old module first (effects before interactions below).
        address old = strategyModule;
        if (old != address(0)) {
            quote.forceApprove(old, 0);
            equity.forceApprove(old, 0);
        }
        strategyModule = module;
        emit StrategyModuleUpdated(module);
    }

    /// @notice One-shot exact approval for the strategy module (keeper-gated, C3).
    ///         Approves `amount` on top of zero — never a standing max. Revoke by
    ///         approving zero.
    function approveStrategy(address token, uint256 amount) external onlyKeeper {
        if (token != address(quote) && token != address(equity)) revert ZeroAddress();
        if (strategyModule == address(0)) revert ZeroAddress();
        IERC20(token).forceApprove(strategyModule, amount);
    }

    function setGuardRecallOnWithdraw(bool enabled) external onlyOwner {
        guardRecallOnWithdraw = enabled;
        emit GuardRecallOnWithdrawSet(enabled);
    }

    /// @notice Tunes the H6 spot-vs-oracle band (0 disables). Bounded to 100%.
    function setMaxUnwrapDeviationBps(uint16 bps) external onlyOwner {
        if (bps > BPS) revert FeeTooHigh(bps);
        maxUnwrapDeviationBps = bps;
    }

    /// @notice Medium: vault-level oracle freshness bound (0 disables). Mirrors the
    ///         hook's `maxPriceAge` so pricing paths cannot run on a feed the swap
    ///         gate would already reject.
    function setMaxOracleAge(uint32 seconds_) external onlyOwner {
        maxOracleAge = seconds_;
    }

    /// @notice Current exit fee + decaying fine, in bps. Lets the ERC-7575 entry
    ///         compute NET previews (gross-up) that match what `unwrapQuote` pays.
    function currentExitFeeBps() external view returns (uint256) {
        return uint256(redemptionFeeBps) + _fineBps();
    }

    /// @notice Registers the ERC-7575 entry point in the share token's vault lookup (EIP-7575).
    function setShareVault(address shareVault_) external onlyOwner {
        shareToken.setVault(shareVault_);
    }

    // ---------------------------------------------------------------------
    // Slow halt (expiry wind-down)
    // ---------------------------------------------------------------------

    /// @notice Owner early halt: stop deployments and pull base + guard back to this vault.
    function halt() external onlyOwner {
        _halt();
    }

    /// @notice Permissionless halt at/after expiry: never redeploys again; base and guard return
    ///         to the vault for settlement. Idempotent.
    function haltIfExpired() external {
        if (!expired()) revert NotExpired();
        _halt();
    }

    function _halt() internal {
        // H12: once halted after expiry, the book stays halted — keeper
        // `setHookDeployEnabled(true)+rearm()` must not redeploy terminal capital.
        if (halted) return;
        if (expired()) halted = true;
        hook.setDeployEnabled(false);
        if (hook.poolInitialized() && !hook.exited()) {
            hook.pullAll();
            emit Halted(block.timestamp);
        }
    }

    /// @notice Keeper-only pull for the controller's bottom-layer swap: gathers `amount`
    ///         of `token` through the usual ladder and sends it to the keeper, which swaps
    ///         and returns the proceeds to this vault. Swap math lives in the controller.
    function pullForRebalance(address token, uint256 amount) external onlyKeeper nonReentrant {
        if (token != address(quote) && token != address(equity)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (token == address(quote)) _ensureQuote(amount);
        else _ensureEquity(amount);
        IERC20(token).safeTransfer(msg.sender, amount);
        emit RebalancePulled(token, amount);
    }

    // ---------------------------------------------------------------------
    // Hook ownership & allocation
    // ---------------------------------------------------------------------

    function acceptHookOwnership() external onlyKeeper {
        hook.acceptHookOwnership();
    }

    /// @notice H8: completes a two-step `DualBookHub` ownership transfer to this vault
    ///         (the hub is `Ownable2Step`; without this relay the transfer would strand
    ///         with the deployer as owner). Deploy wiring: `hub.transferOwnership(vault)`
    ///         then this. Owner-only, use once at deploy.
    function acceptHubOwnership(address hub) external onlyOwner {
        IHubOwnable(hub).acceptOwnership();
    }

    function initializeHook(PoolKey calldata key, uint160 sqrtPriceX96) external onlyOwner {
        hook.initializeBook(key, sqrtPriceX96);
    }

    function setGuardParams(GuardParams.Params calldata params) external onlyKeeper {
        if (halted) revert IsHalted();
        // H8: bound the riskiest knob — minEvBps == 10_000 means "never defend".
        // Hard cap at 5_000 (50%) so a fat-finger cannot silently disable the guard.
        if (params.minEvBps > 5_000) revert ConversionFeeTooHigh(params.minEvBps);
        hook.setGuardParams(params);
    }

    function setHookDeployEnabled(bool enabled) external onlyKeeper {
        // H12: halted books never re-enable deployments.
        if (enabled && halted) revert IsHalted();
        hook.setDeployEnabled(enabled);
    }

    function recenterGuard() external onlyKeeper {
        if (halted) revert IsHalted();
        hook.recenterGuard();
    }

    function deployGuard() external onlyKeeper {
        if (halted) revert IsHalted();
        hook.deployGuard();
    }

    function rearmHook() external onlyKeeper {
        if (halted) revert IsHalted();
        hook.rearm();
    }

    /// @notice Pulls the guard and returns hook inventory to this vault; base stays deployed.
    function recallFromHook() external onlyKeeper {
        hook.recallToVault();
    }

    /// @notice Full protocol exit: pulls guard + base and sweeps everything here.
    function exitHook() external onlyOwner {
        hook.pullAll();
    }

    /// @notice Pushes vault capital into the hook's inventory for deployment.
    function fundHook(uint256 quoteAmount, uint256 equityAmount) external onlyKeeper {
        if (quoteAmount != 0) quote.safeTransfer(address(hook), quoteAmount);
        if (equityAmount != 0) equity.safeTransfer(address(hook), equityAmount);
        emit HookFunded(quoteAmount, equityAmount);
    }

    // ---------------------------------------------------------------------
    // Yield venue
    // ---------------------------------------------------------------------

    /// @notice Sweeps the entire idle balance into the venue. Medium: to keep a
    ///         redemption buffer, prefer `supplyIdleAmount`; this zero-arg form is
    ///         retained for the agent's existing call plan.
    function supplyIdle() external onlyKeeper returns (uint256 supplied) {
        return supplyIdleAmount(quote.balanceOf(address(this)));
    }

    /// @notice Supplies an explicit amount to the venue (clamped to the balance),
    ///         leaving the remainder as the redemption buffer.
    function supplyIdleAmount(uint256 amount) public onlyKeeper returns (uint256 supplied) {
        if (address(venue) == address(0)) revert VenueUnset();
        if (amount == 0) revert ZeroAmount();
        uint256 balance = quote.balanceOf(address(this));
        supplied = amount < balance ? amount : balance;
        if (supplied == 0) revert ZeroAmount();
        quote.forceApprove(address(venue), supplied);
        venue.deposit(address(quote), supplied, address(this), 0);
        quote.forceApprove(address(venue), 0);
        emit Supplied(supplied);
    }

    function withdrawFromVenue(uint256 amount) external onlyKeeper returns (uint256 withdrawn) {
        withdrawn = _withdrawFromVenue(amount);
    }

    // ---------------------------------------------------------------------
    // Share / pipe surface (IHookSharePipe + ITrancheHookValue)
    // ---------------------------------------------------------------------

    function expired() public view returns (bool) {
        return expiry != 0 && block.timestamp >= expiry;
    }

    function totalManagedAssets() public view returns (uint256 value) {
        value = baseManagedAssets();
        address module = strategyModule;
        if (module != address(0)) value += IStrategyModule(module).totalAssets();
    }

    /// @notice NAV of the book's own liquidity (vault + hook + venue), excluding strategy adapters.
    function baseManagedAssets() public view returns (uint256 value) {
        (uint256 quoteUnits, uint256 equityUnits) = _managedUnits();
        value = quoteUnits + _equityUnitsToQuote(equityUnits, _oracleMid());
    }

    function convertToShares(uint256 quoteAmount) public view returns (uint256) {
        return _convertToSharesWithTotal(quoteAmount, totalManagedAssets());
    }

    function _convertToSharesWithTotal(uint256 quoteAmount, uint256 totalBefore) internal view returns (uint256) {
        uint256 scaledTotal = totalBefore * SHARE_SCALE;
        return Math.mulDiv(
            quoteAmount * SHARE_SCALE, shareToken.totalSupply() + VIRTUAL_SHARES, scaledTotal + virtualAssets()
        );
    }

    function convertToQuote(uint256 shares) public view returns (uint256) {
        uint256 scaledTotal = totalManagedAssets() * SHARE_SCALE;
        uint256 scaledSupply = (shareToken.totalSupply() + VIRTUAL_SHARES) * SHARE_SCALE;
        return Math.mulDiv(shares, scaledTotal + virtualAssets(), scaledSupply);
    }

    /// @notice Deposit doors admit the two registered tranche vaults only (D2): the accountant
    ///         attributes every deposit by caller and settlement pays only the tranches, so
    ///         direct or 7575-entry deposits would strand at ~0. Exits stay open to all holders.
    ///         Exception: before any accountant is set (deploy bootstrap), the owner alone may
    ///         wrap — bootstrap shares must sit with the deployer, never inside a tranche vault
    ///         (which would poison tranche share issuance). Same bootstrap-owner pattern as Q1.
    function _requireTranche() internal view {
        address acct = accountant;
        if (acct == address(0)) {
            if (msg.sender != owner()) revert NotTranche(msg.sender);
            return;
        }
        ITrancheAccountant accountant_ = ITrancheAccountant(acct);
        if (msg.sender != accountant_.seniorVault() && msg.sender != accountant_.juniorVault()) {
            revert NotTranche(msg.sender);
        }
    }

    function wrapQuote(uint256 quoteAmount, address receiver) external nonReentrant returns (uint256 shares) {
        _requireTranche();
        if (startTimestamp == 0) startTimestamp = uint64(block.timestamp);
        if (expired()) revert TradingClosed();
        if (_oracleMid() == 0) revert OracleInvalid();
        _requireSpotBand();
        if (quoteAmount == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        uint256 totalBefore = totalManagedAssets();
        quote.safeTransferFrom(msg.sender, address(this), quoteAmount);
        shares = _convertToSharesWithTotal(quoteAmount, totalBefore);
        if (shares == 0) revert ZeroAmount();
        shareToken.mint(receiver, shares);
        emit QuoteWrapped(msg.sender, receiver, quoteAmount, shares);
    }

    /// @notice Mints an exact number of shares, pulling the vault-favoring rounded-up quote
    ///         amount. Backs the ERC-7575 entry's `mint` (ERC-4626 requires exact-share entry).
    function wrapSharesExact(uint256 shares, address receiver) external nonReentrant returns (uint256 assets) {
        _requireTranche();
        if (startTimestamp == 0) startTimestamp = uint64(block.timestamp);
        if (expired()) revert TradingClosed();
        if (_oracleMid() == 0) revert OracleInvalid();
        _requireSpotBand();
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        uint256 scaledTotal = totalManagedAssets() * SHARE_SCALE;
        uint256 scaledSupply = (shareToken.totalSupply() + VIRTUAL_SHARES) * SHARE_SCALE;
        assets = Math.mulDiv(shares, scaledTotal + virtualAssets(), scaledSupply, Math.Rounding.Ceil);
        quote.safeTransferFrom(msg.sender, address(this), assets);
        shareToken.mint(receiver, shares);
        emit QuoteWrapped(msg.sender, receiver, assets, shares);
    }

    function unwrapQuote(uint256 shares, address receiver) external returns (uint256 quoteAmount) {
        return unwrapQuote(shares, receiver, 0);
    }

    function unwrapQuote(uint256 shares, address receiver, uint256 minQuoteOut)
        public
        nonReentrant
        returns (uint256 quoteAmount)
    {
        // H6: terminal exits go through settlement/matured paths only — post-expiry
        // `unwrapQuote` at a pumped spot NAV drains real quote and bricks the waterfall.
        if (expired()) revert TradingClosed();
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        if (_oracleMid() == 0) revert OracleInvalid();
        _requireSpotBand();
        quoteAmount = _deductExitFees(convertToQuote(shares));
        if (quoteAmount < minQuoteOut) revert SlippageExceeded(quoteAmount, minQuoteOut);
        shareToken.burn(msg.sender, shares);
        _ensureQuote(quoteAmount);
        quote.safeTransfer(receiver, quoteAmount);
        emit QuoteUnwrapped(msg.sender, receiver, shares, quoteAmount);
    }

    function unwrapEquity(uint256 shares, address receiver, uint256 minEquityOut)
        public
        nonReentrant
        returns (uint256 equityAmount)
    {
        if (expired()) revert TradingClosed();
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        uint256 gross = _quoteToEquityUnits(convertToQuote(shares), _requireOracleMid());
        _requireSpotBand();
        equityAmount = _deductExitFees(gross - Math.mulDiv(gross, conversionFeeBps, BPS));
        if (equityAmount < minEquityOut) revert SlippageExceeded(equityAmount, minEquityOut);
        shareToken.burn(msg.sender, shares);
        _ensureEquity(equityAmount);
        equity.safeTransfer(receiver, equityAmount);
        emit EquityUnwrapped(msg.sender, receiver, shares, equityAmount);
    }

    function unwrapProportional(uint256 shares, address receiver, uint256 minQuoteOut, uint256 minEquityOut)
        public
        nonReentrant
        returns (uint256 quoteAmount, uint256 equityAmount)
    {
        if (expired()) revert TradingClosed();
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        hook.unwindClaims();

        uint256 supply = shareToken.totalSupply();
        if (supply == 0) revert InsufficientQuote(0, 0);
        // Medium: the old pro-rata omitted the deployed base/guard positions and the
        // virtual offsets, underpaying redeemers and leaking value to those who stay.
        // Include both positions (reachable through the recall ladder below) and use
        // the same virtual offsets as `convertToQuote`.
        (uint256 posQuote, uint256 posEquity) = _positionUnits();
        uint256 quoteUnits = quote.balanceOf(address(this)) + hook.quoteIdle() + posQuote;
        if (address(aToken) != address(0)) quoteUnits += aToken.balanceOf(address(this));
        uint256 equityUnits = equity.balanceOf(address(this)) + hook.equityIdle() + posEquity;

        uint256 scaledSupply = (supply + VIRTUAL_SHARES) * SHARE_SCALE;
        quoteAmount = _deductExitFees(
            Math.mulDiv(shares, quoteUnits * SHARE_SCALE + virtualAssets(), scaledSupply)
        );
        equityAmount = _deductExitFees(
            Math.mulDiv(shares, equityUnits * SHARE_SCALE + virtualAssets(), scaledSupply)
        );
        if (quoteAmount < minQuoteOut) revert SlippageExceeded(quoteAmount, minQuoteOut);
        if (equityAmount < minEquityOut) revert SlippageExceeded(equityAmount, minEquityOut);

        shareToken.burn(msg.sender, shares);
        if (quoteAmount != 0) {
            _ensureQuote(quoteAmount);
            quote.safeTransfer(receiver, quoteAmount);
        }
        if (equityAmount != 0) {
            _ensureEquity(equityAmount);
            equity.safeTransfer(receiver, equityAmount);
        }
        emit ProportionalUnwrapped(msg.sender, receiver, shares, quoteAmount, equityAmount);
    }

    // ---------------------------------------------------------------------
    // Composition & settlement
    // ---------------------------------------------------------------------

    function equityToQuote(uint256 equityAmount) external view returns (uint256) {
        return _equityUnitsToQuote(equityAmount, _oracleMid());
    }

    /// @notice Quote for the controller's bottom-layer swap floor check (0 when oracle invalid).
    function quoteToEquity(uint256 quoteAmount) external view returns (uint256) {
        return _quoteToEquityUnits(quoteAmount, _oracleMid());
    }

    /// @notice Oracle liveness probe for the bottom-layer switch policy (false when the
    ///         feed is stale or the equity market is closed).
    function oracleValid() external view returns (bool) {
        return _oracleMid() != 0;
    }

    /// @notice One-shot settlement after expiry. Pulls the book out of the hook, then hands the
    ///         senior guarantee first, remaining QUOTE plus all equity to junior, and freezes each
    ///         tranche's terminal rates. Permissionless once the guarantee is funded.
    ///         Logic lives in `LedgerSettlement` (delegatecall library, EIP-170 room).
    ///         The `settled` flag flips BEFORE delegating (checks-effects; strictly
    ///         stronger than the old in-body flip against reentrant pulls).
    function finalizeSettlement() external nonReentrant {
        if (!expired()) revert NotExpired();
        if (settled) revert AlreadySettled();
        settled = true;
        LedgerSettlement.finalize(
            hook, strategyModule, address(venue), aToken, shareToken, quote, equity, accountant, false
        );
    }

    /// @notice Owner escape hatch for a pathological book: settles with a senior haircut.
    function finalizeSettlementHaircut() external onlyOwner nonReentrant {
        if (!expired()) revert NotExpired();
        if (settled) revert AlreadySettled();
        settled = true;
        LedgerSettlement.finalize(
            hook, strategyModule, address(venue), aToken, shareToken, quote, equity, accountant, true
        );
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _managedUnits() internal view returns (uint256 quoteUnits, uint256 equityUnits) {
        quoteUnits = quote.balanceOf(address(this)) + hook.quoteIdle();
        equityUnits = equity.balanceOf(address(this)) + hook.equityIdle();
        if (address(aToken) != address(0)) quoteUnits += aToken.balanceOf(address(this));

        quoteUnits += hook.claims(address(quote));
        equityUnits += hook.claims(address(equity));

        (uint256 positionQuote, uint256 positionEquity) = _positionUnits();
        quoteUnits += positionQuote;
        equityUnits += positionEquity;
    }

    function _positionUnits() internal view returns (uint256 quoteUnits, uint256 equityUnits) {
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(hook.activePoolId());
        if (sqrtPriceX96 == 0) return (0, 0);
        bool quoteIs0 = Currency.unwrap(_venueKey.currency0) == address(quote);

        (int24 lo, int24 hi, uint128 liquidity) = hook.basePosition();
        if (liquidity != 0) {
            (uint256 a0, uint256 a1) = LiquidityAmounts.getAmountsForLiquidity(
                sqrtPriceX96, TickMath.getSqrtPriceAtTick(lo), TickMath.getSqrtPriceAtTick(hi), liquidity
            );
            if (quoteIs0) {
                quoteUnits += a0;
                equityUnits += a1;
            } else {
                quoteUnits += a1;
                equityUnits += a0;
            }
        }

        if (hook.guardPresent()) {
            (lo, hi, liquidity) = hook.guardPosition();
            if (liquidity != 0) {
                (uint256 b0, uint256 b1) = LiquidityAmounts.getAmountsForLiquidity(
                    sqrtPriceX96, TickMath.getSqrtPriceAtTick(lo), TickMath.getSqrtPriceAtTick(hi), liquidity
                );
                if (quoteIs0) {
                    quoteUnits += b0;
                    equityUnits += b1;
                } else {
                    quoteUnits += b1;
                    equityUnits += b0;
                }
            }
        }
    }

    function _ensureQuote(uint256 amount) internal {
        uint256 balance = quote.balanceOf(address(this));
        if (balance >= amount) return;

        uint256 shortfall = amount - balance;
        uint256 hookIdle = hook.quoteIdle();
        uint256 fromHook = shortfall < hookIdle ? shortfall : hookIdle;
        if (fromHook != 0) {
            hook.withdrawInventory(fromHook, 0);
        }

        balance = quote.balanceOf(address(this));
        if (balance < amount && address(venue) != address(0)) {
            _withdrawFromVenue(amount - balance);
            balance = quote.balanceOf(address(this));
        }
        if (balance < amount && strategyModule != address(0)) {
            IStrategyModule(strategyModule).pullToVault(amount - balance);
            balance = quote.balanceOf(address(this));
        }
        if (balance < amount && guardRecallOnWithdraw && hook.poolInitialized()) {
            hook.recallToVault();
            emit GuardRecalledForWithdrawal(amount - balance);
            balance = quote.balanceOf(address(this));
        }
        if (balance < amount) revert InsufficientQuote(amount, balance);
    }

    function _ensureEquity(uint256 amount) internal {
        uint256 balance = equity.balanceOf(address(this));
        if (balance >= amount) return;

        uint256 shortfall = amount - balance;
        uint256 hookIdle = hook.equityIdle();
        uint256 fromHook = shortfall < hookIdle ? shortfall : hookIdle;
        if (fromHook != 0) {
            hook.withdrawInventory(0, fromHook);
        }

        balance = equity.balanceOf(address(this));
        if (balance < amount && guardRecallOnWithdraw && hook.poolInitialized()) {
            hook.recallToVault();
            emit GuardRecalledForWithdrawal(amount - balance);
            balance = equity.balanceOf(address(this));
        }
        if (balance < amount) revert InsufficientEquity(amount, balance);
    }

    function _withdrawFromVenue(uint256 amount) internal returns (uint256 withdrawn) {
        if (address(venue) == address(0)) revert VenueUnset();
        withdrawn = venue.withdraw(address(quote), amount, address(this));
        // Medium: the old code ignored the venue's return — a shortfall silently
        // propagated into settlement. Fail closed here.
        if (withdrawn < amount) revert InsufficientQuote(amount, withdrawn);
        emit Withdrawn(withdrawn);
    }

    /// @notice H6 spot-vs-oracle band: reverts when the pool spot has been pumped
    ///         far from the oracle (thin-book manipulation). Skips when the band is
    ///         disabled or the book reports no deviation (uninitialized/stale).
    ///         Reads the book's own deviation (same oracle + slot0 math the guard
    ///         uses) instead of duplicating spot pricing here.
    function _requireSpotBand() internal view {
        uint16 maxDev = maxUnwrapDeviationBps;
        if (maxDev == 0) return;
        (bool ok, uint256 deviationBps) = hook.oracleDeviationBps();
        if (!ok) return;
        if (deviationBps > maxDev) revert SpotDeviation(deviationBps, maxDev);
    }

    function _oracleMid() internal view returns (uint256) {
        INVDAPriceOracle.PriceData memory data = INVDAPriceOracle(priceOracle).getPrice();
        if (!data.valid || data.mid <= 0) return 0;
        // Medium: mirror the hook's freshness gate on the pricing paths.
        uint32 maxAge = maxOracleAge;
        if (maxAge != 0) {
            if (data.updatedAt == 0 || data.updatedAt > block.timestamp) return 0;
            if (block.timestamp - data.updatedAt > maxAge) return 0;
        }
        return uint256(uint192(data.mid));
    }

    function _requireOracleMid() internal view returns (uint256 mid) {
        mid = _oracleMid();
        if (mid == 0) revert OracleInvalid();
    }

    function _equityUnitsToQuote(uint256 amount, uint256 mid) internal view returns (uint256) {
        if (mid == 0) return 0;
        return Math.mulDiv(amount, mid, 10 ** (oracleDecimals + equityDecimals - quoteDecimals));
    }

    function _quoteToEquityUnits(uint256 quoteAmount, uint256 mid) internal view returns (uint256) {
        return Math.mulDiv(quoteAmount, 10 ** (oracleDecimals + equityDecimals - quoteDecimals), mid);
    }
}

interface IERC20MetadataLite {
    function decimals() external view returns (uint8);
}

