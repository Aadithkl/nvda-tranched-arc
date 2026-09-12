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

    event HookUpdated(address indexed hook);
    event VaultsUpdated(address indexed seniorVault, address indexed juniorVault);
    event KeeperUpdated(address indexed keeper);
    event EscrowBpsUpdated(uint16 escrowBps);
    event DepositReported(bool indexed senior, uint256 hookShares, uint256 usdcValue);
    event RedeemReported(bool indexed senior, uint256 hookShares, uint256 usdcValue);
    event ClaimReported(bool indexed senior, uint256 hookShares);
    event Rebalanced(uint256 movedToSenior, uint256 movedToJunior);
    event RedeemFulfilled(bool indexed senior, address indexed user, uint256 shares, uint256 assets);

    error NotKeeper(address caller);
    error NotVault(address caller);
    error VaultsNotSet();
    error ZeroAddress();
    error InvalidEscrowBps(uint16 escrowBps);
    error SeniorPriority();
    error NothingToFulfill();

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

    function setEscrowBps(uint16 escrowBps_) external onlyOwner {
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
        uint256 value = _valueOf(hookShares);
        if (senior) {
            seniorPrincipal = value > seniorPrincipal ? 0 : seniorPrincipal - value;
            claimableSenior += hookShares;
        } else {
            juniorPrincipal = value > juniorPrincipal ? 0 : juniorPrincipal - value;
            claimableJunior += hookShares;
        }
        emit RedeemReported(senior, hookShares, value);
    }

    /// @notice Called by a vault when a user claims fulfilled redemption assets. The locked
    ///         assets are no longer a liability of the tranche once they leave the vault.
    function onTrancheClaim(bool senior, uint256 hookShares) external override onlyVault {
        _checkVaultDirection(senior);
        if (senior) {
            uint256 locked = claimableSenior;
            claimableSenior = hookShares > locked ? 0 : locked - hookShares;
        } else {
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

    function seniorClaim() public view override returns (uint256) {
        uint256 pool = effectivePool();
        uint256 target = seniorPrincipal + _escrowTarget();
        return target < pool ? target : pool;
    }

    function juniorClaim() public view override returns (uint256) {
        return effectivePool() - seniorClaim();
    }

    function escrowFunded() public view override returns (bool) {
        return effectivePool() >= seniorPrincipal + _escrowTarget();
    }

    function rebalance() public override returns (uint256 movedToSenior, uint256 movedToJunior) {
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

    function fulfillRedeem(bool senior, address user) external onlyKeeper {
        if (seniorVault == address(0)) revert VaultsNotSet();
        if (!senior && TrancheVault(seniorVault).totalPendingRedeemShares() > 0) revert SeniorPriority();

        TrancheVault vault = TrancheVault(senior ? seniorVault : juniorVault);
        uint256 shares = vault.pendingRedeemRequest(0, user);
        if (shares == 0) revert NothingToFulfill();

        rebalance();
        uint256 assets = vault.convertToAssets(shares);
        // Never lock more than the tranche can back after assets already locked for earlier
        // fulfillments; integer dust cannot leave fulfilled claims unbacked.
        IERC20 share = _hookShare();
        uint256 balance = share.balanceOf(address(vault));
        uint256 locked = senior ? claimableSenior : claimableJunior;
        uint256 available = balance > locked ? balance - locked : 0;
        if (assets > available) assets = available;
        vault.fulfillRedeem(shares, assets, user);
        emit RedeemFulfilled(senior, user, shares, assets);
    }

    function _escrowTarget() internal view returns (uint256) {
        return Math.mulDiv(seniorPrincipal, escrowBps, BPS);
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
        return ITrancheHookValue(valueSource).convertToUsdc(hookShares);
    }
}
