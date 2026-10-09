// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IStrategyAdapter } from "./IStrategyAdapter.sol";
import { IMorphoLoopAdapter } from "./MorphoLoopAdapter.sol";
import { IVaultBaseAssets } from "./IStrategyModule.sol";

/// @notice Strategy control plane for `RegimeVault`, modeled on Morpho Vault V2's adapter + cap
///         system with a Boring-Vault-style role split:
///           - Curator (owner): configures adapters and caps. Enabling an adapter or increasing a
///             cap is timelocked (submit -> execute); disabling and lowering caps are immediate.
///           - Allocator: moves funds within caps (allocate/deallocate/loop ops).
///           - Sentinel: de-risk only — disable adapters, lower caps, cancel pending, repay/deleverage.
///         Adapters are fixed-function contracts (no arbitrary calls); this module holds no assets
///         at rest and only routes them. Losses surface through each adapter's `realAssets()`.
contract StrategyModule is Ownable2Step {
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

    mapping(address => AdapterConfig) public adapters;
    mapping(address => PendingAdapter) public pending;
    mapping(address => bool) internal _listed;
    address[] public adapterList;

    event VaultUpdated(address indexed vault);
    event AllocatorUpdated(address indexed allocator);
    event SentinelUpdated(address indexed sentinel);
    event TimelockUpdated(uint256 timelock);
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

    function setTimelock(uint256 timelock_) external onlyOwner {
        if (timelock_ > MAX_TIMELOCK) revert TimelockTooLong(timelock_);
        timelock = timelock_;
        emit TimelockUpdated(timelock_);
    }

    /// @notice Schedules enabling an adapter (timelocked; risk-increasing).
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
        uint64 executableAt = uint64(block.timestamp) + uint64(timelock);
        pending[adapter] = PendingAdapter(true, redemptionSafe, isLoop, absoluteCap, relativeCapBps, executableAt);
        emit AdapterSubmitted(adapter, absoluteCap, relativeCapBps, executableAt);
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

    /// @notice Sentinel/curator de-risk: instantly disable an adapter (no new allocations).
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

    /// @notice NAV contribution of all enabled adapters, in asset units (loop sleeves report
    ///         equity: collateral value − debt, floored at zero).
    function totalAssets() public view returns (uint256 total) {
        uint256 count = adapterList.length;
        for (uint256 i = 0; i < count; ++i) {
            address adapter = adapterList[i];
            if (adapters[adapter].enabled) total += IStrategyAdapter(adapter).realAssets();
        }
    }

    /// @notice Exposure tracked against caps for one adapter (loop: collateral value).
    function adapterExposure(address adapter) public view returns (uint256) {
        return
            adapters[adapter].isLoop ? IMorphoLoopAdapter(adapter).exposure() : IStrategyAdapter(adapter).realAssets();
    }

    /// @notice Outstanding loop-sleeve debt across enabled loop adapters (settlement readiness).
    function totalLoopDebt() external view returns (uint256 debt) {
        uint256 count = adapterList.length;
        for (uint256 i = 0; i < count; ++i) {
            address adapter = adapterList[i];
            AdapterConfig memory cfg = adapters[adapter];
            if (cfg.enabled && cfg.isLoop) debt += IMorphoLoopAdapter(adapter).debt();
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
        if (!adapters[adapter].enabled) revert AdapterNotEnabled(adapter);
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

    /// @notice Best-effort full unwind of every enabled adapter to the vault (settlement path).
    function exitAll() external onlyVault {
        uint256 count = adapterList.length;
        for (uint256 i = 0; i < count; ++i) {
            address adapter = adapterList[i];
            AdapterConfig memory cfg = adapters[adapter];
            if (!cfg.enabled) continue;
            if (cfg.isLoop) {
                // Fund the debt repayment from the vault so the adapter can unwind.
                uint256 need = IMorphoLoopAdapter(adapter).debt();
                if (need != 0) IERC20(asset).safeTransferFrom(vault, address(this), need);
            }
            IERC20(asset).forceApprove(adapter, type(uint256).max);
            try IStrategyAdapter(adapter).exit(type(uint256).max, vault) returns (uint256 withdrawn) {
                emit AdapterExited(adapter, withdrawn);
            } catch {
                emit AdapterExitFailed(adapter);
            }
            IERC20(asset).forceApprove(adapter, 0);
        }
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
        IMorphoLoopAdapter(adapter).borrowTo(amount, vault);
        emit Borrowed(adapter, amount);
    }

    /// @notice Repay loop debt from vault capital (allocator or sentinel de-risk).
    function repay(address adapter, uint256 amount) external onlyAllocatorOrSentinel {
        AdapterConfig memory cfg = adapters[adapter];
        if (!cfg.enabled) revert AdapterNotEnabled(adapter);
        if (!cfg.isLoop) revert AdapterKindMismatch(true);
        if (amount == 0) revert ZeroAmount();
        IERC20(asset).safeTransferFrom(vault, address(this), amount);
        IERC20(asset).forceApprove(adapter, amount);
        uint256 repaid = IMorphoLoopAdapter(adapter).repayFrom(amount);
        IERC20(asset).forceApprove(adapter, 0);
        emit Repaid(adapter, repaid);
    }

    /// @notice Sentinel/allocator de-risk: repay debt and/or withdraw collateral back to the vault.
    function deleverage(address adapter, uint256 repayAmount, uint256 collateralWithdrawn)
        external
        onlyAllocatorOrSentinel
    {
        AdapterConfig memory cfg = adapters[adapter];
        if (!cfg.enabled) revert AdapterNotEnabled(adapter);
        if (!cfg.isLoop) revert AdapterKindMismatch(true);
        uint256 repaid;
        if (repayAmount != 0) {
            IERC20(asset).safeTransferFrom(vault, address(this), repayAmount);
            IERC20(asset).forceApprove(adapter, repayAmount);
            repaid = IMorphoLoopAdapter(adapter).repayFrom(repayAmount);
            IERC20(asset).forceApprove(adapter, 0);
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
