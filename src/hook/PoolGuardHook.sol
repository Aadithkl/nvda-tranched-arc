// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
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
import { TickMath } from "v4-core/src/libraries/TickMath.sol";
import { PoolKey } from "v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "v4-core/src/types/PoolId.sol";
import { Currency } from "v4-core/src/types/Currency.sol";
import { SwapParams, ModifyLiquidityParams } from "v4-core/src/types/PoolOperation.sol";
import { BeforeSwapDelta, BeforeSwapDeltaLibrary } from "v4-core/src/types/BeforeSwapDelta.sol";
import { BalanceDelta } from "v4-core/src/types/BalanceDelta.sol";
import { INVDAPriceOracle } from "../interfaces/INVDAPriceOracle.sol";
import { IPoolGuardSimulator } from "../interfaces/IPoolGuardSimulator.sol";
import { IBookHook } from "../interfaces/IBookHook.sol";
import { GuardParams } from "./libraries/GuardParams.sol";
import { LiquidityAmounts } from "./libraries/LiquidityAmounts.sol";

/// @notice Static-fee guard hook. The pool is public: anyone may add or remove their own
///         liquidity. The hook holds and controls only its own positions (caller-scoped in v4):
///         - base position: wide band, always present, the routing/price-discovery anchor;
///         - guard position: the bulk of protocol liquidity, centered on the current tick at
///           each (re)deploy, pulled whenever an arriving swap is not EV-positive for us.
///         IL guard: `beforeSwap` simulates the swap with SwapMath over our ranges and pulls the
///         guard when the oracle edge attributable to us is below `minEvBps`; the swap then prices
///         against the base only (never a revert). A pulled guard re-arms lazily on the next EV+
///         swap, or via the permissionless time-based `recheckGuard()`. All strategy, capital
///         allocation and yield live one layer down in the vault (the hook owner).
contract PoolGuardHook is BaseHook, Ownable2Step, IBookHook {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using LPFeeLibrary for uint24;
    using SafeERC20 for IERC20;

    struct Position {
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
    }

    bytes32 internal constant BASE_SALT = keccak256("poolguard.base.v1");
    bytes32 internal constant GUARD_SALT = keccak256("poolguard.guard.v1");
    uint256 internal constant Q96 = 0x1000000000000000000000000;

    uint8 internal constant ACTION_INIT = 1;
    uint8 internal constant ACTION_DEPLOY_GUARD = 2;
    uint8 internal constant ACTION_PULL_GUARD = 3;
    uint8 internal constant ACTION_DEPLOY_BASE = 4;
    uint8 internal constant ACTION_PULL_BASE = 5;
    uint8 internal constant ACTION_RECENTER_GUARD = 6;
    uint8 internal constant ACTION_RECALL = 8;
    uint8 internal constant ACTION_PULL_ALL = 9;
    uint8 internal constant ACTION_UNWIND = 10;

    IPoolGuardSimulator public immutable simulator;

    address public priceOracle;
    uint8 public oracleDecimals;
    address public vault;
    address public quote;
    uint8 public quoteDecimals;
    address public immutable equity;
    uint8 public immutable equityDecimals;

    PoolKey internal _key;
    PoolId public activePoolId;
    bool public poolInitialized;

    Position public basePosition;
    Position public guardPosition;
    bool public guardPresent;
    uint256 public pulledAt;
    /// @notice H3: last failed-recheck timestamp. Failed rechecks must NOT touch
    ///         `pulledAt`, or a griefer can keep the guard out forever by pushing
    ///         price outside the band once per interval.
    uint256 public lastRecheckAttempt;
    bool public deployEnabled;
    bool public exited;

    GuardParams.Params internal _params;

    event VaultUpdated(address indexed vault);
    event PriceOracleUpdated(address indexed priceOracle, uint8 decimals);
    event GuardParamsUpdated(GuardParams.Params params);
    event BookInitialized(bytes32 indexed poolId, int24 tick, address quote, address equity);
    event GuardDeployed(int24 tickLower, int24 tickUpper, uint128 liquidity);
    event GuardPulled(int24 tickLower, int24 tickUpper, uint128 liquidity);
    event BaseDeployed(int24 tickLower, int24 tickUpper, uint128 liquidity);
    event BasePulled(int24 tickLower, int24 tickUpper, uint128 liquidity);
    event DeployEnabledSet(bool enabled);
    event BookExited();
    event BookRearmed();
    event Recalled(uint256 quoteAmount, uint256 equityAmount);
    event ClaimRedeemed(address indexed asset, uint256 amount);
    event RecheckSkipped(uint256 deviationBps);
    event SwapGuarded(bytes32 indexed poolId, address indexed sender, uint256 timestamp);

    error ZeroAddress();
    error InvalidOracleDecimals(uint8 decimals);
    error InvalidQuoteDecimals(uint8 decimals);
    error UnauthorizedInitialization(address caller);
    error DynamicFeeForbidden();
    error BookAlreadyInitialized();
    error BookNotInitialized();
    error BookIsExited();
    error DeploymentsDisabled();
    error GuardAlreadyPresent();
    error GuardNotPresent();
    error NothingPulled();
    error RecheckNotDue();
    error UnknownAction(uint8 action);
    error InsufficientInventory(address asset, uint256 required, uint256 available);
    error OracleInvalid();
    error OracleStale(uint256 updatedAt);
    error SessionNotAllowed(uint8 session);
    error InitPriceOffMarket(uint256 deviationBps, uint16 maxDeviationBps);

    constructor(
        IPoolManager poolManager_,
        IPoolGuardSimulator simulator_,
        address priceOracle_,
        address equity_,
        address vault_,
        address owner_
    ) BaseHook(poolManager_) Ownable(owner_ == address(0) ? msg.sender : owner_) {
        if (address(simulator_) == address(0) || priceOracle_ == address(0) || equity_ == address(0)) {
            revert ZeroAddress();
        }
        simulator = simulator_;
        _setPriceOracle(priceOracle_);
        equity = equity_;
        equityDecimals = IERC20Metadata(equity_).decimals();
        if (vault_ != address(0)) {
            vault = vault_;
            emit VaultUpdated(vault_);
        }
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory permissions) {
        permissions.beforeInitialize = true;
        permissions.beforeSwap = true;
    }

    // ---------------------------------------------------------------------
    // Owner (vault) configuration
    // ---------------------------------------------------------------------

    function setVault(address newVault) external onlyOwner {
        if (newVault == address(0)) revert ZeroAddress();
        vault = newVault;
        emit VaultUpdated(newVault);
    }

    function setPriceOracle(address newOracle) external onlyOwner {
        if (newOracle == address(0)) revert ZeroAddress();
        _setPriceOracle(newOracle);
    }

    function _setPriceOracle(address newOracle) internal {
        uint8 decimals_ = INVDAPriceOracle(newOracle).decimals();
        if (decimals_ > 18) revert InvalidOracleDecimals(decimals_);
        priceOracle = newOracle;
        oracleDecimals = decimals_;
        emit PriceOracleUpdated(newOracle, decimals_);
    }

    function setGuardParams(GuardParams.Params calldata newParams) external onlyOwner {
        GuardParams.validate(newParams);
        _params = newParams;
        emit GuardParamsUpdated(newParams);
    }

    function setDeployEnabled(bool enabled) external onlyOwner {
        deployEnabled = enabled;
        emit DeployEnabledSet(enabled);
    }

    function guardParams() external view returns (GuardParams.Params memory) {
        return _params;
    }

    // ---------------------------------------------------------------------
    // Book lifecycle
    // ---------------------------------------------------------------------

    /// @notice One-shot: initializes the static-fee pool and deploys base (+ guard when enabled).
    ///         Guard params must be set first; the hook must already hold the token inventory.
    function initializeBook(PoolKey calldata key, uint160 sqrtPriceX96) external onlyOwner returns (int24 tick) {
        if (poolInitialized) revert BookAlreadyInitialized();
        if (key.hooks != IHooks(address(this))) revert InvalidPool();
        if (key.fee.isDynamicFee()) revert DynamicFeeForbidden();
        GuardParams.validate(_params);

        address eq = equity;
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        address quote_;
        if (c0 == eq) {
            quote_ = c1;
        } else if (c1 == eq) {
            quote_ = c0;
        } else {
            revert InvalidPool();
        }
        if (quote_ == address(0)) revert InvalidPool();
        quote = quote_;
        quoteDecimals = IERC20Metadata(quote_).decimals();
        if (quoteDecimals > 18) revert InvalidQuoteDecimals(quoteDecimals);

        _key = key;
        // Medium: `initializeBook(sqrtPriceX96)` took any price — an off-market init
        // before `vault.initializeHook` lets the first observer dust-LP the real tick
        // (audit §5-min #1). When the oracle is live, the init price must sit inside
        // the recheck band (zero max = band check disabled, docs).
        _requireInitPriceInBand(sqrtPriceX96);
        activePoolId = key.toId();
        poolInitialized = true;
        deployEnabled = true;
        tick = poolManager.initialize(key, sqrtPriceX96);
        poolManager.unlock(abi.encode(ACTION_INIT));
        emit BookInitialized(PoolId.unwrap(activePoolId), tick, quote_, eq);
    }

    /// @notice Deploys the guard band (strict; reverts if inventory is short).
    function deployGuard() external onlyOwner {
        _requireLive();
        if (!deployEnabled) revert DeploymentsDisabled();
        if (guardPresent) revert GuardAlreadyPresent();
        poolManager.unlock(abi.encode(ACTION_DEPLOY_GUARD));
    }

    /// @notice Pulls the guard (if present) and redeploys it centered on the current tick.
    function recenterGuard() external onlyOwner {
        _requireLive();
        if (!guardPresent && !deployEnabled) revert GuardNotPresent();
        poolManager.unlock(abi.encode(ACTION_RECENTER_GUARD));
    }

    /// @notice Pulls the guard and returns all hook inventory to the vault. Base stays deployed.
    function recallToVault() external onlyOwner {
        if (!poolInitialized) revert BookNotInitialized();
        if (vault == address(0)) revert ZeroAddress();
        poolManager.unlock(abi.encode(ACTION_RECALL));
        _sweepToVault();
    }

    /// @notice Moves exact idle amounts back to the vault (owner only, bounded by balances).
    function withdrawInventory(uint256 quoteAmount, uint256 equityAmount) external onlyOwner {
        address vault_ = vault;
        if (vault_ == address(0)) revert ZeroAddress();
        if (quoteAmount != 0) IERC20(quote).safeTransfer(vault_, quoteAmount);
        if (equityAmount != 0) IERC20(equity).safeTransfer(vault_, equityAmount);
        emit Recalled(quoteAmount, equityAmount);
    }

    /// @notice Accepts pending hook ownership (IBookHook deploy-time wiring).
    function acceptHookOwnership() external {
        acceptOwnership();
    }

    /// @notice Idle quote inventory (hook-held, undeployed). Zero before initialization.
    function quoteIdle() external view returns (uint256) {
        address quote_ = quote;
        if (quote_ == address(0)) return 0;
        return IERC20(quote_).balanceOf(address(this));
    }

    /// @notice Idle equity inventory (hook-held, undeployed).
    function equityIdle() external view returns (uint256) {
        return IERC20(equity).balanceOf(address(this));
    }

    /// @notice Redeemable pool-manager claims for a token (ERC-6909 balances).
    function claims(address token) external view returns (uint256) {
        return poolManager.balanceOf(address(this), Currency.wrap(token).toId());
    }

    /// @notice Full exit: pulls guard + base and returns all inventory to the vault.
    function pullAll() external onlyOwner {
        if (!poolInitialized) revert BookNotInitialized();
        if (exited) revert BookIsExited();
        if (vault == address(0)) revert ZeroAddress();
        poolManager.unlock(abi.encode(ACTION_PULL_ALL));
        _sweepToVault();
        exited = true;
        emit BookExited();
    }

    /// @notice Re-arms a pulled book: redeploys base (+ guard when enabled). Vault funds first.
    function rearm() external onlyOwner {
        if (!poolInitialized) revert BookNotInitialized();
        if (!exited) revert GuardAlreadyPresent();
        exited = false;
        poolManager.unlock(abi.encode(ACTION_INIT));
        emit BookRearmed();
    }

    /// @notice Permissionless time-based recheck: after `recheckInterval` with no EV+ swap, the
    ///         guard re-arms if the market still makes sense (oracle valid, deviation in band).
    ///         H3: a skipped recheck records `lastRecheckAttempt` only — `pulledAt` is
    ///         untouched so grief-pushes cannot extend the outage.
    function recheckGuard() external {
        _requireLive();
        if (!deployEnabled) revert DeploymentsDisabled();
        if (guardPresent) revert GuardAlreadyPresent();
        if (pulledAt == 0) revert NothingPulled();
        if (block.timestamp < pulledAt + _params.recheckInterval) revert RecheckNotDue();

        // A zero max disables the band check (docs); otherwise enforce it.
        uint16 maxDev = _params.recheckMaxDeviationBps;
        if (maxDev != 0) {
            (bool ok, uint256 deviationBps) = oracleDeviationBps();
            if (!ok || deviationBps > maxDev) {
                lastRecheckAttempt = block.timestamp;
                emit RecheckSkipped(deviationBps);
                return;
            }
        }
        poolManager.unlock(abi.encode(ACTION_DEPLOY_GUARD));
    }

    /// @notice Redeems this hook's ERC-6909 claims into idle inventory (permissionless).
    function unwindClaims() external {
        if (!poolInitialized) revert BookNotInitialized();
        poolManager.unlock(abi.encode(ACTION_UNWIND));
    }

    // ---------------------------------------------------------------------
    // v4 callbacks
    // ---------------------------------------------------------------------

    function _beforeInitialize(address sender, PoolKey calldata, uint160) internal view override returns (bytes4) {
        if (sender != address(this) && sender != owner()) revert UnauthorizedInitialization(sender);
        return this.beforeInitialize.selector;
    }

    function _beforeSwap(address sender, PoolKey calldata key, SwapParams calldata swapParams, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        _requireActivePool(key);
        // H4: after `pullAll()` the book is out — swaps must not brick on a dead
        // oracle/session. Exit mode skips the oracle gate and guard logic entirely.
        if (exited) {
            emit SwapGuarded(PoolId.unwrap(key.toId()), sender, block.timestamp);
            return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }
        _requireOracle();

        if (!exited && (guardPresent || deployEnabled)) {
            (bool ok, int256 ev, uint256 notional, int256 totalEv, uint256 totalNotional) = _simulateEv(swapParams);
            if (!ok) {
                if (guardPresent) _pullGuard(true);
            } else {
                // H1: whale-LP dilution — a flash-minted 100x position shrinks our
                // share to ~0, so pro-rata EV reads ~0 (no-op) while the flow is
                // deeply toxic. Gate on the UNSCALED total-flow edge too: pull when
                // the whole swap is deeply negative regardless of share.
                bool totalToxic =
                    totalNotional != 0 && totalEv * 10_000 < -int256(totalNotional) * int256(uint256(_params.minEvBps));
                if (totalToxic) {
                    if (guardPresent) _pullGuard(true);
                } else if (notional != 0) {
                    bool positive = ev * 10_000 >= int256(notional) * int256(uint256(_params.minEvBps));
                    if (positive) {
                        if (!guardPresent && deployEnabled) _tryDeployGuardInSwap();
                    } else if (guardPresent) {
                        _pullGuard(true);
                    }
                } else if (totalNotional != 0) {
                    // Our share is zero but the flow has edge: only ever deploy on
                    // clearly positive total flow, never on ~zero/negative.
                    bool totalPositive = totalEv * 10_000 >= int256(totalNotional) * int256(uint256(_params.minEvBps));
                    if (totalPositive && !guardPresent && deployEnabled) _tryDeployGuardInSwap();
                }
            }
        }

        emit SwapGuarded(PoolId.unwrap(key.toId()), sender, block.timestamp);
        return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function unlockCallback(bytes calldata rawData) external onlyPoolManager returns (bytes memory) {
        uint8 action = abi.decode(rawData, (uint8));
        if (action == ACTION_INIT) {
            _deployBase();
            if (deployEnabled) _deployGuardStrict();
        } else if (action == ACTION_DEPLOY_GUARD) {
            _deployGuardStrict();
        } else if (action == ACTION_PULL_GUARD) {
            _pullGuard(false);
        } else if (action == ACTION_DEPLOY_BASE) {
            _deployBase();
        } else if (action == ACTION_PULL_BASE) {
            _pullBase(false);
        } else if (action == ACTION_RECENTER_GUARD) {
            _pullGuard(false);
            if (deployEnabled) _deployGuardStrict();
        } else if (action == ACTION_RECALL) {
            _pullGuard(false);
            _unwindClaims();
        } else if (action == ACTION_PULL_ALL) {
            _pullGuard(false);
            _pullBase(false);
            _unwindClaims();
        } else if (action == ACTION_UNWIND) {
            _unwindClaims();
        } else {
            revert UnknownAction(action);
        }
        return bytes("");
    }

    // ---------------------------------------------------------------------
    // IL guard internals
    // ---------------------------------------------------------------------

    /// @notice External view twin of the EV simulation so `beforeSwap` can fail safe on reverts.
    ///         Also serves as the integrator/test preview of the IL-guard decision.
    function simulateEv(SwapParams calldata params)
        external
        view
        returns (bool ok, int256 ev, uint256 ourNotional, int256 totalEv, uint256 totalNotional)
    {
        return _simulateEv(params);
    }

    function _simulateEv(SwapParams calldata params)
        internal
        view
        returns (bool ok, int256 ev, uint256 notional, int256 totalEv, uint256 totalNotional)
    {
        (uint160 sqrtPrice, int24 tick,,) = poolManager.getSlot0(activePoolId);

        IPoolGuardSimulator.Input memory input;
        if (guardPresent) {
            input.guardLo = guardPosition.tickLower;
            input.guardHi = guardPosition.tickUpper;
        } else {
            (int24 lo, int24 hi) = _guardBounds(tick);
            input.guardLo = lo;
            input.guardHi = hi;
        }
        input.guardLiquidity = _params.guardLiquidity;
        input.guardIncluded = guardPresent;
        input.baseLo = basePosition.tickLower;
        input.baseHi = basePosition.tickUpper;
        input.baseLiquidity = basePosition.liquidity;
        input.quote = quote;
        input.quoteDecimals = quoteDecimals;
        input.equity = equity;
        input.equityDecimals = equityDecimals;

        INVDAPriceOracle.PriceData memory data = INVDAPriceOracle(priceOracle).getPrice();
        if (data.mid <= 0 || oracleDecimals > 18) return (false, int256(0), uint256(0), int256(0), uint256(0));
        input.mid1e18 = uint256(uint192(data.mid)) * (10 ** (18 - oracleDecimals));
        if (sqrtPrice == 0) return (false, int256(0), uint256(0), int256(0), uint256(0));

        try simulator.simulate(poolManager, _key, params, input) returns (IPoolGuardSimulator.Result memory result) {
            return (result.ok, result.ev, result.ourNotional, result.totalEv, result.totalNotional);
        } catch {
            return (false, int256(0), uint256(0), int256(0), uint256(0));
        }
    }

    /// @notice H2: in-swap redeploys center on the spot tick with no deviation check
    ///         (unlike `recheckGuard`), so a manipulated tick gets the full guard.
    ///         Enforce the same `recheckMaxDeviationBps` band here — manipulated
    ///         ticks deploy nothing. A zero max disables the band check (docs).
    function _tryDeployGuardInSwap() internal {
        uint16 maxDev = _params.recheckMaxDeviationBps;
        if (maxDev != 0) {
            (bool ok, uint256 deviationBps) = oracleDeviationBps();
            if (!ok || deviationBps > maxDev) return;
        }
        (int24 lo, int24 hi) = _guardBounds(_currentTick());
        uint128 liquidity = _params.guardLiquidity;
        if (!_openBand(GUARD_SALT, lo, hi, liquidity, false)) return;
        guardPosition = Position({ tickLower: lo, tickUpper: hi, liquidity: liquidity });
        guardPresent = true;
        pulledAt = 0;
        emit GuardDeployed(lo, hi, liquidity);
    }

    function _deployGuardStrict() internal {
        if (guardPresent) revert GuardAlreadyPresent();
        (int24 lo, int24 hi) = _guardBounds(_currentTick());
        uint128 liquidity = _params.guardLiquidity;
        _openBand(GUARD_SALT, lo, hi, liquidity, true);
        guardPosition = Position({ tickLower: lo, tickUpper: hi, liquidity: liquidity });
        guardPresent = true;
        pulledAt = 0;
        emit GuardDeployed(lo, hi, liquidity);
    }

    function _openBand(bytes32 salt, int24 lo, int24 hi, uint128 liquidity, bool strict) internal returns (bool) {
        (uint160 sqrtPrice,,,) = poolManager.getSlot0(activePoolId);
        (uint256 need0, uint256 need1) = LiquidityAmounts.getAmountsForLiquidity(
            sqrtPrice, TickMath.getSqrtPriceAtTick(lo), TickMath.getSqrtPriceAtTick(hi), liquidity
        );
        if (strict) {
            _requireBalance(_key.currency0, need0);
            _requireBalance(_key.currency1, need1);
        } else if (!_hasBalance(_key.currency0, need0) || !_hasBalance(_key.currency1, need1)) {
            return false;
        }

        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            _key,
            ModifyLiquidityParams({
                tickLower: lo, tickUpper: hi, liquidityDelta: int256(uint256(liquidity)), salt: salt
            }),
            bytes("")
        );
        _collectDelta(delta, false);
        return true;
    }

    function _currentTick() internal view returns (int24 tick) {
        (, tick,,) = poolManager.getSlot0(activePoolId);
    }

    function _pullGuard(bool asClaims) internal {
        Position memory position = guardPosition;
        if (!guardPresent || position.liquidity == 0) return;
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            _key,
            ModifyLiquidityParams({
                tickLower: position.tickLower,
                tickUpper: position.tickUpper,
                liquidityDelta: -int256(uint256(position.liquidity)),
                salt: GUARD_SALT
            }),
            bytes("")
        );
        _collectDelta(delta, asClaims);
        guardPosition.liquidity = 0;
        guardPresent = false;
        pulledAt = block.timestamp;
        emit GuardPulled(position.tickLower, position.tickUpper, position.liquidity);
    }

    function _deployBase() internal {
        if (basePosition.liquidity != 0) return;
        (int24 lo, int24 hi) = _baseBounds(_currentTick());
        uint128 liquidity = _params.baseLiquidity;
        _openBand(BASE_SALT, lo, hi, liquidity, true);
        basePosition = Position({ tickLower: lo, tickUpper: hi, liquidity: liquidity });
        emit BaseDeployed(lo, hi, liquidity);
    }

    function _pullBase(bool asClaims) internal {
        Position memory position = basePosition;
        if (position.liquidity == 0) return;
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            _key,
            ModifyLiquidityParams({
                tickLower: position.tickLower,
                tickUpper: position.tickUpper,
                liquidityDelta: -int256(uint256(position.liquidity)),
                salt: BASE_SALT
            }),
            bytes("")
        );
        _collectDelta(delta, asClaims);
        basePosition.liquidity = 0;
        emit BasePulled(position.tickLower, position.tickUpper, position.liquidity);
    }

    function _collectDelta(BalanceDelta delta, bool asClaims) internal {
        _collectCurrency(_key.currency0, delta.amount0(), asClaims);
        _collectCurrency(_key.currency1, delta.amount1(), asClaims);
    }

    function _collectCurrency(Currency currency, int128 amount, bool asClaims) internal {
        if (amount == 0) return;
        if (amount > 0) {
            uint256 received = uint256(uint128(amount));
            if (asClaims) {
                poolManager.mint(address(this), currency.toId(), received);
            } else {
                poolManager.take(currency, address(this), received);
            }
        } else {
            _settle(currency, uint256(uint128(-amount)));
        }
    }

    function _settle(Currency currency, uint256 amount) internal {
        poolManager.sync(currency);
        IERC20(Currency.unwrap(currency)).safeTransfer(address(poolManager), amount);
        poolManager.settle();
    }

    function _unwindClaims() internal {
        _unwindCurrency(_key.currency0);
        _unwindCurrency(_key.currency1);
    }

    function _unwindCurrency(Currency currency) internal {
        uint256 claimBal = poolManager.balanceOf(address(this), currency.toId());
        if (claimBal == 0) return;
        address asset = Currency.unwrap(currency);
        uint256 available = IERC20(asset).balanceOf(address(poolManager));
        uint256 amount = claimBal < available ? claimBal : available;
        if (amount == 0) return;
        poolManager.burn(address(this), currency.toId(), amount);
        poolManager.take(currency, address(this), amount);
        emit ClaimRedeemed(asset, amount);
    }

    function _sweepToVault() internal {
        address vault_ = vault;
        uint256 quoteAmount = IERC20(quote).balanceOf(address(this));
        uint256 equityAmount = IERC20(equity).balanceOf(address(this));
        if (quoteAmount != 0) IERC20(quote).safeTransfer(vault_, quoteAmount);
        if (equityAmount != 0) IERC20(equity).safeTransfer(vault_, equityAmount);
        emit Recalled(quoteAmount, equityAmount);
    }

    function _hasBalance(Currency currency, uint256 amount) internal view returns (bool) {
        return IERC20(Currency.unwrap(currency)).balanceOf(address(this)) >= amount;
    }

    function _requireBalance(Currency currency, uint256 amount) internal view {
        address asset = Currency.unwrap(currency);
        uint256 balance = IERC20(asset).balanceOf(address(this));
        if (balance < amount) revert InsufficientInventory(asset, amount, balance);
    }

    // ---------------------------------------------------------------------
    // Guards & views
    // ---------------------------------------------------------------------

    function _requireLive() internal view {
        if (!poolInitialized) revert BookNotInitialized();
        if (exited) revert BookIsExited();
    }

    function _requireActivePool(PoolKey calldata key) internal view {
        if (
            !poolInitialized || PoolId.unwrap(key.toId()) != PoolId.unwrap(activePoolId)
                || key.hooks != IHooks(address(this))
        ) {
            revert InvalidPool();
        }
    }

    function _requireOracle() internal view {
        INVDAPriceOracle.PriceData memory data = INVDAPriceOracle(priceOracle).getPrice();
        if (!data.valid || data.mid <= 0) revert OracleInvalid();
        if (data.updatedAt > block.timestamp) revert OracleStale(data.updatedAt);
        if (block.timestamp > data.updatedAt + _params.maxPriceAge) revert OracleStale(data.updatedAt);
        uint8 mask = _params.allowedSessionsMask;
        if (mask != 0 && ((mask >> data.session) & 1) == 0) revert SessionNotAllowed(data.session);
    }

    /// @notice Init-time band check against a candidate `sqrtPriceX96` (pool has no
    ///         slot0 yet). Skips when the oracle is not live or the band is disabled.
    function _requireInitPriceInBand(uint160 sqrtPriceX96) internal view {
        uint16 maxDev = _params.recheckMaxDeviationBps;
        if (maxDev == 0) return;
        if (sqrtPriceX96 < TickMath.MIN_SQRT_PRICE || sqrtPriceX96 > TickMath.MAX_SQRT_PRICE) {
            revert InitPriceOffMarket(10_000, maxDev);
        }
        INVDAPriceOracle.PriceData memory data;
        try INVDAPriceOracle(priceOracle).getPrice() returns (INVDAPriceOracle.PriceData memory d) {
            data = d;
        } catch {
            return;
        }
        if (!data.valid || data.mid <= 0 || oracleDecimals > 18) return;
        if (data.updatedAt == 0 || data.updatedAt > block.timestamp) return;
        if (block.timestamp > data.updatedAt + _params.maxPriceAge) return;
        uint256 poolUsd = _poolPrice1e18(sqrtPriceX96);
        uint256 oracleUsd = uint256(uint192(data.mid)) * (10 ** (18 - oracleDecimals));
        if (poolUsd == 0 || oracleUsd == 0) return;
        uint256 diff = poolUsd > oracleUsd ? poolUsd - oracleUsd : oracleUsd - poolUsd;
        uint256 deviationBps = Math.mulDiv(diff, 10_000, oracleUsd);
        if (deviationBps > maxDev) revert InitPriceOffMarket(deviationBps, maxDev);
    }

    function oracleStatus() external view returns (bool ok, uint256 updatedAt, uint8 session) {
        INVDAPriceOracle.PriceData memory data = INVDAPriceOracle(priceOracle).getPrice();
        ok = data.valid && data.mid > 0 && data.updatedAt != 0 && data.updatedAt <= block.timestamp
            && block.timestamp <= data.updatedAt + _params.maxPriceAge;
        uint8 mask = _params.allowedSessionsMask;
        if (ok && mask != 0 && ((mask >> data.session) & 1) == 0) ok = false;
        updatedAt = data.updatedAt;
        session = data.session;
    }

    function oracleDeviationBps() public view returns (bool ok, uint256 deviationBps) {
        INVDAPriceOracle.PriceData memory data = INVDAPriceOracle(priceOracle).getPrice();
        if (!data.valid || data.mid <= 0) return (false, 0);
        if (data.updatedAt == 0 || data.updatedAt > block.timestamp) return (false, 0);
        if (block.timestamp > data.updatedAt + _params.maxPriceAge) return (false, 0);
        uint8 mask = _params.allowedSessionsMask;
        if (mask != 0 && ((mask >> data.session) & 1) == 0) return (false, 0);

        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(activePoolId);
        if (sqrtPriceX96 == 0 || sqrtPriceX96 < TickMath.MIN_SQRT_PRICE || sqrtPriceX96 > TickMath.MAX_SQRT_PRICE) {
            return (false, 0);
        }
        uint256 poolUsd = _poolPrice1e18(sqrtPriceX96);
        uint256 oracleUsd = uint256(uint192(data.mid)) * (10 ** (18 - oracleDecimals));
        if (oracleUsd == 0) return (false, 0);
        uint256 diff = poolUsd > oracleUsd ? poolUsd - oracleUsd : oracleUsd - poolUsd;
        deviationBps = Math.mulDiv(diff, 10_000, oracleUsd);
        ok = true;
    }

    function _poolPrice1e18(uint160 sqrtPriceX96) internal view returns (uint256) {
        uint256 ratioX96 = Math.mulDiv(uint256(sqrtPriceX96), uint256(sqrtPriceX96), Q96);
        if (ratioX96 == 0) return 0;
        uint256 scaledEquity = 1e18 * (10 ** equityDecimals);
        uint256 scaledQuote = 10 ** quoteDecimals;
        if (Currency.unwrap(_key.currency1) == equity) {
            return Math.mulDiv(scaledEquity, Q96, Math.mulDiv(ratioX96, scaledQuote, 1));
        }
        return Math.mulDiv(ratioX96, scaledEquity, Q96 * scaledQuote);
    }

    function guardState() external view returns (bool present, uint256 pulledAt_, bool deployEnabled_, bool exited_) {
        return (guardPresent, pulledAt, deployEnabled, exited);
    }

    function poolPrice1e18() external view returns (uint256) {
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(activePoolId);
        return _poolPrice1e18(sqrtPriceX96);
    }

    function recheckDue() external view returns (bool) {
        return !guardPresent && deployEnabled && !exited && pulledAt != 0
            && block.timestamp >= pulledAt + _params.recheckInterval;
    }

    function effectiveLiquidity() external view returns (uint128) {
        return poolManager.getLiquidity(activePoolId);
    }

    function inventory() external view returns (uint256 quoteAmount, uint256 equityAmount) {
        return (IERC20(quote).balanceOf(address(this)), IERC20(equity).balanceOf(address(this)));
    }

    // ---------------------------------------------------------------------
    // Bounds helpers
    // ---------------------------------------------------------------------

    function _guardBounds(int24 tick) internal view returns (int24 lo, int24 hi) {
        int24 spacing = _key.tickSpacing;
        lo = _floorAlign(tick - _params.guardTickWidth, spacing);
        hi = _ceilAlign(tick + _params.guardTickWidth, spacing);
        if (lo < TickMath.MIN_TICK) lo = TickMath.MIN_TICK;
        if (hi > TickMath.MAX_TICK) hi = TickMath.MAX_TICK;
        if (hi <= lo) hi = lo + spacing;
    }

    function _baseBounds(int24 tick) internal view returns (int24 lo, int24 hi) {
        int24 spacing = _key.tickSpacing;
        lo = _floorAlign(tick - _params.baseTickWidth, spacing);
        hi = _ceilAlign(tick + _params.baseTickWidth, spacing);
        if (lo < TickMath.MIN_TICK) lo = TickMath.MIN_TICK;
        if (hi > TickMath.MAX_TICK) hi = TickMath.MAX_TICK;
        if (hi <= lo) hi = lo + spacing;
    }

    function _floorAlign(int24 tick, int24 spacing) internal pure returns (int24) {
        int24 compressed = tick / spacing;
        if (tick < 0 && tick % spacing != 0) compressed--;
        return compressed * spacing;
    }

    function _ceilAlign(int24 tick, int24 spacing) internal pure returns (int24) {
        int24 compressed = tick / spacing;
        if (tick > 0 && tick % spacing != 0) compressed++;
        return compressed * spacing;
    }
}

