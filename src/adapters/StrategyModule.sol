// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IStrategyAdapter } from "./IStrategyAdapter.sol";
import { IMorphoLoopAdapter, MorphoLoopAdapter } from "./MorphoLoopAdapter.sol";
import { IMorpho } from "./IMorpho.sol";
import { IVaultBaseAssets } from "./IStrategyModule.sol";

/// @notice Strategy control plane for `LedgerVault`, modeled on Morpho Vault V2's adapter + cap
///         system with a Boring-Vault-style role split:
///           - Curator (owner): configures adapters and caps. Enabling an adapter or increasing a
///             cap is timelocked (submit -> execute); disabling and lowering caps are immediate.
///           - Allocator: moves funds within caps (allocate/deallocate/loop ops).
///           - Sentinel: de-risk only — disable adapters, lower caps, cancel pending, repay/deleverage.
///         Adapters are fixed-function contracts (no arbitrary calls); this module holds no assets
///         at rest and only routes them. Losses surface through each adapter's `realAssets()`.
contract StrategyModule is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 internal constant BPS = 10_000;
    uint256 internal constant MAX_TIMELOCK = 7 days;

    struct AdapterConfig {
        bool enabled;
        bool redemptionSafe;
        bool isLoop;
        uint256 absoluteCap;
        uint16 relativeCapBps;
    }

    struct PendingAdapter {
        bool pending;
        bool redemptionSafe;
        bool isLoop;
        uint256 absoluteCap;
        uint16 relativeCapBps;
        uint64 executableAt;
    }

    address public vault;
    address public asset;
    address public allocator;
    address public sentinel;
    uint256 public timelock = 24 hours;
    /// @notice Pending timelock decrease: increases take effect immediately,
    ///         decreases wait out the current timelock so `setTimelock(0)` cannot
    ///         bypass the adapter queue.
    uint256 public pendingTimelock;
    uint64 public timelockExecutableAt;

    mapping(address => AdapterConfig) public adapters;
    mapping(address => PendingAdapter) public pending;
    mapping(address => bool) internal _listed;
    address[] public adapterList;
    /// @notice Canonical Morpho singleton (zero = any, for tests). When set,
    ///         loop adapters must point at it.
    address public canonicalMorpho;
    /// @notice Allowlisted Morpho oracles. When `oracleAllowlistOn` is true,
    ///         loop adapters may only use listed oracles (curator-chosen oracles
    ///         with fake `price()=10x` drained via inflated `maxDebtAllowed`).
    mapping(address => bool) public allowedOracles;
    bool public oracleAllowlistOn;

    event VaultUpdated(address indexed vault);
    event AllocatorUpdated(address indexed allocator);
    event SentinelUpdated(address indexed sentinel);
    event TimelockUpdated(uint256 timelock);
    event TimelockSubmitted(uint256 pendingTimelock, uint64 executableAt);
    event AdapterSubmitted(address indexed adapter, uint256 absoluteCap, uint16 relativeCapBps, uint64 executableAt);
    event AdapterEnabled(address indexed adapter);
    event AdapterDisabled(address indexed adapter);
    event AdapterPendingCancelled(address indexed adapter);
    event CapsLowered(address indexed adapter, uint256 absoluteCap, uint16 relativeCapBps);
    event Allocated(address indexed adapter, uint256 amount);
    event Deallocated(address indexed adapter, uint256 withdrawn);
    event CollateralAllocated(address indexed adapter, uint256 amount);
    event Borrowed(address indexed adapter, uint256 amount);
    event Repaid(address indexed adapter, uint256 amount);
    event Deleveraged(address indexed adapter, uint256 repaid, uint256 collateralWithdrawn);
    event PulledToVault(uint256 amount);
    event AdapterExited(address indexed adapter, uint256 withdrawn);
    event AdapterExitFailed(address indexed adapter);
    event CanonicalMorphoUpdated(address indexed morpho);
    event OracleAllowlistUpdated(address indexed oracle, bool allowed);
    event OracleAllowlistEnforced(bool enforced);

    error NotVault(address caller);
    error NotAllocator(address caller);
    error NotAllocatorOrSentinel(address caller);
    error NotOwnerOrSentinel(address caller);
    error ZeroAddress();
    error ZeroAmount();
    error InvalidConfig();
    error InvalidAdapter(address adapter);
    error AdapterNotEnabled(address adapter);
    error AdapterAlreadyEnabled(address adapter);
    error AdapterKindMismatch(bool expectedLoop);
    error NothingPending(address adapter);
    error TimelockActive(uint64 executableAt);
    error CapsNotDecreasing();
    error CapExceeded(uint256 predicted, uint256 cap);
    error RelativeCapExceeded(uint256 predicted, uint256 limit);
    error TimelockTooLong(uint256 timelock);
    error BookExpired();
    error OracleNotAllowlisted(address oracle);
    error MorphoNotCanonical(address morpho);
    error InvalidMarketParams();

    modifier onlyVault() {
        if (msg.sender != vault) revert NotVault(msg.sender);
        _;
    }

    modifier onlyAllocator() {
        if (msg.sender != allocator) revert NotAllocator(msg.sender);
        _;
    }

    modifier onlyAllocatorOrSentinel() {
        if (msg.sender != allocator && msg.sender != sentinel) revert NotAllocatorOrSentinel(msg.sender);
        _;
    }

    modifier onlyOwnerOrSentinel() {
        if (msg.sender != owner() && msg.sender != sentinel) revert NotOwnerOrSentinel(msg.sender);
        _;
    }

    constructor(address owner_, address asset_) Ownable(owner_) {
        if (asset_ == address(0)) revert ZeroAddress();
        asset = asset_;
    }

    // ---------------------------------------------------------------------
    // Configuration (Curator = owner)
    // ---------------------------------------------------------------------

    function setVault(address vault_) external onlyOwner {
        if (vault_ == address(0)) revert ZeroAddress();
        vault = vault_;
        emit VaultUpdated(vault_);
    }

    function setAllocator(address allocator_) external onlyOwner {
        if (allocator_ == address(0)) revert ZeroAddress();
        allocator = allocator_;
        emit AllocatorUpdated(allocator_);
    }

    function setSentinel(address sentinel_) external onlyOwner {
        if (sentinel_ == address(0)) revert ZeroAddress();
        sentinel = sentinel_;
        emit SentinelUpdated(sentinel_);
    }

    /// @notice Pins the canonical Morpho singleton. Zero = any (test mode).
    function setCanonicalMorpho(address morpho_) external onlyOwner {
        canonicalMorpho = morpho_;
        emit CanonicalMorphoUpdated(morpho_);
    }

    /// @notice Allow/disallow a Morpho oracle for loop sleeves.
    function setOracleAllowed(address oracle, bool allowed) external onlyOwner {
        allowedOracles[oracle] = allowed;
        emit OracleAllowlistUpdated(oracle, allowed);
    }

    /// @notice Turns oracle-allowlist enforcement on/off. Off by default so
    ///         existing tests with mock oracles keep passing; production deploys
    ///         must enable it after listing the canonical oracles.
    function setOracleAllowlistOn(bool on) external onlyOwner {
        oracleAllowlistOn = on;
        emit OracleAllowlistEnforced(on);
    }

    function setTimelock(uint256 timelock_) external onlyOwner {
        if (timelock_ > MAX_TIMELOCK) revert TimelockTooLong(timelock_);
        // Risk-increasing direction (longer delay) applies immediately;
        // shortening the delay is itself timelocked so it cannot fast-path evil adapters.
        // Exception: bootstrap wiring — before ANY adapter has ever been listed the
        // curator may still tune freely (no liquidity is gated yet; tests use this).
        if (timelock_ >= timelock || adapterList.length == 0) {
            timelock = timelock_;
            emit TimelockUpdated(timelock_);
        } else {
            pendingTimelock = timelock_;
            timelockExecutableAt = uint64(block.timestamp) + uint64(timelock);
            emit TimelockSubmitted(timelock_, timelockExecutableAt);
        }
    }

    /// @notice Executes a scheduled timelock decrease (permissionless post-delay).
    function executeTimelock() external {
        uint256 pending_ = pendingTimelock;
        if (pending_ == 0 && timelockExecutableAt == 0) revert NothingPending(address(0));
        if (block.timestamp < timelockExecutableAt) revert TimelockActive(timelockExecutableAt);
        delete pendingTimelock;
        timelockExecutableAt = 0;
        timelock = pending_;
        emit TimelockUpdated(pending_);
    }

    function cancelTimelock() external onlyOwnerOrSentinel {
        if (timelockExecutableAt == 0) revert NothingPending(address(0));
        delete pendingTimelock;
        timelockExecutableAt = 0;
        emit TimelockSubmitted(0, 0);
    }

    /// @notice Schedules enabling an adapter (timelocked; risk-increasing).
    ///         Validates the loop sleeve's market params (canonical Morpho,
    ///         loanToken == asset, sane LLTV); oracle allowlist.
    function submitAdapter(
        address adapter,
        bool redemptionSafe,
        bool isLoop,
        uint256 absoluteCap,
        uint16 relativeCapBps
    ) external onlyOwner {
        if (adapter == address(0)) revert ZeroAddress();
        if (absoluteCap == 0 || relativeCapBps == 0 || relativeCapBps > BPS) revert InvalidConfig();
        if (IStrategyAdapter(adapter).authority() != address(this)) revert InvalidAdapter(adapter);
        if (IStrategyAdapter(adapter).asset() != asset) revert InvalidAdapter(adapter);
        if (adapters[adapter].enabled) revert AdapterAlreadyEnabled(adapter);
        if (isLoop) _validateLoopAdapter(adapter);
        uint64 executableAt = uint64(block.timestamp) + uint64(timelock);
        pending[adapter] = PendingAdapter(true, redemptionSafe, isLoop, absoluteCap, relativeCapBps, executableAt);
        emit AdapterSubmitted(adapter, absoluteCap, relativeCapBps, executableAt);
    }

    /// @notice Validation for loop sleeves: canonical singleton, loanToken
    ///         policy, LLTV sanity, oracle allowlist.
    function _validateLoopAdapter(address adapter) internal view {
        MorphoLoopAdapter loop = MorphoLoopAdapter(adapter);
        address morpho = address(loop.morpho());
        if (morpho == address(0)) revert InvalidAdapter(adapter);
        if (canonicalMorpho != address(0) && morpho != canonicalMorpho) revert MorphoNotCanonical(morpho);
        try loop.marketParams() returns (IMorpho.MarketParams memory mp) {
            if (mp.loanToken != asset) revert InvalidMarketParams();
            if (mp.collateralToken == address(0) || mp.oracle == address(0)) revert InvalidMarketParams();
            if (mp.lltv == 0 || mp.lltv > 1e18) revert InvalidMarketParams();
            if (mp.loanToken == mp.collateralToken) revert InvalidMarketParams();
            if (oracleAllowlistOn && !allowedOracles[mp.oracle]) revert OracleNotAllowlisted(mp.oracle);
        } catch {
            revert InvalidAdapter(adapter);
        }
    }

    /// @notice Executes a scheduled adapter (permissionless once the timelock has passed).
    function executeAdapter(address adapter) external {
        PendingAdapter memory p = pending[adapter];
        if (!p.pending) revert NothingPending(adapter);
        if (block.timestamp < p.executableAt) revert TimelockActive(p.executableAt);
        delete pending[adapter];
        if (!_listed[adapter]) {
            _listed[adapter] = true;
            adapterList.push(adapter);
        }
        adapters[adapter] = AdapterConfig(true, p.redemptionSafe, p.isLoop, p.absoluteCap, p.relativeCapBps);
        emit AdapterEnabled(adapter);
    }

    /// @notice Sentinel/curator de-risk: instantly disable an adapter for NEW risk.
    ///         Disabling never blocks exits: deallocate/repay/deleverage/exitAll stay
    ///         callable so the emergency brake cannot strand funds.
    function disableAdapter(address adapter) external onlyOwnerOrSentinel {
        if (!adapters[adapter].enabled) revert AdapterNotEnabled(adapter);
        adapters[adapter].enabled = false;
        emit AdapterDisabled(adapter);
    }

    /// @notice Sentinel/curator de-risk: instantly lower caps (never increase).
    function lowerCaps(address adapter, uint256 absoluteCap, uint16 relativeCapBps) external onlyOwnerOrSentinel {
        AdapterConfig memory cfg = adapters[adapter];
        if (!cfg.enabled) revert AdapterNotEnabled(adapter);
        if (absoluteCap > cfg.absoluteCap || relativeCapBps > cfg.relativeCapBps) revert CapsNotDecreasing();
        adapters[adapter].absoluteCap = absoluteCap;
        adapters[adapter].relativeCapBps = relativeCapBps;
        emit CapsLowered(adapter, absoluteCap, relativeCapBps);
    }

    function cancelPending(address adapter) external onlyOwnerOrSentinel {
        if (!pending[adapter].pending) revert NothingPending(adapter);
        delete pending[adapter];
        emit AdapterPendingCancelled(adapter);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function adapterCount() external view returns (uint256) {
        return adapterList.length;
    }

    /// @notice NAV contribution of ALL listed adapters, enabled or disabled:
    ///         excluding a disabled sleeve from NAV hides losses and craters payouts.
    ///         Loop sleeves report equity: collateral value − debt, floored at zero.
    function totalAssets() public view returns (uint256 total) {
        uint256 count = adapterList.length;
        for (uint256 i = 0; i < count; ++i) {
            address adapter = adapterList[i];
            total += IStrategyAdapter(adapter).realAssets();
        }
    }

    /// @notice Unsecured loop shortfall across ALL listed loop adapters. `totalAssets()`
    ///         floors an underwater sleeve at zero; the vault subtracts this number so
    ///         NAV reflects the negative equity instead of ignoring it.
    function badDebt() external view returns (uint256 total) {
        uint256 count = adapterList.length;
        for (uint256 i = 0; i < count; ++i) {
            address adapter = adapterList[i];
            if (adapters[adapter].isLoop) total += IMorphoLoopAdapter(adapter).badDebt();
        }
    }

    /// @notice Amount the redemption-safe adapters (the ones `pullToVault` draws from) could
    ///         return to the vault right now, liquidity-aware. Used by the vault's 7575 max
    ///         withdrawal views so they never overstate what `pullToVault` can actually deliver.
    function pullableAssets() external view returns (uint256 total) {
        uint256 count = adapterList.length;
        for (uint256 i = 0; i < count; ++i) {
            address adapter = adapterList[i];
            AdapterConfig memory cfg = adapters[adapter];
            if (cfg.enabled && cfg.redemptionSafe && !cfg.isLoop) {
                total += IStrategyAdapter(adapter).maxWithdrawable();
            }
        }
    }

    /// @notice Exposure tracked against caps for one adapter (loop: collateral value).
    function adapterExposure(address adapter) public view returns (uint256) {
        return
            adapters[adapter].isLoop ? IMorphoLoopAdapter(adapter).exposure() : IStrategyAdapter(adapter).realAssets();
    }

    /// @notice Outstanding loop-sleeve debt across ALL listed loop adapters:
    ///         disabled sleeves still owe — settlement readiness must not hide them.
    function totalLoopDebt() external view returns (uint256 debt) {
        uint256 count = adapterList.length;
        for (uint256 i = 0; i < count; ++i) {
            address adapter = adapterList[i];
            if (adapters[adapter].isLoop) debt += IMorphoLoopAdapter(adapter).debt();
        }
    }

    // ---------------------------------------------------------------------
    // Allocation (Allocator)
    // ---------------------------------------------------------------------

    function allocate(address adapter, uint256 amount) external onlyAllocator {
        AdapterConfig memory cfg = adapters[adapter];
        if (!cfg.enabled) revert AdapterNotEnabled(adapter);
        if (cfg.isLoop) revert AdapterKindMismatch(true);
        if (amount == 0) revert ZeroAmount();
        if (IVaultBaseAssets(vault).expired()) revert BookExpired();

        _checkCaps(cfg, IStrategyAdapter(adapter).realAssets() + amount);
        IERC20(asset).safeTransferFrom(vault, address(this), amount);
        IERC20(asset).forceApprove(adapter, amount);
        uint256 deployed = IStrategyAdapter(adapter).deposit(amount);
        IERC20(asset).forceApprove(adapter, 0);
        uint256 leftover = amount - deployed;
        if (leftover != 0) IERC20(asset).safeTransfer(vault, leftover);
        emit Allocated(adapter, deployed);
    }

    function deallocate(address adapter, uint256 amount) external onlyAllocatorOrSentinel returns (uint256 withdrawn) {
        // Disabled adapters stay recoverable: only NEW risk is blocked by `enabled`.
        if (!_listed[adapter]) revert InvalidAdapter(adapter);
        if (amount == 0) revert ZeroAmount();
        withdrawn = IStrategyAdapter(adapter).withdraw(amount, vault);
        emit Deallocated(adapter, withdrawn);
    }

    /// @notice Vault-initiated withdrawal routing: redemption-safe adapters only, in order.
    function pullToVault(uint256 amount) external onlyVault returns (uint256 pulled) {
        uint256 count = adapterList.length;
        for (uint256 i = 0; i < count && pulled < amount; ++i) {
            address adapter = adapterList[i];
            AdapterConfig memory cfg = adapters[adapter];
            if (!cfg.enabled || !cfg.redemptionSafe || cfg.isLoop) continue;
            uint256 limit = IStrategyAdapter(adapter).maxWithdrawable();
            if (limit == 0) continue;
            uint256 want = amount - pulled;
            pulled += IStrategyAdapter(adapter).withdraw(want < limit ? want : limit, vault);
        }
        emit PulledToVault(pulled);
    }

    /// @notice Best-effort full unwind of EVERY listed adapter to the vault, including
    ///         adapters the sentinel disabled. A disabled sleeve still owes its debt and
    ///         still holds user assets; skipping it would strand both at settlement.
    ///         Approves the exact repayment need per loop sleeve (never max) and
    ///         resets to zero so a malicious adapter cannot `transferFrom` the next
    ///         sleeve's funding.
    function exitAll() external onlyVault nonReentrant {
        uint256 count = adapterList.length;
        for (uint256 i = 0; i < count; ++i) {
            address adapter = adapterList[i];
            AdapterConfig memory cfg = adapters[adapter];
            uint256 need;
            if (cfg.isLoop) {
                // Fund the debt repayment from the vault so the adapter can unwind.
                need = IMorphoLoopAdapter(adapter).debt();
                if (need != 0) IERC20(asset).safeTransferFrom(vault, address(this), need);
            }
            if (need != 0) IERC20(asset).forceApprove(adapter, need);
            try IStrategyAdapter(adapter).exit(type(uint256).max, vault) returns (uint256 withdrawn) {
                emit AdapterExited(adapter, withdrawn);
            } catch {
                emit AdapterExitFailed(adapter);
            }
            if (need != 0) IERC20(asset).forceApprove(adapter, 0);
            // Return any unfunded remainder (adapter pulled less than `need`).
            uint256 dust = IERC20(asset).balanceOf(address(this));
            if (dust != 0) IERC20(asset).safeTransfer(vault, dust);
        }
        // Include the no-adapter / all-reverted case.
        uint256 remaining = IERC20(asset).balanceOf(address(this));
        if (remaining != 0) IERC20(asset).safeTransfer(vault, remaining);
    }

    // ---------------------------------------------------------------------
    // Loop sleeve operations
    // ---------------------------------------------------------------------

    function allocateCollateral(address adapter, uint256 amount) external onlyAllocator {
        AdapterConfig memory cfg = adapters[adapter];
        if (!cfg.enabled) revert AdapterNotEnabled(adapter);
        if (!cfg.isLoop) revert AdapterKindMismatch(true);
        if (amount == 0) revert ZeroAmount();
        if (IVaultBaseAssets(vault).expired()) revert BookExpired();

        uint256 predicted =
            IMorphoLoopAdapter(adapter).exposure() + IMorphoLoopAdapter(adapter).collateralValueOf(amount);
        _checkCaps(cfg, predicted);
        address collateral = IMorphoLoopAdapter(adapter).collateralToken();
        IERC20(collateral).safeTransferFrom(vault, address(this), amount);
        IERC20(collateral).forceApprove(adapter, amount);
        IMorphoLoopAdapter(adapter).depositCollateral(amount);
        IERC20(collateral).forceApprove(adapter, 0);
        emit CollateralAllocated(adapter, amount);
    }

    function borrow(address adapter, uint256 amount) external onlyAllocator {
        AdapterConfig memory cfg = adapters[adapter];
        if (!cfg.enabled) revert AdapterNotEnabled(adapter);
        if (!cfg.isLoop) revert AdapterKindMismatch(true);
        if (amount == 0) revert ZeroAmount();
        if (IVaultBaseAssets(vault).expired()) revert BookExpired();
        // Borrows were uncapped — repeat `borrow(maxBorrowPerCall)` drained to
        // `targetLtvOfLltv`. Enforce the same absolute + relative caps as allocates.
        uint256 predictedDebt = IMorphoLoopAdapter(adapter).debt() + amount;
        if (predictedDebt > cfg.absoluteCap) revert CapExceeded(predictedDebt, cfg.absoluteCap);
        uint256 baseAssets = IVaultBaseAssets(vault).baseManagedAssets() + totalAssets();
        uint256 limit = Math.mulDiv(baseAssets, cfg.relativeCapBps, BPS);
        if (predictedDebt > limit) revert RelativeCapExceeded(predictedDebt, limit);
        IMorphoLoopAdapter(adapter).borrowTo(amount, vault);
        emit Borrowed(adapter, amount);
    }

    /// @notice Repay loop debt from vault capital (allocator or sentinel de-risk).
    function repay(address adapter, uint256 amount) external onlyAllocatorOrSentinel {
        AdapterConfig memory cfg = adapters[adapter];
        // Disabled loop sleeves must still be repayable — otherwise the sentinel's
        // emergency disable locks debt in place and liquidation keeps accruing.
        if (!_listed[adapter]) revert InvalidAdapter(adapter);
        if (!cfg.isLoop) revert AdapterKindMismatch(true);
        if (amount == 0) revert ZeroAmount();
        uint256 pulled = amount;
        IERC20(asset).safeTransferFrom(vault, address(this), pulled);
        IERC20(asset).forceApprove(adapter, pulled);
        uint256 repaid = IMorphoLoopAdapter(adapter).repayFrom(pulled);
        IERC20(asset).forceApprove(adapter, 0);
        uint256 leftover = pulled > repaid ? pulled - repaid : 0;
        if (leftover != 0) IERC20(asset).safeTransfer(vault, leftover);
        emit Repaid(adapter, repaid);
    }

    /// @notice Sentinel/allocator de-risk: repay debt and/or withdraw collateral back to the vault.
    function deleverage(address adapter, uint256 repayAmount, uint256 collateralWithdrawn)
        external
        onlyAllocatorOrSentinel
    {
        AdapterConfig memory cfg = adapters[adapter];
        // De-risking must work after a disable; only new borrowing is blocked.
        if (!_listed[adapter]) revert InvalidAdapter(adapter);
        if (!cfg.isLoop) revert AdapterKindMismatch(true);
        uint256 repaid;
        if (repayAmount != 0) {
            uint256 pulled = repayAmount;
            IERC20(asset).safeTransferFrom(vault, address(this), pulled);
            IERC20(asset).forceApprove(adapter, pulled);
            repaid = IMorphoLoopAdapter(adapter).repayFrom(pulled);
            IERC20(asset).forceApprove(adapter, 0);
            uint256 leftover = pulled > repaid ? pulled - repaid : 0;
            if (leftover != 0) IERC20(asset).safeTransfer(vault, leftover);
        }
        if (collateralWithdrawn != 0) {
            IMorphoLoopAdapter(adapter).withdrawCollateralTo(collateralWithdrawn, vault);
        }
        emit Deleveraged(adapter, repaid, collateralWithdrawn);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _checkCaps(AdapterConfig memory cfg, uint256 predicted) internal view {
        if (predicted > cfg.absoluteCap) revert CapExceeded(predicted, cfg.absoluteCap);
        uint256 baseAssets = IVaultBaseAssets(vault).baseManagedAssets() + totalAssets();
        uint256 limit = Math.mulDiv(baseAssets, cfg.relativeCapBps, BPS);
        if (predicted > limit) revert RelativeCapExceeded(predicted, limit);
    }
}
