// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { IPoolManager } from "v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "v4-core/src/types/PoolId.sol";
import { Currency, CurrencyLibrary } from "v4-core/src/types/Currency.sol";
import { BalanceDelta } from "v4-core/src/types/BalanceDelta.sol";
import { IHookSharePipe } from "../interfaces/IHookSharePipe.sol";
import { INVDAPriceOracle } from "../interfaces/INVDAPriceOracle.sol";
import { ITrancheAccountant } from "../interfaces/ITrancheAccountant.sol";
import { IAToken } from "../lending/interfaces/IAToken.sol";
import { TrancheJITHook } from "../hook/TrancheJITHook.sol";
import { HookShareToken } from "../core/HookShareToken.sol";

interface IMaturedVault {
    function creditSettlement(uint256 usdcAmount, uint256 equityAmount) external;
}

interface IDemoRouter {
    function swapExactIn(
        PoolKey calldata key,
        bool zeroForOne,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256 deadline
    ) external returns (BalanceDelta delta);
}

/// @notice Dual-token pipe + rebalancing periphery for TrancheJITHook. Keeps the hook under
///         EIP-170 by owning the exit and rebalance logic; the hook only exposes privileged
///         primitives (`modulePull`, `moduleBurn`, `moduleSupplyIdle`).
contract TranchePipeModule is IHookSharePipe, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Math for uint256;
    using CurrencyLibrary for Currency;
    using PoolIdLibrary for PoolKey;

    uint256 public constant BPS = 10_000;
    uint16 public constant MAX_HARD_EQUITY_BPS = 9_500;
    uint16 public constant MAX_CONVERSION_FEE_BPS = 100;
    uint16 public constant MAX_REBALANCE_SLIPPAGE_BPS = 1_000;

    TrancheJITHook public immutable hook;
    IERC20 public immutable usdc;
    IERC20 public immutable equity;
    uint8 public immutable usdcDecimals;
    uint8 public immutable equityDecimals;

    address public controller;
    uint16 public hardMaxEquityBps = 7_500;
    uint16 public conversionFeeBps;
    uint16 public maxRebalanceSlippageBps = 100;
    address public rebalanceRouter;
    bool public rebalanceVenueSet;
    bool public settled;
    PoolKey private _rebalanceKey;

    event ControllerUpdated(address indexed controller);
    event HardMaxEquityBpsUpdated(uint16 hardMaxEquityBps);
    event ConversionFeeBpsUpdated(uint16 conversionFeeBps);
    event MaxRebalanceSlippageBpsUpdated(uint16 maxRebalanceSlippageBps);
    event RebalanceVenueUpdated(address indexed router, bytes32 indexed poolId);
    event UsdcWrapped(address indexed caller, address indexed receiver, uint256 usdcAmount, uint256 shares);
    event UsdcUnwrapped(address indexed caller, address indexed receiver, uint256 shares, uint256 usdcAmount);
    event EquityUnwrapped(address indexed caller, address indexed receiver, uint256 shares, uint256 equityAmount);
    event ProportionalUnwrapped(
        address indexed caller, address indexed receiver, uint256 shares, uint256 usdcAmount, uint256 equityAmount
    );
    event Rebalanced(bool indexed equityOut, uint256 amountIn, uint256 amountOut, uint256 equityBpsAfter);
    event SettlementSwapped(uint256 equityIn, uint256 usdcOut);
    event SettlementFinalized(
        uint256 seniorHookShares,
        uint256 juniorHookShares,
        uint256 usdcToSenior,
        uint256 usdcToJunior,
        uint256 equityToJunior
    );

    error NotController(address caller);
    error ZeroAddress();
    error ZeroAmount();
    error DeadlineExpired();
    error OracleInvalid();
    error OracleStale(uint256 updatedAt);
    error SlippageExceeded(uint256 received, uint256 minOut);
    error SlippageBoundUnmet(uint256 minOut, uint256 oracleFloor);
    error RebalanceVenueUnset();
    error RebalanceKeyMismatch();
    error RebalanceNotFunded();
    error ConversionFeeTooHigh(uint16 feeBps);
    error InvalidHardCap(uint16 hardMaxEquityBps);
    error InvalidSlippageBps(uint16 maxRebalanceSlippageBps);
    error EquityCapExceeded(uint256 equityBps, uint256 hardMaxEquityBps);
    error TradingClosed();
    error NotExpired();
    error AlreadySettled();
    error SettlementNotReady();
    error AccountantUnset();
    error VaultsUnset();

    modifier onlyController() {
        if (msg.sender != controller) revert NotController(msg.sender);
        _;
    }

    constructor(address hook_, address owner_) Ownable(owner_ == address(0) ? msg.sender : owner_) {
        if (hook_ == address(0)) revert ZeroAddress();
        TrancheJITHook h = TrancheJITHook(hook_);
        hook = h;
        usdc = h.usdc();
        equity = h.equity();
        usdcDecimals = h.usdcDecimals();
        equityDecimals = h.equityDecimals();
    }

    function setController(address controller_) external onlyOwner {
        if (controller_ == address(0)) revert ZeroAddress();
        controller = controller_;
        emit ControllerUpdated(controller_);
    }

    function setHardMaxEquityBps(uint16 bps) external onlyOwner {
        if (bps > MAX_HARD_EQUITY_BPS) revert InvalidHardCap(bps);
        hardMaxEquityBps = bps;
        emit HardMaxEquityBpsUpdated(bps);
    }

    function setConversionFeeBps(uint16 bps) external onlyOwner {
        if (bps > MAX_CONVERSION_FEE_BPS) revert ConversionFeeTooHigh(bps);
        conversionFeeBps = bps;
        emit ConversionFeeBpsUpdated(bps);
    }

    function setMaxRebalanceSlippageBps(uint16 bps) external onlyOwner {
        if (bps > MAX_REBALANCE_SLIPPAGE_BPS) revert InvalidSlippageBps(bps);
        maxRebalanceSlippageBps = bps;
        emit MaxRebalanceSlippageBpsUpdated(bps);
    }

    function setRebalanceVenue(PoolKey calldata key, address router) external onlyOwner {
        if (router == address(0)) {
            rebalanceRouter = address(0);
            rebalanceVenueSet = false;
            emit RebalanceVenueUpdated(address(0), bytes32(0));
            return;
        }
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        bool pairOk = (c0 == address(usdc) && c1 == address(equity)) || (c0 == address(equity) && c1 == address(usdc));
        if (!pairOk || address(key.hooks) != address(0)) revert RebalanceKeyMismatch();
        rebalanceRouter = router;
        _rebalanceKey = key;
        rebalanceVenueSet = true;
        emit RebalanceVenueUpdated(router, PoolId.unwrap(key.toId()));
    }

    function assetComposition() external view returns (uint256 usdcValue, uint256 equityValue, uint256 equityBps) {
        return _composition(_requireOracle());
    }

    function equityToUsdc(uint256 equityAmount) external view returns (uint256) {
        return _equityUnitsToUsdc(equityAmount, _requireOracle());
    }

    function wrapUSDC(uint256 usdcAmount, address receiver) external nonReentrant returns (uint256 shares) {
        if (hook.expired()) revert TradingClosed();
        if (usdcAmount == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        usdc.forceApprove(address(hook), usdcAmount);
        shares = hook.wrapUSDC(usdcAmount, receiver);
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
        usdcAmount = hook.convertToUsdc(shares);
        if (usdcAmount < minUsdcOut) revert SlippageExceeded(usdcAmount, minUsdcOut);
        hook.moduleBurn(msg.sender, shares);
        hook.modulePull(usdc, receiver, usdcAmount);
        emit UsdcUnwrapped(msg.sender, receiver, shares, usdcAmount);
    }

    function unwrapEquity(uint256 shares, address receiver, uint256 minEquityOut)
        public
        nonReentrant
        returns (uint256 equityAmount)
    {
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        uint256 mid = _requireOracle();
        uint256 gross = _usdcToEquityUnits(hook.convertToUsdc(shares), mid);
        equityAmount = gross - Math.mulDiv(gross, conversionFeeBps, BPS);
        if (equityAmount < minEquityOut) revert SlippageExceeded(equityAmount, minEquityOut);
        hook.moduleBurn(msg.sender, shares);
        hook.modulePull(equity, receiver, equityAmount);
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

        uint256 supply = hook.shareToken().totalSupply();
        uint256 usdcUnits = usdc.balanceOf(address(hook)) + hook.aToken().balanceOf(address(hook));
        uint256 equityUnits = equity.balanceOf(address(hook));
        if (address(hook.aTokenEquity()) != address(0)) {
            equityUnits += hook.aTokenEquity().balanceOf(address(hook));
        }

        usdcAmount = Math.mulDiv(usdcUnits, shares, supply);
        equityAmount = Math.mulDiv(equityUnits, shares, supply);
        if (usdcAmount < minUsdcOut) revert SlippageExceeded(usdcAmount, minUsdcOut);
        if (equityAmount < minEquityOut) revert SlippageExceeded(equityAmount, minEquityOut);

        hook.moduleBurn(msg.sender, shares);
        if (usdcAmount != 0) hook.modulePull(usdc, receiver, usdcAmount);
        if (equityAmount != 0) hook.modulePull(equity, receiver, equityAmount);
        emit ProportionalUnwrapped(msg.sender, receiver, shares, usdcAmount, equityAmount);
    }

    function rebalanceSwap(bool equityOut, uint256 amountIn, uint256 minOut, uint256 deadline)
        external
        onlyController
        nonReentrant
    {
        if (hook.expired()) revert TradingClosed();
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (!rebalanceVenueSet) revert RebalanceVenueUnset();
        if (amountIn == 0) revert ZeroAmount();
        if (!equityOut) {
            address acct = hook.accountant();
            if (acct != address(0) && !ITrancheAccountant(acct).escrowFunded()) revert RebalanceNotFunded();
        }

        uint256 mid = _requireOracle();
        IERC20 tokenIn = equityOut ? equity : usdc;
        IERC20 tokenOut = equityOut ? usdc : equity;

        uint256 oracleOut = equityOut ? _equityUnitsToUsdc(amountIn, mid) : _usdcToEquityUnits(amountIn, mid);
        uint256 floor = Math.mulDiv(oracleOut, BPS - maxRebalanceSlippageBps, BPS);
        if (minOut < floor) revert SlippageBoundUnmet(minOut, floor);

        hook.modulePull(tokenIn, address(this), amountIn);

        uint256 before = tokenOut.balanceOf(address(this));
        PoolKey memory venueKey = _rebalanceKey;
        bool zeroForOne = Currency.unwrap(venueKey.currency0) == address(tokenIn);
        tokenIn.forceApprove(rebalanceRouter, amountIn);
        IDemoRouter(rebalanceRouter).swapExactIn(venueKey, zeroForOne, amountIn, minOut, address(this), deadline);
        tokenIn.forceApprove(rebalanceRouter, 0);
        uint256 amountOut = tokenOut.balanceOf(address(this)) - before;
        tokenOut.safeTransfer(address(hook), amountOut);
        hook.moduleSupplyIdle();

        (,, uint256 equityBpsAfter) = _composition(mid);
        if (!equityOut && equityBpsAfter > hardMaxEquityBps) {
            revert EquityCapExceeded(equityBpsAfter, hardMaxEquityBps);
        }
        emit Rebalanced(equityOut, amountIn, amountOut, equityBpsAfter);
    }

    /// @notice Post-expiry settlement swap: sells equity inventory for USDC so the senior
    ///         guarantee can be paid. Permissionless; oracle-bounded like rebalancing, but only
    ///         equity -> USDC (speculative buys stay blocked).
    function settleSwap(uint256 equityIn, uint256 minUsdcOut, uint256 deadline) external nonReentrant {
        if (!hook.expired()) revert NotExpired();
        if (settled) revert AlreadySettled();
        if (!rebalanceVenueSet) revert RebalanceVenueUnset();
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (equityIn == 0) revert ZeroAmount();

        uint256 mid = _requireOracle();
        uint256 oracleOut = _equityUnitsToUsdc(equityIn, mid);
        uint256 floor = Math.mulDiv(oracleOut, BPS - maxRebalanceSlippageBps, BPS);
        if (minUsdcOut < floor) revert SlippageBoundUnmet(minUsdcOut, floor);

        hook.modulePull(equity, address(this), equityIn);

        uint256 before = usdc.balanceOf(address(this));
        PoolKey memory venueKey = _rebalanceKey;
        bool zeroForOne = Currency.unwrap(venueKey.currency0) == address(equity);
        equity.forceApprove(rebalanceRouter, equityIn);
        IDemoRouter(rebalanceRouter).swapExactIn(venueKey, zeroForOne, equityIn, minUsdcOut, address(this), deadline);
        equity.forceApprove(rebalanceRouter, 0);
        uint256 amountOut = usdc.balanceOf(address(this)) - before;
        usdc.safeTransfer(address(hook), amountOut);
        hook.moduleSupplyIdle();
        emit SettlementSwapped(equityIn, amountOut);
    }

    /// @notice One-shot settlement. Burns both vaults' hook shares, hands senior its USDC
    ///         guarantee first, then the remaining USDC plus all equity to junior, and freezes
    ///         each vault's terminal redemption rates. Permissionless once the senior guarantee
    ///         is funded or the book is fully in kind.
    function finalizeSettlement() external {
        _finalize(false);
    }

    /// @notice Owner escape hatch for a pathological book (no venue / no liquidity): settles with
    ///         a senior haircut, distributing all available USDC to senior first.
    function finalizeSettlementHaircut() external onlyOwner {
        _finalize(true);
    }

    function _finalize(bool allowHaircut) internal nonReentrant {
        if (!hook.expired()) revert NotExpired();
        if (settled) revert AlreadySettled();
        address acct = hook.accountant();
        if (acct == address(0)) revert AccountantUnset();
        ITrancheAccountant accountant = ITrancheAccountant(acct);
        address seniorVault = accountant.seniorVault();
        address juniorVault = accountant.juniorVault();
        if (seniorVault == address(0) || juniorVault == address(0)) revert VaultsUnset();

        hook.unwindClaims();

        HookShareToken share = hook.shareToken();
        uint256 hSenior = share.balanceOf(seniorVault);
        uint256 hJunior = share.balanceOf(juniorVault);

        uint256 usdcUnits = usdc.balanceOf(address(hook)) + hook.aToken().balanceOf(address(hook));
        uint256 equityUnits = equity.balanceOf(address(hook));
        IAToken aTokenEquity = hook.aTokenEquity();
        if (address(aTokenEquity) != address(0)) equityUnits += aTokenEquity.balanceOf(address(hook));

        uint256 seniorGuarantee = accountant.seniorGuaranteeUsdc();
        if (!allowHaircut && usdcUnits < seniorGuarantee && equityUnits != 0) revert SettlementNotReady();

        uint256 usdcToSenior = usdcUnits < seniorGuarantee ? usdcUnits : seniorGuarantee;
        uint256 usdcToJunior = usdcUnits - usdcToSenior;

        settled = true;

        hook.moduleBurn(seniorVault, hSenior);
        hook.moduleBurn(juniorVault, hJunior);

        if (usdcToSenior != 0) hook.modulePull(usdc, seniorVault, usdcToSenior);
        if (usdcToJunior != 0) hook.modulePull(usdc, juniorVault, usdcToJunior);
        if (equityUnits != 0) hook.modulePull(equity, juniorVault, equityUnits);

        IMaturedVault(seniorVault).creditSettlement(usdcToSenior, 0);
        IMaturedVault(juniorVault).creditSettlement(usdcToJunior, equityUnits);

        emit SettlementFinalized(hSenior, hJunior, usdcToSenior, usdcToJunior, equityUnits);
    }

    function _composition(uint256 mid)
        internal
        view
        returns (uint256 usdcValue, uint256 equityValue, uint256 equityBps)
    {
        uint256 usdcUnits = usdc.balanceOf(address(hook)) + hook.aToken().balanceOf(address(hook)) + _claimUnits(usdc);
        uint256 equityUnits = equity.balanceOf(address(hook)) + _claimUnits(equity);
        if (address(hook.aTokenEquity()) != address(0)) {
            equityUnits += hook.aTokenEquity().balanceOf(address(hook));
        }
        usdcValue = usdcUnits;
        equityValue = _equityUnitsToUsdc(equityUnits, mid);
        uint256 total = usdcValue + equityValue;
        equityBps = total == 0 ? 0 : Math.mulDiv(equityValue, BPS, total);
    }

    function _claimUnits(IERC20 asset) internal view returns (uint256) {
        return hook.poolManager().balanceOf(address(hook), Currency.wrap(address(asset)).toId());
    }

    function _requireOracle() internal view returns (uint256 mid) {
        INVDAPriceOracle.PriceData memory data = INVDAPriceOracle(hook.priceOracle()).getPrice();
        if (!data.valid || data.mid <= 0) revert OracleInvalid();
        if (block.timestamp > data.updatedAt + hook.maxPriceAge()) revert OracleStale(data.updatedAt);
        mid = uint256(uint192(data.mid));
    }

    function _equityUnitsToUsdc(uint256 amount, uint256 mid) internal view returns (uint256) {
        return Math.mulDiv(amount, mid, 10 ** (hook.oracleDecimals() + equityDecimals - usdcDecimals));
    }

    function _usdcToEquityUnits(uint256 amount, uint256 mid) internal view returns (uint256) {
        return Math.mulDiv(amount, 10 ** (hook.oracleDecimals() + equityDecimals - usdcDecimals), mid);
    }
}
