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

interface IMaturedVault {
    function creditSettlement(uint256 quoteAmount, uint256 equityAmount) external;
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
    event SettlementFinalized(
        uint256 seniorShares, uint256 juniorShares, uint256 quoteToSenior, uint256 quoteToJunior, uint256 equityUnits
    );

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

    /// @notice Attaches the strategy module and grants it standing allowances (no per-call
    ///         approvals); set to zero to detach. Only the module's bounded roles can draw funds.
    function setStrategyModule(address module) external onlyOwner {
        strategyModule = module;
        quote.forceApprove(module, module == address(0) ? 0 : type(uint256).max);
        equity.forceApprove(module, module == address(0) ? 0 : type(uint256).max);
        emit StrategyModuleUpdated(module);
    }

    function setGuardRecallOnWithdraw(bool enabled) external onlyOwner {
        guardRecallOnWithdraw = enabled;
        emit GuardRecallOnWithdrawSet(enabled);
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

    function initializeHook(PoolKey calldata key, uint160 sqrtPriceX96) external onlyOwner {
        hook.initializeBook(key, sqrtPriceX96);
    }

    function setGuardParams(GuardParams.Params calldata params) external onlyKeeper {
        hook.setGuardParams(params);
    }

    function setHookDeployEnabled(bool enabled) external onlyKeeper {
        hook.setDeployEnabled(enabled);
    }

    function recenterGuard() external onlyKeeper {
        hook.recenterGuard();
    }

    function deployGuard() external onlyKeeper {
        hook.deployGuard();
    }

    function rearmHook() external onlyKeeper {
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

    function supplyIdle() external onlyKeeper returns (uint256 supplied) {
        if (address(venue) == address(0)) revert VenueUnset();
        supplied = quote.balanceOf(address(this));
        if (supplied == 0) revert ZeroAmount();
        quote.forceApprove(address(venue), supplied);
        venue.deposit(address(quote), supplied, address(this), 0);
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
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        if (_oracleMid() == 0) revert OracleInvalid();
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
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        uint256 gross = _quoteToEquityUnits(convertToQuote(shares), _requireOracleMid());
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
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        hook.unwindClaims();

        uint256 supply = shareToken.totalSupply();
        uint256 quoteUnits = quote.balanceOf(address(this)) + hook.quoteIdle();
        if (address(aToken) != address(0)) quoteUnits += aToken.balanceOf(address(this));
        uint256 equityUnits = equity.balanceOf(address(this)) + hook.equityIdle();

        quoteAmount = _deductExitFees(Math.mulDiv(quoteUnits, shares, supply));
        equityAmount = _deductExitFees(Math.mulDiv(equityUnits, shares, supply));
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
    function finalizeSettlement() external {
        _finalize(false);
    }

    /// @notice Owner escape hatch for a pathological book: settles with a senior haircut.
    function finalizeSettlementHaircut() external onlyOwner {
        _finalize(true);
    }

    function _finalize(bool allowHaircut) internal nonReentrant {
        if (!expired()) revert NotExpired();
        if (settled) revert AlreadySettled();
        address acct = accountant;
        if (acct == address(0)) revert AccountantUnset();
        ITrancheAccountant accountant_ = ITrancheAccountant(acct);
        address seniorVault = accountant_.seniorVault();
        address juniorVault = accountant_.juniorVault();
        if (seniorVault == address(0) || juniorVault == address(0)) revert VaultsUnset();

        hook.unwindClaims();
        if (!hook.exited()) hook.pullAll();

        if (strategyModule != address(0)) IStrategyModule(strategyModule).exitAll();

        if (address(venue) != address(0)) {
            uint256 venueUnits = aToken.balanceOf(address(this));
            if (venueUnits != 0) venue.withdraw(address(quote), venueUnits, address(this));
        }

        uint256 hSenior = shareToken.balanceOf(seniorVault);
        uint256 hJunior = shareToken.balanceOf(juniorVault);

        uint256 quoteUnits = quote.balanceOf(address(this));
        uint256 equityUnits = equity.balanceOf(address(this));

        uint256 seniorGuarantee = accountant_.seniorGuaranteeQuote();
        if (!allowHaircut && quoteUnits < seniorGuarantee) revert SettlementNotReady();

        uint256 quoteToSenior = quoteUnits < seniorGuarantee ? quoteUnits : seniorGuarantee;
        uint256 quoteToJunior = quoteUnits - quoteToSenior;

        settled = true;

        if (hSenior != 0) shareToken.burn(seniorVault, hSenior);
        if (hJunior != 0) shareToken.burn(juniorVault, hJunior);

        if (quoteToSenior != 0) quote.safeTransfer(seniorVault, quoteToSenior);
        if (quoteToJunior != 0) quote.safeTransfer(juniorVault, quoteToJunior);
        if (equityUnits != 0) equity.safeTransfer(juniorVault, equityUnits);

        IMaturedVault(seniorVault).creditSettlement(quoteToSenior, 0);
        IMaturedVault(juniorVault).creditSettlement(quoteToJunior, equityUnits);

        emit SettlementFinalized(hSenior, hJunior, quoteToSenior, quoteToJunior, equityUnits);
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
        emit Withdrawn(withdrawn);
    }

    function _oracleMid() internal view returns (uint256) {
        INVDAPriceOracle.PriceData memory data = INVDAPriceOracle(priceOracle).getPrice();
        if (!data.valid || data.mid <= 0) return 0;
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

