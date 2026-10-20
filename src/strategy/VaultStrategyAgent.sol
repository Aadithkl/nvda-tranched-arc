// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { GuardParams } from "../hook/libraries/GuardParams.sol";
import { VaultStrategyController } from "./VaultStrategyController.sol";

/// @notice Operator-key call surface for `VaultStrategyController`. The offchain agent holds only
///         the operator key; the controller enforces bounds and can be whitelisted on the
///         `LedgerVault` as its keeper.
contract VaultStrategyAgent {
    address public owner;
    address public pendingOwner;
    address public operator;
    VaultStrategyController public controller;

    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event OwnerUpdated(address indexed owner);
    event OperatorUpdated(address indexed operator);
    event ControllerUpdated(address indexed controller);
    event GuardParamsSubmitted(GuardParams.Params params);
    event RecenterSubmitted();
    event DeployEnabledSubmitted(bool enabled);
    event RecallSubmitted();
    event FundSubmitted(uint256 quoteAmount, uint256 equityAmount);
    event RebalanceSubmitted(bool equityOut, uint256 amountIn, uint256 minOut, uint256 deadline);
    event ApproveStrategySubmitted(address token, uint256 amount);
    event AllocateSubmitted(address adapter, uint256 amount);
    event DeallocateSubmitted(address adapter, uint256 withdrawn);
    event RepaySubmitted(address adapter, uint256 amount);
    event DeleverageSubmitted(address adapter, uint256 repayAmount, uint256 collateralWithdrawn);
    event SwitchStaged(uint8 toBook);
    event AdapterDisabledSubmitted(address adapter);
    event CapsLoweredSubmitted(address adapter, uint256 absoluteCap, uint16 relativeCapBps);
    event PendingCancelledSubmitted(address adapter);
    event CollateralAllocatedSubmitted(address adapter, uint256 amount);
    event BorrowSubmitted(address adapter, uint256 amount);

    error NotOwner(address caller);
    error NotPendingOwner(address caller);
    error NotOperator(address caller);
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator(msg.sender);
        _;
    }

    constructor(address owner_, address operator_, address controller_) {
        if (controller_ == address(0) || operator_ == address(0)) revert ZeroAddress();
        owner = owner_ == address(0) ? msg.sender : owner_;
        operator = operator_;
        controller = VaultStrategyController(controller_);
        emit OwnerUpdated(owner);
        emit OperatorUpdated(operator_);
        emit ControllerUpdated(controller_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner(msg.sender);
        pendingOwner = address(0);
        owner = msg.sender;
        emit OwnerUpdated(msg.sender);
    }

    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert ZeroAddress();
        operator = newOperator;
        emit OperatorUpdated(newOperator);
    }

    function setController(address newController) external onlyOwner {
        if (newController == address(0)) revert ZeroAddress();
        controller = VaultStrategyController(newController);
        emit ControllerUpdated(newController);
    }

    function submitGuardParams(GuardParams.Params calldata params) external onlyOperator {
        controller.submitGuardParams(params);
        emit GuardParamsSubmitted(params);
    }

    function submitRecenter() external onlyOperator {
        controller.submitRecenter();
        emit RecenterSubmitted();
    }

    function submitDeployEnabled(bool enabled) external onlyOperator {
        controller.submitDeployEnabled(enabled);
        emit DeployEnabledSubmitted(enabled);
    }

    function submitRecall() external onlyOperator {
        controller.submitRecall();
        emit RecallSubmitted();
    }

    function submitFund(uint256 quoteAmount, uint256 equityAmount) external onlyOperator {
        controller.submitFund(quoteAmount, equityAmount);
        emit FundSubmitted(quoteAmount, equityAmount);
    }

    function submitSupplyIdle() external onlyOperator returns (uint256 supplied) {
        supplied = controller.submitSupplyIdle();
    }

    function submitSupplyIdleAmount(uint256 amount) external onlyOperator returns (uint256 supplied) {
        supplied = controller.submitSupplyIdleAmount(amount);
    }

    function submitWithdrawFromVenue(uint256 amount) external onlyOperator returns (uint256 withdrawn) {
        withdrawn = controller.submitWithdrawFromVenue(amount);
    }

    function submitCheckDepeg() external onlyOperator returns (bool paused_) {
        paused_ = controller.submitCheckDepeg();
    }

    function submitResumeFromDepeg() external onlyOperator {
        controller.submitResumeFromDepeg();
    }

    function submitRebalance(bool equityOut, uint256 amountIn, uint256 minOut, uint256 deadline) external onlyOperator {
        controller.submitRebalance(equityOut, amountIn, minOut, deadline);
        emit RebalanceSubmitted(equityOut, amountIn, minOut, deadline);
    }

    function submitAllocate(address adapter, uint256 amount) external onlyOperator {
        controller.submitAllocate(adapter, amount);
        emit AllocateSubmitted(adapter, amount);
    }

    /// @notice One-shot exact approval for the strategy module's next pull.
    function submitApproveStrategy(address token, uint256 amount) external onlyOperator {
        controller.submitApproveStrategy(token, amount);
        emit ApproveStrategySubmitted(token, amount);
    }

    function submitDeallocate(address adapter, uint256 amount) external onlyOperator returns (uint256 withdrawn) {
        withdrawn = controller.submitDeallocate(adapter, amount);
        emit DeallocateSubmitted(adapter, withdrawn);
    }

    function submitRepay(address adapter, uint256 amount) external onlyOperator {
        controller.submitRepay(adapter, amount);
        emit RepaySubmitted(adapter, amount);
    }

    function submitDeleverage(address adapter, uint256 repayAmount, uint256 collateralWithdrawn) external onlyOperator {
        controller.submitDeleverage(adapter, repayAmount, collateralWithdrawn);
        emit DeleverageSubmitted(adapter, repayAmount, collateralWithdrawn);
    }

    function submitSwitchBook(uint8 toBook) external onlyOperator {
        controller.submitSwitchBook(toBook);
        emit SwitchStaged(toBook);
    }

    function submitDisableAdapter(address adapter) external onlyOperator {
        controller.submitDisableAdapter(adapter);
        emit AdapterDisabledSubmitted(adapter);
    }

    function submitLowerCaps(address adapter, uint256 absoluteCap, uint16 relativeCapBps) external onlyOperator {
        controller.submitLowerCaps(adapter, absoluteCap, relativeCapBps);
        emit CapsLoweredSubmitted(adapter, absoluteCap, relativeCapBps);
    }

    function submitCancelPending(address adapter) external onlyOperator {
        controller.submitCancelPending(adapter);
        emit PendingCancelledSubmitted(adapter);
    }

    function submitAllocateCollateral(address adapter, uint256 amount) external onlyOperator {
        controller.submitAllocateCollateral(adapter, amount);
        emit CollateralAllocatedSubmitted(adapter, amount);
    }

    function submitBorrow(address adapter, uint256 amount) external onlyOperator {
        controller.submitBorrow(adapter, amount);
        emit BorrowSubmitted(adapter, amount);
    }
}
