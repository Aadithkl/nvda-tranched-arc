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
import { PoolId, PoolIdLibrary } from "v4-core/src/types/PoolId.sol";
import { Currency, CurrencyLibrary } from "v4-core/src/types/Currency.sol";
import { TickMath } from "v4-core/src/libraries/TickMath.sol";
import { StateLibrary } from "v4-core/src/libraries/StateLibrary.sol";
import { HookShareToken } from "../core/HookShareToken.sol";
import { IHookSharePipe } from "../interfaces/IHookSharePipe.sol";
import { ITrancheAccountant } from "../interfaces/ITrancheAccountant.sol";
import { ITrancheHookValue } from "../interfaces/ITrancheHookValue.sol";
import { INVDAPriceOracle } from "../interfaces/INVDAPriceOracle.sol";
import { PoolGuardHook } from "../hook/PoolGuardHook.sol";
import { IStrategyModule } from "../adapters/IStrategyModule.sol";
import { GuardParams } from "../hook/libraries/GuardParams.sol";
import { LiquidityAmounts } from "../hook/libraries/LiquidityAmounts.sol";

interface IMaturedVault {
    function creditSettlement(uint256 usdcAmount, uint256 equityAmount) external;
}

interface IVenuePool {
    function deposit(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

interface ISwapRouter {
    function swapExactIn(
        PoolKey calldata key,
        bool zeroForOne,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256 deadline
    ) external;
}

/// @notice Combined vault of the static-fee book: the tranche layer's share issuer, NAV/value
///         source, wrap/unwrap pipe, settlement engine and capital allocator â€” replacing both the
///         v3 hook-share duties and `TranchePipeModule`. It owns `PoolGuardHook` (hook admin is
///         proxied through the bounded functions below) and connects the unchanged
///         `TrancheVault`/`SeniorVault`/`JuniorVault`/`TrancheAccountant` flow to it.
///
///         Capital flow: deposits -> vault; vault decides how much sits in the hook (guard/base)
///         vs the lending venue; the hook pulls its guard on adverse flow by itself, and the vault
///         can recall it, pause deployments and park capital in lending whenever it wants.
contract RegimeVault is IHookSharePipe, ITrancheHookValue, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Math for uint256;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using CurrencyLibrary for Currency;

    // Share denomination. With 6-dec quote and virtual shares 1e3, this prices one quote unit at
    // 1e9 hook-shares (1e15 per dollar, 1e18 per dollar through the tranche vaults' offset), so
    // `TrancheVault.creditSettlement`'s 1e18 per-share rate keeps ~$0.001 precision.
    uint256 public constant SHARE_SCALE = 1e6;
    uint256 internal constant VIRTUAL_SHARES = 1e3;
    uint256 internal constant VIRTUAL_ASSETS = 1;
    uint16 public constant MAX_CONVERSION_FEE_BPS = 100;
    uint16 internal constant BPS = 10_000;

    IPoolManager public immutable poolManager;
    PoolGuardHook public immutable hook;
    HookShareToken public immutable shareToken;
    IERC20 public immutable usdc;
    IERC20 public immutable equity;
    address public immutable priceOracle;
    uint8 public immutable oracleDecimals;
    uint8 public immutable usdcDecimals;
    uint8 public immutable equityDecimals;
    uint64 public immutable expiry;

    address public keeper;
    address public accountant;
    uint16 public conversionFeeBps;
    bool public settled;
    /// @notice When true, redemptions that exhaust idle/hook/venue/strategy liquidity recall the
    ///         guard position (and claims) as a last resort. Base stays until halt/settlement.
    bool public guardRecallOnWithdraw = true;

    IVenuePool public venue;
    IERC20 public aToken;
    address public strategyModule;

    PoolKey internal _venueKey;
    address public rebalanceRouter;
    uint16 public maxRebalanceSlippageBps = 100;

    event KeeperUpdated(address indexed keeper);
    event AccountantUpdated(address indexed accountant);
    event VenueUpdated(address indexed venue, address indexed aToken);
    event StrategyModuleUpdated(address indexed module);
    event GuardRecallOnWithdrawSet(bool enabled);
    event GuardRecalledForWithdrawal(uint256 shortfall);
    event Halted(uint256 timestamp);
    event ConversionFeeBpsUpdated(uint16 bps);
    event HookFunded(uint256 quoteAmount, uint256 equityAmount);
    event UsdcWrapped(address indexed caller, address indexed receiver, uint256 usdcAmount, uint256 shares);
    event UsdcUnwrapped(address indexed caller, address indexed receiver, uint256 shares, uint256 usdcAmount);
    event EquityUnwrapped(address indexed caller, address indexed receiver, uint256 shares, uint256 equityAmount);
    event ProportionalUnwrapped(
        address indexed caller, address indexed receiver, uint256 shares, uint256 usdcAmount, uint256 equityAmount
    );
    event Supplied(uint256 amount);
    event Withdrawn(uint256 amount);
    event RebalanceVenueUpdated(address indexed router, bytes32 indexed poolId);
    event RebalancedSwap(bool equityOut, uint256 amountIn, uint256 amountOut);
    event SettlementFinalized(
        uint256 seniorShares, uint256 juniorShares, uint256 usdcToSenior, uint256 usdcToJunior, uint256 equityUnits
    );

    error ZeroAddress();
    error ZeroAmount();
    error NotKeeper(address caller);
    error NotOwnerOrKeeper(address caller);
    error TradingClosed();
    error OracleInvalid();
    error SlippageExceeded(uint256 received, uint256 minOut);
    error ConversionFeeTooHigh(uint16 feeBps);
    error VenueUnset();
    error InsufficientUsdc(uint256 requested, uint256 available);
    error InsufficientEquity(uint256 requested, uint256 available);
    error NotExpired();
    error AlreadySettled();
    error AccountantUnset();
    error VaultsUnset();
    error SettlementNotReady();
    error DeadlineExpired();
    error RebalanceVenueUnset();
    error SlippageBoundUnmet(uint256 minOut, uint256 oracleFloor);
    error RebalanceNotFunded();
    error InvalidOracleDecimals(uint8 decimals);

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert NotKeeper(msg.sender);
        _;
    }

    modifier onlyOwnerOrKeeper() {
        if (msg.sender != owner() && msg.sender != keeper) revert NotOwnerOrKeeper(msg.sender);
        _;
    }

    constructor(
        IPoolManager poolManager_,
        PoolGuardHook hook_,
        PoolKey memory key_,
        IERC20 usdc_,
        IERC20 equity_,
        address priceOracle_,
        uint64 expiry_,
        address owner_
    ) Ownable(owner_ == address(0) ? msg.sender : owner_) {
        if (
            address(poolManager_) == address(0) || address(hook_) == address(0) || address(usdc_) == address(0)
                || address(equity_) == address(0) || priceOracle_ == address(0)
        ) revert ZeroAddress();
        if (Currency.unwrap(key_.currency0) != address(usdc_) && Currency.unwrap(key_.currency1) != address(usdc_)) {
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
        usdc = usdc_;
        equity = equity_;
        priceOracle = priceOracle_;
        oracleDecimals = decimals_;
        usdcDecimals = IERC20MetadataLite(address(usdc_)).decimals();
        equityDecimals = IERC20MetadataLite(address(equity_)).decimals();
        expiry = expiry_;
        _venueKey = key_;
        shareToken = new HookShareToken(address(this), address(usdc_));
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
        if (bps > MAX_CONVERSION_FEE_BPS) revert ConversionFeeTooHigh(bps);
        conversionFeeBps = bps;
        emit ConversionFeeBpsUpdated(bps);
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
        usdc.forceApprove(module, module == address(0) ? 0 : type(uint256).max);
        equity.forceApprove(module, module == address(0) ? 0 : type(uint256).max);
        emit StrategyModuleUpdated(module);
    }

    function setGuardRecallOnWithdraw(bool enabled) external onlyOwner {
        guardRecallOnWithdraw = enabled;
        emit GuardRecallOnWithdrawSet(enabled);
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

    function setRebalanceVenue(PoolKey calldata key, address router) external onlyOwner {
        if (router == address(0)) revert ZeroAddress();
        _venueKey = key;
        rebalanceRouter = router;
        emit RebalanceVenueUpdated(router, PoolId.unwrap(key.toId()));
    }

    function setMaxRebalanceSlippageBps(uint16 bps) external onlyOwner {
        if (bps > 1_000) revert ConversionFeeTooHigh(bps);
        maxRebalanceSlippageBps = bps;
    }

    // ---------------------------------------------------------------------
    // Hook ownership & allocation
    // ---------------------------------------------------------------------

    function acceptHookOwnership() external onlyOwnerOrKeeper {
        hook.acceptOwnership();
    }

    function initializeHook(PoolKey calldata key, uint160 sqrtPriceX96) external onlyOwner {
        hook.initializeBook(key, sqrtPriceX96);
    }

    function setGuardParams(GuardParams.Params calldata params) external onlyOwnerOrKeeper {
        hook.setGuardParams(params);
    }

    function setHookDeployEnabled(bool enabled) external onlyOwnerOrKeeper {
        hook.setDeployEnabled(enabled);
    }

    function recenterGuard() external onlyOwnerOrKeeper {
        hook.recenterGuard();
    }

    function deployGuard() external onlyOwnerOrKeeper {
        hook.deployGuard();
    }

    function rearmHook() external onlyOwnerOrKeeper {
        hook.rearm();
    }

    /// @notice Pulls the guard and returns hook inventory to this vault; base stays deployed.
    function recallFromHook() external onlyOwnerOrKeeper {
        hook.recallToVault();
    }

    /// @notice Full protocol exit: pulls guard + base and sweeps everything here.
    function exitHook() external onlyOwner {
        hook.pullAll();
    }

    /// @notice Pushes vault capital into the hook's inventory for deployment.
    function fundHook(uint256 quoteAmount, uint256 equityAmount) external onlyOwnerOrKeeper {
        if (quoteAmount != 0) usdc.safeTransfer(address(hook), quoteAmount);
        if (equityAmount != 0) equity.safeTransfer(address(hook), equityAmount);
        emit HookFunded(quoteAmount, equityAmount);
    }

    // ---------------------------------------------------------------------
    // Yield venue
    // ---------------------------------------------------------------------

    function supplyIdle() external onlyOwnerOrKeeper returns (uint256 supplied) {
        if (address(venue) == address(0)) revert VenueUnset();
        supplied = usdc.balanceOf(address(this));
        if (supplied == 0) revert ZeroAmount();
        usdc.forceApprove(address(venue), supplied);
        venue.deposit(address(usdc), supplied, address(this), 0);
        emit Supplied(supplied);
    }

    function withdrawFromVenue(uint256 amount) external onlyOwnerOrKeeper returns (uint256 withdrawn) {
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
        value = quoteUnits + _equityUnitsToUsdc(equityUnits, _oracleMid());
    }

    function convertToShares(uint256 usdcAmount) public view returns (uint256) {
        return _convertToSharesWithTotal(usdcAmount, totalManagedAssets());
    }

    function _convertToSharesWithTotal(uint256 usdcAmount, uint256 totalBefore) internal view returns (uint256) {
        uint256 scaledTotal = totalBefore * SHARE_SCALE;
        return Math.mulDiv(
            usdcAmount * SHARE_SCALE, shareToken.totalSupply() + VIRTUAL_SHARES, scaledTotal + VIRTUAL_ASSETS
        );
    }

    function convertToUsdc(uint256 shares) public view returns (uint256) {
        uint256 scaledTotal = totalManagedAssets() * SHARE_SCALE;
        uint256 scaledSupply = (shareToken.totalSupply() + VIRTUAL_SHARES) * SHARE_SCALE;
        return Math.mulDiv(shares, scaledTotal + VIRTUAL_ASSETS, scaledSupply);
    }

    function wrapUSDC(uint256 usdcAmount, address receiver) external nonReentrant returns (uint256 shares) {
        if (expired()) revert TradingClosed();
        if (_oracleMid() == 0) revert OracleInvalid();
        if (usdcAmount == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        uint256 totalBefore = totalManagedAssets();
        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        shares = _convertToSharesWithTotal(usdcAmount, totalBefore);
        if (shares == 0) revert ZeroAmount();
        shareToken.mint(receiver, shares);
        emit UsdcWrapped(msg.sender, receiver, usdcAmount, shares);
    }

    function unwrapUSDC(uint256 shares, address receiver) external returns (uint256 usdcAmount) {
        return unwrapUSDC(shares, receiver, 0);
    }

    function unwrapUSDC(uint256 shares, address receiver, uint256 minUsdcOut)
        public
        nonReentrant
        returns (uint256 usdcAmount)
    {
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        if (_oracleMid() == 0) revert OracleInvalid();
        usdcAmount = convertToUsdc(shares);
        if (usdcAmount < minUsdcOut) revert SlippageExceeded(usdcAmount, minUsdcOut);
        shareToken.burn(msg.sender, shares);
        _ensureUsdc(usdcAmount);
        usdc.safeTransfer(receiver, usdcAmount);
        emit UsdcUnwrapped(msg.sender, receiver, shares, usdcAmount);
    }

    function unwrapEquity(uint256 shares, address receiver, uint256 minEquityOut)
        public
        nonReentrant
        returns (uint256 equityAmount)
    {
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        uint256 gross = _usdcToEquityUnits(convertToUsdc(shares), _requireOracleMid());
        equityAmount = gross - Math.mulDiv(gross, conversionFeeBps, BPS);
        if (equityAmount < minEquityOut) revert SlippageExceeded(equityAmount, minEquityOut);
        shareToken.burn(msg.sender, shares);
        _ensureEquity(equityAmount);
        equity.safeTransfer(receiver, equityAmount);
        emit EquityUnwrapped(msg.sender, receiver, shares, equityAmount);
    }

    function unwrapProportional(uint256 shares, address receiver, uint256 minUsdcOut, uint256 minEquityOut)
        public
        nonReentrant
        returns (uint256 usdcAmount, uint256 equityAmount)
    {
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        hook.unwindClaims();

        uint256 supply = shareToken.totalSupply();
        uint256 usdcUnits = usdc.balanceOf(address(this)) + usdc.balanceOf(address(hook));
        if (address(aToken) != address(0)) usdcUnits += aToken.balanceOf(address(this));
        uint256 equityUnits = equity.balanceOf(address(this)) + equity.balanceOf(address(hook));

        usdcAmount = Math.mulDiv(usdcUnits, shares, supply);
        equityAmount = Math.mulDiv(equityUnits, shares, supply);
        if (usdcAmount < minUsdcOut) revert SlippageExceeded(usdcAmount, minUsdcOut);
        if (equityAmount < minEquityOut) revert SlippageExceeded(equityAmount, minEquityOut);

        shareToken.burn(msg.sender, shares);
        if (usdcAmount != 0) {
            _ensureUsdc(usdcAmount);
            usdc.safeTransfer(receiver, usdcAmount);
        }
        if (equityAmount != 0) {
            _ensureEquity(equityAmount);
            equity.safeTransfer(receiver, equityAmount);
        }
        emit ProportionalUnwrapped(msg.sender, receiver, shares, usdcAmount, equityAmount);
    }

    // ---------------------------------------------------------------------
    // Rebalancing (agent/keeper driven venue swap)
    // ---------------------------------------------------------------------

    function rebalanceSwap(bool equityOut, uint256 amountIn, uint256 minOut, uint256 deadline)
        external
        onlyKeeper
        nonReentrant
    {
        if (expired()) revert TradingClosed();
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (rebalanceRouter == address(0)) revert RebalanceVenueUnset();
        if (amountIn == 0) revert ZeroAmount();
        if (!equityOut) {
            address acct = accountant;
            if (acct != address(0) && !ITrancheAccountant(acct).escrowFunded()) revert RebalanceNotFunded();
        }

        uint256 mid = _requireOracleMid();
        IERC20 tokenIn = equityOut ? equity : usdc;
        IERC20 tokenOut = equityOut ? usdc : equity;
        uint256 oracleOut = equityOut ? _equityUnitsToUsdc(amountIn, mid) : _usdcToEquityUnits(amountIn, mid);
        uint256 floor = Math.mulDiv(oracleOut, BPS - maxRebalanceSlippageBps, BPS);
        if (minOut < floor) revert SlippageBoundUnmet(minOut, floor);

        if (equityOut) _ensureEquity(amountIn);
        else _ensureUsdc(amountIn);

        uint256 before = tokenOut.balanceOf(address(this));
        tokenIn.forceApprove(rebalanceRouter, amountIn);
        ISwapRouter(rebalanceRouter)
            .swapExactIn(
                _venueKey,
                Currency.unwrap(_venueKey.currency0) == address(tokenIn),
                amountIn,
                minOut,
                address(this),
                deadline
            );
        tokenIn.forceApprove(rebalanceRouter, 0);
        uint256 amountOut = tokenOut.balanceOf(address(this)) - before;
        emit RebalancedSwap(equityOut, amountIn, amountOut);
    }

    // ---------------------------------------------------------------------
    // Composition & settlement
    // ---------------------------------------------------------------------

    function equityToUsdc(uint256 equityAmount) external view returns (uint256) {
        return _equityUnitsToUsdc(equityAmount, _oracleMid());
    }

    /// @notice One-shot settlement after expiry. Pulls the book out of the hook, then hands the
    ///         senior guarantee first, remaining USDC plus all equity to junior, and freezes each
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
            if (venueUnits != 0) venue.withdraw(address(usdc), venueUnits, address(this));
        }

        uint256 hSenior = shareToken.balanceOf(seniorVault);
        uint256 hJunior = shareToken.balanceOf(juniorVault);

        uint256 usdcUnits = usdc.balanceOf(address(this));
        uint256 equityUnits = equity.balanceOf(address(this));

        uint256 seniorGuarantee = accountant_.seniorGuaranteeUsdc();
        if (!allowHaircut && usdcUnits < seniorGuarantee) revert SettlementNotReady();

        uint256 usdcToSenior = usdcUnits < seniorGuarantee ? usdcUnits : seniorGuarantee;
        uint256 usdcToJunior = usdcUnits - usdcToSenior;

        settled = true;

        if (hSenior != 0) shareToken.burn(seniorVault, hSenior);
        if (hJunior != 0) shareToken.burn(juniorVault, hJunior);

        if (usdcToSenior != 0) usdc.safeTransfer(seniorVault, usdcToSenior);
        if (usdcToJunior != 0) usdc.safeTransfer(juniorVault, usdcToJunior);
        if (equityUnits != 0) equity.safeTransfer(juniorVault, equityUnits);

        IMaturedVault(seniorVault).creditSettlement(usdcToSenior, 0);
        IMaturedVault(juniorVault).creditSettlement(usdcToJunior, equityUnits);

        emit SettlementFinalized(hSenior, hJunior, usdcToSenior, usdcToJunior, equityUnits);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _managedUnits() internal view returns (uint256 quoteUnits, uint256 equityUnits) {
        quoteUnits = usdc.balanceOf(address(this)) + usdc.balanceOf(address(hook));
        equityUnits = equity.balanceOf(address(this)) + equity.balanceOf(address(hook));
        if (address(aToken) != address(0)) quoteUnits += aToken.balanceOf(address(this));

        quoteUnits += poolManager.balanceOf(address(hook), Currency.wrap(address(usdc)).toId());
        equityUnits += poolManager.balanceOf(address(hook), Currency.wrap(address(equity)).toId());

        (uint256 positionQuote, uint256 positionEquity) = _positionUnits();
        quoteUnits += positionQuote;
        equityUnits += positionEquity;
    }

    function _positionUnits() internal view returns (uint256 quoteUnits, uint256 equityUnits) {
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(hook.activePoolId());
        if (sqrtPriceX96 == 0) return (0, 0);
        bool quoteIs0 = Currency.unwrap(_venueKey.currency0) == address(usdc);

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

    function _ensureUsdc(uint256 amount) internal {
        uint256 balance = usdc.balanceOf(address(this));
        if (balance >= amount) return;

        uint256 shortfall = amount - balance;
        uint256 hookIdle = usdc.balanceOf(address(hook));
        uint256 fromHook = shortfall < hookIdle ? shortfall : hookIdle;
        if (fromHook != 0) {
            hook.withdrawInventory(fromHook, 0);
        }

        balance = usdc.balanceOf(address(this));
        if (balance < amount && address(venue) != address(0)) {
            _withdrawFromVenue(amount - balance);
            balance = usdc.balanceOf(address(this));
        }
        if (balance < amount && strategyModule != address(0)) {
            IStrategyModule(strategyModule).pullToVault(amount - balance);
            balance = usdc.balanceOf(address(this));
        }
        if (balance < amount && guardRecallOnWithdraw && hook.poolInitialized()) {
            hook.recallToVault();
            emit GuardRecalledForWithdrawal(amount - balance);
            balance = usdc.balanceOf(address(this));
        }
        if (balance < amount) revert InsufficientUsdc(amount, balance);
    }

    function _ensureEquity(uint256 amount) internal {
        uint256 balance = equity.balanceOf(address(this));
        if (balance >= amount) return;

        uint256 shortfall = amount - balance;
        uint256 hookIdle = equity.balanceOf(address(hook));
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
        withdrawn = venue.withdraw(address(usdc), amount, address(this));
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

    function _equityUnitsToUsdc(uint256 amount, uint256 mid) internal view returns (uint256) {
        if (mid == 0) return 0;
        return Math.mulDiv(amount, mid, 10 ** (oracleDecimals + equityDecimals - usdcDecimals));
    }

    function _usdcToEquityUnits(uint256 usdcAmount, uint256 mid) internal view returns (uint256) {
        return Math.mulDiv(usdcAmount, 10 ** (oracleDecimals + equityDecimals - usdcDecimals), mid);
    }
}

interface IERC20MetadataLite {
    function decimals() external view returns (uint8);
}

