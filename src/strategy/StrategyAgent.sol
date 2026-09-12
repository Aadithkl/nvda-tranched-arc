// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { HookParams } from "../hook/libraries/HookParams.sol";
import { IStrategyController } from "./IStrategyController.sol";

contract StrategyAgent {
    address public owner;
    address public pendingOwner;
    address public operator;
    IStrategyController public controller;

    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event OwnerUpdated(address indexed owner);
    event OperatorUpdated(address indexed operator);
    event ControllerUpdated(address indexed controller);
    event ParamsSubmitted(HookParams.Params params);
    event BaseFeeSubmitted(uint24 baseFee);
    event QuotingSubmitted(bool enabled);
    event RebalanceSubmitted(bool equityOut, uint256 amountIn, uint256 minOut, uint256 deadline);

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
        controller = IStrategyController(controller_);
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
        controller = IStrategyController(newController);
        emit ControllerUpdated(newController);
    }

    function submitParams(HookParams.Params calldata params) external onlyOperator {
        controller.setHookParams(params);
        emit ParamsSubmitted(params);
    }

    function submitBaseFee(uint24 baseFee) external onlyOperator {
        controller.setBaseFee(baseFee);
        emit BaseFeeSubmitted(baseFee);
    }

    function submitQuotingEnabled(bool enabled) external onlyOperator {
        controller.setQuotingEnabled(enabled);
        emit QuotingSubmitted(enabled);
    }

    function submitRebalance(bool equityOut, uint256 amountIn, uint256 minOut, uint256 deadline) external onlyOperator {
        controller.submitRebalance(equityOut, amountIn, minOut, deadline);
        emit RebalanceSubmitted(equityOut, amountIn, minOut, deadline);
    }
}
