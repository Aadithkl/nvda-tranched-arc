// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ITrancheAccountant } from "../interfaces/ITrancheAccountant.sol";
import { ITrancheHookValue } from "../interfaces/ITrancheHookValue.sol";
import { TrancheVault } from "./TrancheVault.sol";

contract TrancheAccountant is ITrancheAccountant, Ownable2Step {
    using Math for uint256;

    uint256 public constant BPS = 10_000;
    uint16 public constant MAX_ESCROW_BPS = 2_000;
    /// @notice Withdrawal epochs run 24h, unix-aligned, immutable. Boundaries advance only
    ///         forward; every exit order waits for the next one (Centrifuge-style).
    uint256 public constant EPOCH_LENGTH = 1 days;
    /// @notice Minimum junior slice of tranche backing, immutable. Exits that would thin
    ///         coverage below it wait (or, frozen, proceed — wind-down opens all doors).
    uint16 public constant MIN_JUNIOR_FLOOR_BPS = 2_500;

    address public hook;
    address public override seniorVault;
    address public override juniorVault;
    address public keeper;
    uint16 public escrowBps;
    uint256 public seniorPrincipal;
    uint256 public juniorPrincipal;
    uint256 public claimableSenior;
    uint256 public claimableJunior;
    uint256 public lastRebalanceAt;
    /// @notice Terminal wind-down flag for final withdrawal (owner-only): lifts the floor so
    ///         every pending exit can go. Set alongside the controller freeze; exits only.
    bool public frozen;
    uint256 public lastExecutedEpoch;

    /// @notice Per-boundary snapshot: side fill fractions (bps) + hook-per-tranche rates (1e18).
    ///         Users claim lazily against these; leftovers auto-roll to the next boundary.
    struct EpochSnap {
        uint64 id;
        uint16 fSeniorBps;
        uint16 fJuniorBps;
        uint256 rateSenior;
        uint256 rateJunior;
    }

    mapping(uint256 => EpochSnap) public epochSnaps;

    event HookUpdated(address indexed hook);
    event VaultsUpdated(address indexed seniorVault, address indexed juniorVault);
    event KeeperUpdated(address indexed keeper);
    event EscrowBpsUpdated(uint16 escrowBps);
    event DepositReported(bool indexed senior, uint256 hookShares, uint256 quoteValue);
    event RedeemReported(bool indexed senior, uint256 hookShares, uint256 quoteValue);
    event ClaimReported(bool indexed senior, uint256 hookShares);
    event Rebalanced(uint256 movedToSenior, uint256 movedToJunior);
    event RedeemFulfilled(bool indexed senior, address indexed user, uint256 shares, uint256 assets);
    event FrozenSet(bool frozen);
    event EpochExecuted(uint256 indexed id, uint16 fSeniorBps, uint16 fJuniorBps);

    error NotKeeper(address caller);
    error NotVault(address caller);
    error VaultsNotSet();
    error ZeroAddress();
    error InvalidEscrowBps(uint16 escrowBps);
    error EscrowLocked();
    error SeniorPriority();
    error NothingToFulfill();
    error EpochNotReady(uint256 id);
    error Expired();

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert NotKeeper(msg.sender);
        _;
    }

    modifier onlyVault() {
        if (msg.sender != seniorVault && msg.sender != juniorVault) revert NotVault(msg.sender);
        _;
    }

    constructor(address owner_) Ownable(owner_ == address(0) ? msg.sender : owner_) {
        escrowBps = 500;
        keeper = msg.sender;
        emit EscrowBpsUpdated(escrowBps);
        emit KeeperUpdated(keeper);
    }

    function setHook(address hook_) external onlyOwner {
        if (hook_ == address(0)) revert ZeroAddress();
        hook = hook_;
        emit HookUpdated(hook_);
    }

    function setVaults(address seniorVault_, address juniorVault_) external onlyOwner {
        if (seniorVault_ == address(0) || juniorVault_ == address(0)) revert ZeroAddress();
        seniorVault = seniorVault_;
        juniorVault = juniorVault_;
        emit VaultsUpdated(seniorVault_, juniorVault_);
    }

    function setKeeper(address keeper_) external onlyOwner {
        if (keeper_ == address(0)) revert ZeroAddress();
        keeper = keeper_;
        emit KeeperUpdated(keeper_);
    }

    function minJuniorFloorBps() external view returns (uint16) {
        return MIN_JUNIOR_FLOOR_BPS;
    }

    function setFrozen(bool frozen_) external onlyOwner {
        frozen = frozen_;
        emit FrozenSet(frozen_);
    }

    /// @notice The senior promise rate is fixed once user money arrives: settable only while
    ///         both principals are zero (pre-first-deposit, or after everyone left). A promise
    ///         that moves under live depositors is not fixed.
    function setEscrowBps(uint16 escrowBps_) external onlyOwner {
        if (seniorPrincipal != 0 || juniorPrincipal != 0) revert EscrowLocked();
        if (escrowBps_ > MAX_ESCROW_BPS) revert InvalidEscrowBps(escrowBps_);
        escrowBps = escrowBps_;
        emit EscrowBpsUpdated(escrowBps_);
    }

    function onTrancheDeposit(bool senior, uint256 hookShares) external override onlyVault {
        _checkVaultDirection(senior);
        uint256 value = _valueOf(hookShares);
        if (senior) {
            seniorPrincipal += value;
        } else {
            juniorPrincipal += value;
        }
        emit DepositReported(senior, hookShares, value);
    }

    function onTrancheRedeem(bool senior, uint256 hookShares) external override onlyVault {
        _checkVaultDirection(senior);
        // Principal is reduced at CLAIM by paid value, not here by requested value: exits may
        // be capped below request (senior promise cap), and reducing early would inflate all
        // future caps. The claimable lock below is exact hook-share units.
        if (senior) {
            claimableSenior += hookShares;
        } else {
            claimableJunior += hookShares;
        }
        emit RedeemReported(senior, hookShares, _valueOf(hookShares));
    }

    /// @notice Called by a vault when a user claims fulfilled redemption assets. The locked
    ///         assets are no longer a liability of the tranche once they leave the vault, and
    ///         principal tracks exactly what was paid (not what was requested).
    ///         Post-settlement the vault reports the FROZEN quote value directly (hook-share
    ///         conversion is meaningless after the shares were burned) — use it 1:1.
    function onTrancheClaim(bool senior, uint256 hookShares) external override onlyVault {
        _checkVaultDirection(senior);
        uint256 value = _expired() ? hookShares : _valueOf(hookShares);
        if (senior) {
            seniorPrincipal = value > seniorPrincipal ? 0 : seniorPrincipal - value;
            uint256 locked = claimableSenior;
            claimableSenior = hookShares > locked ? 0 : locked - hookShares;
        } else {
            juniorPrincipal = value > juniorPrincipal ? 0 : juniorPrincipal - value;
            uint256 locked = claimableJunior;
            claimableJunior = hookShares > locked ? 0 : locked - hookShares;
        }
        emit ClaimReported(senior, hookShares);
    }

    function _checkVaultDirection(bool senior) internal view {
        if (senior && msg.sender != seniorVault) revert NotVault(msg.sender);
        if (!senior && msg.sender != juniorVault) revert NotVault(msg.sender);
    }

    function poolValue() public view override returns (uint256) {
        IERC20 share = _hookShare();
        if (address(share) == address(0)) return 0;
        uint256 totalShares = share.balanceOf(seniorVault) + share.balanceOf(juniorVault);
        return _valueOf(totalShares);
    }

    /// @notice Pool value net of assets already locked for fulfilled redemptions. Those assets
    ///         still sit in the vaults (they back user claims) but are no longer part of the
    ///         tranche P&L, so claims and the JIT risk budget must exclude them.
    function effectivePool() public view returns (uint256) {
        uint256 pool = poolValue();
        uint256 locked = _valueOf(claimableSenior + claimableJunior);
        return pool > locked ? pool - locked : 0;
    }

    /// @notice Senior backing target, principal-only mid-life: the escrow premium is a
    ///         settlement-only promise (paying it early would let senior exit unearned yield
    ///         on day 1). Net of value already locked for senior (else senior could exceed its
    ///         promise across fills); `seniorGuaranteeQuote()` keeps the full promise for the
    ///         waterfall; `juniorClaim()` below keeps the residual including unaccrued escrow.
    ///         Note `rebalance()` adds locked value back when sizing moves — total entitlement.
    function seniorClaim() public view override returns (uint256) {
        uint256 pool = effectivePool();
        uint256 lockedValue = _valueOf(claimableSenior);
        uint256 remaining = lockedValue > seniorPrincipal ? 0 : seniorPrincipal - lockedValue;
        return remaining < pool ? remaining : pool;
    }

    function juniorClaim() public view override returns (uint256) {
        return effectivePool() - seniorClaim();
    }

    function escrowFunded() public view override returns (bool) {
        return effectivePool() >= seniorPrincipal + _escrowTarget();
    }

    /// @notice Senior dust (1 wei) must not lock juniors forever. Priority
    ///         applies only above the dust threshold; frozen wind-down skips it.
    uint256 public constant SENIOR_PRIORITY_DUST = 1e6;

    /// @notice Permissionless `rebalance()` on oracle NAV let anyone pump spot,
    ///         move shares to the attacker tranche, then let the price revert.
    ///         Now keeper-only; epoch/fulfill paths use the internal `_rebalance()`.
    function rebalance() external override returns (uint256 movedToSenior, uint256 movedToJunior) {
        if (msg.sender != keeper) revert NotKeeper(msg.sender);
        return _rebalance();
    }

    function _rebalance() internal returns (uint256 movedToSenior, uint256 movedToJunior) {
        IERC20 share = _hookShare();
        if (address(share) == address(0)) return (0, 0);

        uint256 pool = poolValue();
        uint256 totalShares = share.balanceOf(seniorVault) + share.balanceOf(juniorVault);
        if (pool == 0 || totalShares == 0) {
            lastRebalanceAt = block.timestamp;
            return (0, 0);
        }

        uint256 seniorEntitlement = seniorClaim() + _valueOf(claimableSenior);
        uint256 targetSenior = Math.mulDiv(totalShares, seniorEntitlement, pool);
        uint256 actualSenior = share.balanceOf(seniorVault);

        if (targetSenior > actualSenior) {
            movedToSenior = targetSenior - actualSenior;
            uint256 juniorAvailable = _spendable(share.balanceOf(juniorVault), claimableJunior);
            if (movedToSenior > juniorAvailable) movedToSenior = juniorAvailable;
            if (movedToSenior != 0) TrancheVault(juniorVault).moveShares(seniorVault, movedToSenior);
        } else if (actualSenior > targetSenior) {
            movedToJunior = actualSenior - targetSenior;
            uint256 seniorAvailable = _spendable(share.balanceOf(seniorVault), claimableSenior);
            if (movedToJunior > seniorAvailable) movedToJunior = seniorAvailable;
            if (movedToJunior != 0) TrancheVault(seniorVault).moveShares(juniorVault, movedToJunior);
        }

        lastRebalanceAt = block.timestamp;
        emit Rebalanced(movedToSenior, movedToJunior);
    }

    function fulfillRedeem(bool senior, address user) external {
        if (msg.sender != keeper && !_expired()) revert NotKeeper(msg.sender);
        if (seniorVault == address(0)) revert VaultsNotSet();
        // Dust + frozen bypass — 1 wei of senior pending no longer bricks juniors.
        if (!senior && !frozen) {
            uint256 seniorPending = TrancheVault(seniorVault).totalPendingRedeemShares();
            if (seniorPending > SENIOR_PRIORITY_DUST) revert SeniorPriority();
        }

        TrancheVault vault = TrancheVault(senior ? seniorVault : juniorVault);
        uint256 shares = vault.pendingRedeemRequest(0, user);
        if (shares == 0) revert NothingToFulfill();

        _rebalance();
        uint256 assets = vault.convertToAssets(shares);
        _applyFill(senior, vault, user, shares, assets);
    }

    /// @notice Shared fill path: backing cap (never lock more than the tranche holds net of
    ///         earlier locks) + value cap (senior promise-proportioned, junior residual).
    ///         Floor-rounding favors whoever stays. Emits the fulfillment.
    function _applyFill(bool senior, TrancheVault vault, address user, uint256 shares, uint256 assets) internal {
        IERC20 share = _hookShare();
        uint256 balance = share.balanceOf(address(vault));
        uint256 locked = senior ? claimableSenior : claimableJunior;
        uint256 available = balance > locked ? balance - locked : 0;
        if (assets > available) assets = available;
        uint256 supply = vault.totalSupply();
        if (supply != 0) {
            uint256 entitlement = senior ? seniorClaim() : juniorClaim();
            uint256 hookSupply = share.totalSupply();
            uint256 hookValue = _valueOf(hookSupply);
            if (hookValue != 0) {
                uint256 capShares = entitlement * shares / supply * hookSupply / hookValue;
                if (assets > capShares) assets = capShares;
            }
        }
        vault.fulfillRedeem(shares, assets, user);
        emit RedeemFulfilled(senior, user, shares, assets);
    }

    /// @notice Closes the withdrawal clock past a 24h boundary (permissionless — anyone may pay
    ///         the gas): rebalances once, then snapshots side fill fractions + per-side rates.
    ///         Senior fills first; junior fills within backing, floor (lifted when frozen) and
    ///         the equal-ratio rule (junior % never exceeds senior %). Leftovers auto-roll.
    ///         Refuses once expired — settlement owns exits after that.
    function executeEpoch() external returns (uint256 id) {
        if (_expired()) revert Expired();
        if (seniorVault == address(0)) revert VaultsNotSet();
        id = block.timestamp / EPOCH_LENGTH;
        if (id <= lastExecutedEpoch) revert EpochNotReady(id);

        _rebalance();

        TrancheVault senior = TrancheVault(seniorVault);
        TrancheVault junior = TrancheVault(juniorVault);
        IERC20 share = _hookShare();
        uint256 srReqT = senior.totalPendingRedeemShares();
        uint256 jrReqT = junior.totalPendingRedeemShares();
        uint256 srAvail = _spendable(share.balanceOf(address(senior)), claimableSenior);
        uint256 jrAvail = _spendable(share.balanceOf(address(junior)), claimableJunior);

        (uint256 fSeniorBps, uint256 rateSenior, uint256 srDemA, uint256 fsA) = _seniorFill(senior, srReqT, srAvail);
        (uint256 fJuniorBps, uint256 rateJunior) = _juniorFill(junior, jrReqT, jrAvail, srReqT, srDemA, fsA, srAvail);

        lastExecutedEpoch = id;
        epochSnaps[id] = EpochSnap({
            id: uint64(id),
            fSeniorBps: uint16(fSeniorBps),
            fJuniorBps: uint16(fJuniorBps),
            rateSenior: rateSenior,
            rateJunior: rateJunior
        });
        emit EpochExecuted(id, uint16(fSeniorBps), uint16(fJuniorBps));
    }

    /// @notice Senior side: fill up to demand and backing; rate is hook-per-tranche at the boundary.
    ///         A zero-rate epoch (stale oracle / zeroed NAV) must roll (fBps=0),
    ///         never burn shares for ~nothing.
    function _seniorFill(TrancheVault senior, uint256 reqT, uint256 avail)
        internal
        view
        returns (uint256 fBps, uint256 rate, uint256 demA, uint256 fillA)
    {
        if (reqT == 0) return (10_000, 0, 0, 0);
        demA = senior.convertToAssets(reqT);
        // Zero demand value or zero rate => no fill this epoch (roll, don't burn).
        if (demA == 0) return (0, 0, 0, 0);
        rate = demA * 1e18 / reqT;
        if (rate == 0) return (0, 0, demA, 0);
        fillA = demA < avail ? demA : avail;
        if (fillA == 0) return (0, rate, demA, 0);
        fBps = fillA * 10_000 / demA;
    }

    /// @notice Junior side: demand, backing, floor (lifted when frozen), then equal-ratio.
    ///         Zero-rate epochs roll (fBps=0), never burn.
    function _juniorFill(
        TrancheVault junior,
        uint256 reqT,
        uint256 avail,
        uint256 srReqT,
        uint256 srDemA,
        uint256 fsA,
        uint256 srAvail
    ) internal view returns (uint256 fBps, uint256 rate) {
        if (reqT == 0) return (10_000, 0);
        uint256 demA = junior.convertToAssets(reqT);
        if (demA == 0) return (0, 0);
        rate = demA * 1e18 / reqT;
        if (rate == 0) return (0, 0);
        uint256 maxA = demA < avail ? demA : avail;
        if (!frozen) {
            // Keep post-fill junior backing fraction >= floor:
            // fj <= jrAvail - floor*(srAvail - fsA)/(10000 - floor). fsA <= srAvail by
            // construction, so no underflow below.
            uint256 keep = (srAvail - fsA) * MIN_JUNIOR_FLOOR_BPS / (BPS - MIN_JUNIOR_FLOOR_BPS);
            uint256 floorMax = keep > avail ? 0 : avail - keep;
            if (maxA > floorMax) maxA = floorMax;
        }
        if (srReqT != 0 && srDemA != 0) {
            // Equal-ratio: junior fill % never exceeds senior fill % — unless the senior
            // side holds nothing spendable, in which case there is nothing to protect
            // relatively and the floor above still guards absolutely (no deadlock).
            if (fsA != 0 || srAvail != 0) {
                uint256 ratioMax = demA * fsA / srDemA;
                if (maxA > ratioMax) maxA = ratioMax;
            }
        }
        if (maxA == 0) return (0, rate);
        fBps = maxA * 10_000 / demA;
    }

    /// @notice Claims the caller's pending exit at the latest snapshot (permissionless): fills
    ///         their fraction at the epoch rate through the same caps as keeper fulfills.
    ///         Refuses once expired — matured paths own exits after that.
    ///         Zero-rate / zero-fill snapshots roll (revert), never burn for ~nothing.
    function claimEpoch(bool senior, address user) external {
        if (_expired()) revert Expired();
        if (seniorVault == address(0)) revert VaultsNotSet();
        EpochSnap memory snap = epochSnaps[lastExecutedEpoch];
        if (snap.id == 0) revert EpochNotReady(lastExecutedEpoch);
        TrancheVault vault = TrancheVault(senior ? seniorVault : juniorVault);
        uint256 pending = vault.pendingRedeemRequest(0, user);
        if (pending == 0) revert NothingToFulfill();
        uint256 fBps = senior ? snap.fSeniorBps : snap.fJuniorBps;
        uint256 rate = senior ? snap.rateSenior : snap.rateJunior;
        if (fBps == 0 || rate == 0) revert NothingToFulfill();
        uint256 fillT = pending * fBps / 10_000;
        if (fillT == 0) revert NothingToFulfill();
        uint256 fillA = fillT * rate / 1e18;
        if (fillA == 0) revert NothingToFulfill();
        _applyFill(senior, vault, user, fillT, fillA);
    }

    function _escrowTarget() internal view returns (uint256) {
        return Math.mulDiv(seniorPrincipal, escrowBps, BPS);
    }

    /// @notice Oracle-free senior guarantee: principal plus escrow, in QUOTE units. Used by the
    ///         settlement waterfall, which must not depend on a live oracle.
    function seniorGuaranteeQuote() public view returns (uint256) {
        return seniorPrincipal + _escrowTarget();
    }

    function _expired() internal view returns (bool) {
        address valueSource = hook;
        return valueSource != address(0) && ITrancheHookValue(valueSource).expired();
    }

    function _spendable(uint256 balance, uint256 locked) internal pure returns (uint256) {
        return balance > locked ? balance - locked : 0;
    }

    function _hookShare() internal view returns (IERC20) {
        if (seniorVault == address(0)) return IERC20(address(0));
        return IERC20(address(TrancheVault(seniorVault).hookShare()));
    }

    function _valueOf(uint256 hookShares) internal view returns (uint256) {
        address valueSource = hook;
        if (valueSource == address(0) || hookShares == 0) return 0;
        return ITrancheHookValue(valueSource).convertToQuote(hookShares);
    }
}
