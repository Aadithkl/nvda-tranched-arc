// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { BaseHook } from "uniswap-hooks/base/BaseHook.sol";
import { IHooks } from "v4-core/src/interfaces/IHooks.sol";
import { IPoolManager } from "v4-core/src/interfaces/IPoolManager.sol";
import { Hooks } from "v4-core/src/libraries/Hooks.sol";
import { LPFeeLibrary } from "v4-core/src/libraries/LPFeeLibrary.sol";
import { StateLibrary } from "v4-core/src/libraries/StateLibrary.sol";
import { PoolKey } from "v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "v4-core/src/types/PoolId.sol";
import { Currency } from "v4-core/src/types/Currency.sol";
import { SwapParams, ModifyLiquidityParams } from "v4-core/src/types/PoolOperation.sol";
import { BeforeSwapDelta, BeforeSwapDeltaLibrary } from "v4-core/src/types/BeforeSwapDelta.sol";
import { BalanceDelta } from "v4-core/src/types/BalanceDelta.sol";
import { HookShareToken } from "../core/HookShareToken.sol";
import { IHookSharePipe } from "../interfaces/IHookSharePipe.sol";
import { INVDAPriceOracle } from "../interfaces/INVDAPriceOracle.sol";
import { ITrancheAccountant } from "../interfaces/ITrancheAccountant.sol";
import { IAaveV2Pool } from "../lending/interfaces/IAaveV2Pool.sol";
import { IAToken } from "../lending/interfaces/IAToken.sol";
import { HookParams } from "./libraries/HookParams.sol";

contract TrancheJITHook is BaseHook, IHookSharePipe {
    using SafeERC20 for IERC20;
    using Math for uint256;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using LPFeeLibrary for uint24;

    uint256 public constant BPS = 10_000;
    uint256 public constant SHARE_SCALE = 1e12;
    uint256 public constant DEGRADED_DIVISOR = 4;
    uint256 internal constant Q192 = 1 << 192;

    enum QuoteState {
        Rest,
        Degraded,
        Active
    }

    IERC20 public immutable usdc;
    uint8 public immutable usdcDecimals;
    IERC20 public immutable equity;
    uint8 public immutable equityDecimals;
    HookShareToken public immutable shareToken;

    address public owner;
    address public guardian;
    address public controller;
    address public priceOracle;
    address public lendingPool;
    IAToken public aToken;
    address public accountant;

    bool public paused;
    bool public liquidityGuardEnabled;
    bool public poolInitialized;

    PoolKey private _activeKey;
    bytes32 public activePoolId;
    HookParams.Params private _params;
    uint256 public paramsUpdatedAt;
    uint256 public lastQuotedAt;

    event OwnerUpdated(address indexed owner);
    event GuardianUpdated(address indexed guardian);
    event ControllerUpdated(address indexed controller);
    event PriceOracleUpdated(address indexed priceOracle);
    event LendingPoolUpdated(address indexed lendingPool, address indexed aToken);
    event AccountantUpdated(address indexed accountant);
    event PausedSet(bool paused);
    event LiquidityGuardSet(bool enabled);
    event ActivePoolSet(bytes32 indexed poolId);
    event ParamsUpdated(HookParams.Params params, uint256 updatedAt);
    event BaseFeeUpdated(uint24 baseFee, uint256 updatedAt);
    event QuotingEnabledSet(bool enabled);
    event SwapQuoted(
        bytes32 indexed poolId,
        address indexed sender,
        bool zeroForOne,
        uint16 deviationBps,
        uint24 fee,
        bool toxic,
        QuoteState state
    );
    event SharesWrapped(address indexed caller, address indexed receiver, uint256 usdcAmount, uint256 shares);
    event SharesUnwrapped(address indexed caller, address indexed receiver, uint256 shares, uint256 usdcAmount);
    event SuppliedToAave(uint256 amount);
    event WithdrawnFromAave(uint256 amount);

    error NotOwner(address caller);
    error NotGuardianOrOwner(address caller);
    error NotController(address caller);
    error ZeroAddress();
    error ZeroAmount();
    error InvalidPoolKey();
    error UnauthorizedInitialization(address caller);
    error NotDynamicFee();
    error OracleInvalid();
    error DeviationTooHigh(uint16 deviationBps);
    error QuotingOff();
    error CooldownActive();
    error NotEvPositive(uint24 fee);
    error ExternalLiquidityDisabled(address sender);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    modifier onlyController() {
        if (msg.sender != controller) revert NotController(msg.sender);
        _;
    }

    constructor(
        IPoolManager poolManager_,
        IERC20 usdc_,
        IERC20 equity_,
        address priceOracle_,
        address owner_,
        address controller_
    ) BaseHook(poolManager_) {
        if (
            address(usdc_) == address(0) || address(equity_) == address(0) || priceOracle_ == address(0)
                || controller_ == address(0)
        ) revert ZeroAddress();
        usdc = usdc_;
        usdcDecimals = IERC20Metadata(address(usdc_)).decimals();
        equity = equity_;
        equityDecimals = IERC20Metadata(address(equity_)).decimals();
        priceOracle = priceOracle_;
        owner = owner_ == address(0) ? msg.sender : owner_;
        guardian = owner;
        controller = controller_;
        shareToken = new HookShareToken(address(this), address(usdc_));

        emit OwnerUpdated(owner);
        emit GuardianUpdated(guardian);
        emit ControllerUpdated(controller_);
        emit PriceOracleUpdated(priceOracle_);
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory permissions) {
        permissions.beforeInitialize = true;
        permissions.beforeAddLiquidity = true;
        permissions.beforeRemoveLiquidity = true;
        permissions.beforeSwap = true;
        permissions.afterSwap = true;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        owner = newOwner;
        emit OwnerUpdated(newOwner);
    }

    function setGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert ZeroAddress();
        guardian = newGuardian;
        emit GuardianUpdated(newGuardian);
    }

    function setController(address newController) external onlyOwner {
        if (newController == address(0)) revert ZeroAddress();
        controller = newController;
        emit ControllerUpdated(newController);
    }

    function setPriceOracle(address newOracle) external onlyOwner {
        if (newOracle == address(0)) revert ZeroAddress();
        priceOracle = newOracle;
        emit PriceOracleUpdated(newOracle);
    }

    function setLendingPool(address pool) external onlyOwner {
        if (pool == address(0)) revert ZeroAddress();
        lendingPool = pool;
        aToken = IAToken(IAaveV2Pool(pool).getReserveData(address(usdc)).aTokenAddress);
        emit LendingPoolUpdated(pool, address(aToken));
    }

    function setAccountant(address newAccountant) external onlyOwner {
        accountant = newAccountant;
        emit AccountantUpdated(newAccountant);
    }

    function setPaused(bool paused_) external {
        if (msg.sender != owner && msg.sender != guardian) revert NotGuardianOrOwner(msg.sender);
        paused = paused_;
        emit PausedSet(paused_);
    }

    function setLiquidityGuard(bool enabled) external onlyOwner {
        liquidityGuardEnabled = enabled;
        emit LiquidityGuardSet(enabled);
    }

    function initializePool(PoolKey calldata key, uint160 sqrtPriceX96) external onlyOwner returns (int24 tick) {
        if (key.hooks != IHooks(address(this))) revert InvalidPoolKey();
        if (!key.fee.isDynamicFee()) revert NotDynamicFee();
        tick = poolManager.initialize(key, sqrtPriceX96);
        _activatePool(key);
    }

    function setActivePool(PoolKey calldata key) external onlyOwner {
        if (key.hooks != IHooks(address(this))) revert InvalidPoolKey();
        _activatePool(key);
    }

    function activePool() external view returns (PoolKey memory) {
        return _activeKey;
    }

    function setParams(HookParams.Params calldata newParams) external onlyController {
        HookParams.validate(newParams);
        _params = newParams;
        paramsUpdatedAt = block.timestamp;
        if (poolInitialized) poolManager.updateDynamicLPFee(_activeKey, newParams.baseFee);
        emit ParamsUpdated(newParams, block.timestamp);
    }

    function setBaseFee(uint24 baseFee) external onlyController {
        if (baseFee > _params.maxSurgeFee) revert HookParams.InvalidSurgeFee(_params.maxSurgeFee, baseFee);
        _params.baseFee = baseFee;
        paramsUpdatedAt = block.timestamp;
        if (poolInitialized) poolManager.updateDynamicLPFee(_activeKey, baseFee);
        emit BaseFeeUpdated(baseFee, block.timestamp);
    }

    function setQuotingEnabled(bool enabled) external onlyController {
        _params.quotingEnabled = enabled;
        paramsUpdatedAt = block.timestamp;
        emit QuotingEnabledSet(enabled);
    }

    function params() external view returns (HookParams.Params memory) {
        return _params;
    }

    function quoteState() public view returns (QuoteState) {
        HookParams.Params storage p = _params;
        if (paused || !p.quotingEnabled || !poolInitialized) return QuoteState.Rest;
        uint256 expiresAt = paramsUpdatedAt + p.ttl;
        if (block.timestamp <= expiresAt) return QuoteState.Active;
        if (block.timestamp <= expiresAt + p.gracePeriod) return QuoteState.Degraded;
        return QuoteState.Rest;
    }

    function riskBudget() public view returns (uint256) {
        address acct = accountant;
        if (acct == address(0)) return 0;
        ITrancheAccountant trancheAccountant = ITrancheAccountant(acct);
        if (!trancheAccountant.escrowFunded()) return 0;
        return trancheAccountant.juniorClaim();
    }

    function effectiveMaxDeploy() public view returns (uint256) {
        QuoteState state = quoteState();
        if (state == QuoteState.Rest) return 0;
        uint256 cap = _params.maxDeployPerSwap;
        if (state == QuoteState.Degraded) cap /= DEGRADED_DIVISOR;
        uint256 budget = riskBudget();
        return cap < budget ? cap : budget;
    }

    function totalManagedAssets() public view returns (uint256) {
        uint256 supplied = address(aToken) == address(0) ? 0 : aToken.balanceOf(address(this));
        return supplied + usdc.balanceOf(address(this));
    }

    function convertToShares(uint256 usdcAmount) public view returns (uint256) {
        uint256 total = totalManagedAssets();
        uint256 supply = shareToken.totalSupply();
        if (supply == 0 || total == 0) return usdcAmount * SHARE_SCALE;
        return Math.mulDiv(usdcAmount, supply, total);
    }

    function convertToUsdc(uint256 shares) public view returns (uint256) {
        uint256 supply = shareToken.totalSupply();
        if (supply == 0) return 0;
        return Math.mulDiv(shares, totalManagedAssets(), supply);
    }

    function wrapUSDC(uint256 usdcAmount, address receiver) external returns (uint256 shares) {
        if (usdcAmount == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        uint256 totalBefore = totalManagedAssets();
        uint256 supply = shareToken.totalSupply();
        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        shares =
            (supply == 0 || totalBefore == 0) ? usdcAmount * SHARE_SCALE : Math.mulDiv(usdcAmount, supply, totalBefore);
        shareToken.mint(receiver, shares);
        _supplyIdleToAave();
        emit SharesWrapped(msg.sender, receiver, usdcAmount, shares);
    }

    function unwrapUSDC(uint256 shares, address receiver) external returns (uint256 usdcAmount) {
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        usdcAmount = Math.mulDiv(shares, totalManagedAssets(), shareToken.totalSupply());
        shareToken.burn(msg.sender, shares);
        _withdrawFromAave(usdcAmount);
        if (usdcAmount != 0) usdc.safeTransfer(receiver, usdcAmount);
        emit SharesUnwrapped(msg.sender, receiver, shares, usdcAmount);
    }

    function previewQuote(bool zeroForOne)
        external
        view
        returns (uint24 fee, bool toxic, uint16 deviationBps, QuoteState state)
    {
        state = quoteState();
        (fee, toxic, deviationBps) = _quoteWithGates(zeroForOne);
    }

    function _quoteWithGates(bool zeroForOne) internal view returns (uint24 fee, bool toxic, uint16 deviationBps) {
        if (quoteState() == QuoteState.Rest) revert QuotingOff();
        if (block.timestamp < lastQuotedAt + _params.cooldownSeconds) revert CooldownActive();
        (fee, toxic, deviationBps) = _quoteFee(zeroForOne);
        if (fee < uint24(_params.minEvBps) * 100) revert NotEvPositive(fee);
    }

    function _supplyIdleToAave() internal {
        address pool = lendingPool;
        if (pool == address(0)) return;
        uint256 idle = usdc.balanceOf(address(this));
        if (idle == 0) return;
        usdc.forceApprove(pool, idle);
        IAaveV2Pool(pool).deposit(address(usdc), idle, address(this), 0);
        emit SuppliedToAave(idle);
    }

    function _withdrawFromAave(uint256 amount) internal returns (uint256 available) {
        address pool = lendingPool;
        if (amount == 0 || pool == address(0)) return 0;
        uint256 idle = usdc.balanceOf(address(this));
        if (idle >= amount) return idle;
        uint256 withdrawn = IAaveV2Pool(pool).withdraw(address(usdc), amount - idle, address(this));
        emit WithdrawnFromAave(withdrawn);
        return idle + withdrawn;
    }

    function _activatePool(PoolKey calldata key) internal {
        _activeKey = key;
        activePoolId = PoolId.unwrap(key.toId());
        poolInitialized = true;
        emit ActivePoolSet(activePoolId);
    }

    function _checkActivePool(PoolKey calldata key) internal view {
        if (!poolInitialized || PoolId.unwrap(key.toId()) != activePoolId || key.hooks != IHooks(address(this))) {
            revert InvalidPoolKey();
        }
    }

    function _quoteFee(bool zeroForOne) internal view returns (uint24 fee, bool toxic, uint16 deviationBps) {
        (uint256 poolUsd, uint256 oracleUsd) = _prices();
        deviationBps = _deviationBps(poolUsd, oracleUsd);
        if (deviationBps > _params.maxDeviationBps) revert DeviationTooHigh(deviationBps);
        toxic = _isToxic(zeroForOne, poolUsd, oracleUsd);
        if (!toxic) return (_params.baseFee, false, deviationBps);

        uint256 premium = uint256(deviationBps) * _params.toxicityMultiplierBps;
        uint256 surged = uint256(_params.baseFee) + premium;
        fee = uint24(Math.min(surged, uint256(_params.maxSurgeFee)));
    }

    function _prices() internal view returns (uint256 poolUsdPerEquity1e18, uint256 oracleUsdPerEquity1e18) {
        INVDAPriceOracle.PriceData memory data = INVDAPriceOracle(priceOracle).getPrice();
        if (!data.valid || data.mid <= 0) revert OracleInvalid();
        oracleUsdPerEquity1e18 = uint256(uint192(data.mid)) * 1e10;

        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(PoolId.wrap(activePoolId));
        if (sqrtPriceX96 == 0) revert OracleInvalid();
        poolUsdPerEquity1e18 = _poolPrice1e18(sqrtPriceX96);
    }

    function _poolPrice1e18(uint160 sqrtPriceX96) internal view returns (uint256) {
        uint256 ratioX192 = uint256(sqrtPriceX96) * uint256(sqrtPriceX96);
        uint256 scaledEquity = 1e18 * (10 ** equityDecimals);
        uint256 scaledUsdc = 10 ** usdcDecimals;
        if (Currency.unwrap(_activeKey.currency1) == address(equity)) {
            return Math.mulDiv(scaledEquity, Q192, ratioX192 * scaledUsdc);
        }
        return Math.mulDiv(ratioX192, scaledEquity, Q192 * scaledUsdc);
    }

    function _isToxic(bool zeroForOne, uint256 poolUsd, uint256 oracleUsd) internal view returns (bool) {
        bool equityIsToken1 = Currency.unwrap(_activeKey.currency1) == address(equity);
        bool buyingEquity = equityIsToken1 ? zeroForOne : !zeroForOne;
        return buyingEquity ? poolUsd < oracleUsd : poolUsd > oracleUsd;
    }

    function _deviationBps(uint256 poolUsd, uint256 oracleUsd) internal pure returns (uint16) {
        uint256 diff = poolUsd > oracleUsd ? poolUsd - oracleUsd : oracleUsd - poolUsd;
        uint256 bps = Math.mulDiv(diff, BPS, oracleUsd);
        return bps > type(uint16).max ? type(uint16).max : uint16(bps);
    }

    function _beforeInitialize(address sender, PoolKey calldata, uint160) internal pure override returns (bytes4) {
        revert UnauthorizedInitialization(sender);
    }

    function _beforeAddLiquidity(address sender, PoolKey calldata key, ModifyLiquidityParams calldata, bytes calldata)
        internal
        view
        override
        returns (bytes4)
    {
        _checkActivePool(key);
        if (liquidityGuardEnabled && sender != address(this)) revert ExternalLiquidityDisabled(sender);
        return this.beforeAddLiquidity.selector;
    }

    function _beforeRemoveLiquidity(
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata,
        bytes calldata
    ) internal view override returns (bytes4) {
        _checkActivePool(key);
        if (liquidityGuardEnabled && sender != address(this)) revert ExternalLiquidityDisabled(sender);
        return this.beforeRemoveLiquidity.selector;
    }

    function _beforeSwap(address sender, PoolKey calldata key, SwapParams calldata swapParams, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        _checkActivePool(key);
        QuoteState state = quoteState();
        (uint24 fee, bool toxic, uint16 deviationBps) = _quoteWithGates(swapParams.zeroForOne);

        lastQuotedAt = block.timestamp;
        emit SwapQuoted(activePoolId, sender, swapParams.zeroForOne, deviationBps, fee, toxic, state);
        return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    function _afterSwap(address, PoolKey calldata key, SwapParams calldata, BalanceDelta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        _checkActivePool(key);
        return (this.afterSwap.selector, 0);
    }
}
