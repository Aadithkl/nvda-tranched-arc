// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { HookParams } from "../hook/libraries/HookParams.sol";
import { ITrancheHookParams } from "./ITrancheHookParams.sol";

contract StrategyController {
    struct Bounds {
        uint24 maxBaseFee;
        uint24 maxSurgeFee;
        uint16 maxDeviationBps;
        uint16 maxToxicityMultiplierBps;
        uint32 maxTtl;
        uint32 maxGracePeriod;
        uint128 maxDeployPerSwap;
    }

    address public owner;
    address public hook;
    mapping(address => bool) public agents;
    Bounds public bounds;

    event OwnerUpdated(address indexed owner);
    event HookUpdated(address indexed hook);
    event AgentUpdated(address indexed agent, bool allowed);
    event BoundsUpdated(Bounds bounds);
    event ParamsSubmitted(address indexed agent, HookParams.Params params);
    event BaseFeeSubmitted(address indexed agent, uint24 baseFee);
    event QuotingSubmitted(address indexed agent, bool enabled);

    error NotOwner(address caller);
    error NotAgent(address caller);
    error HookNotSet();
    error ZeroAddress();
    error BaseFeeTooHigh(uint24 baseFee, uint24 maxBaseFee);
    error SurgeFeeTooHigh(uint24 maxSurgeFee, uint24 bound);
    error DeviationTooHigh(uint16 maxDeviationBps, uint16 bound);
    error MultiplierTooHigh(uint16 toxicityMultiplierBps, uint16 bound);
    error TtlTooLong(uint32 ttl, uint32 bound);
    error GraceTooLong(uint32 gracePeriod, uint32 bound);
    error DeployTooHigh(uint128 maxDeployPerSwap, uint128 bound);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    modifier onlyAgent() {
        if (!agents[msg.sender]) revert NotAgent(msg.sender);
        _;
    }

    constructor(address owner_) {
        owner = owner_ == address(0) ? msg.sender : owner_;
        bounds = Bounds({
            maxBaseFee: 10_000,
            maxSurgeFee: 100_000,
            maxDeviationBps: 500,
            maxToxicityMultiplierBps: 2_500,
            maxTtl: 3_600,
            maxGracePeriod: 3_600,
            maxDeployPerSwap: 100_000e6
        });
        emit OwnerUpdated(owner);
        emit BoundsUpdated(bounds);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        owner = newOwner;
        emit OwnerUpdated(newOwner);
    }

    function setHook(address hook_) external onlyOwner {
        if (hook_ == address(0)) revert ZeroAddress();
        hook = hook_;
        emit HookUpdated(hook_);
    }

    function setAgent(address agent, bool allowed) external onlyOwner {
        if (agent == address(0)) revert ZeroAddress();
        agents[agent] = allowed;
        emit AgentUpdated(agent, allowed);
    }

    function setBounds(Bounds calldata newBounds) external onlyOwner {
        bounds = newBounds;
        emit BoundsUpdated(newBounds);
    }

    function setHookParams(HookParams.Params calldata newParams) external onlyAgent {
        _checkBounds(newParams);
        _hook().setParams(newParams);
        emit ParamsSubmitted(msg.sender, newParams);
    }

    function setBaseFee(uint24 baseFee) external onlyAgent {
        if (baseFee > bounds.maxBaseFee) revert BaseFeeTooHigh(baseFee, bounds.maxBaseFee);
        _hook().setBaseFee(baseFee);
        emit BaseFeeSubmitted(msg.sender, baseFee);
    }

    function setQuotingEnabled(bool enabled) external onlyAgent {
        _hook().setQuotingEnabled(enabled);
        emit QuotingSubmitted(msg.sender, enabled);
    }

    function _hook() internal view returns (ITrancheHookParams) {
        address hook_ = hook;
        if (hook_ == address(0)) revert HookNotSet();
        return ITrancheHookParams(hook_);
    }

    function _checkBounds(HookParams.Params calldata p) internal view {
        Bounds memory b = bounds;
        if (p.baseFee > b.maxBaseFee) revert BaseFeeTooHigh(p.baseFee, b.maxBaseFee);
        if (p.maxSurgeFee > b.maxSurgeFee) revert SurgeFeeTooHigh(p.maxSurgeFee, b.maxSurgeFee);
        if (p.maxDeviationBps > b.maxDeviationBps) revert DeviationTooHigh(p.maxDeviationBps, b.maxDeviationBps);
        if (p.toxicityMultiplierBps > b.maxToxicityMultiplierBps) {
            revert MultiplierTooHigh(p.toxicityMultiplierBps, b.maxToxicityMultiplierBps);
        }
        if (p.ttl > b.maxTtl) revert TtlTooLong(p.ttl, b.maxTtl);
        if (p.gracePeriod > b.maxGracePeriod) revert GraceTooLong(p.gracePeriod, b.maxGracePeriod);
        if (p.maxDeployPerSwap > b.maxDeployPerSwap) revert DeployTooHigh(p.maxDeployPerSwap, b.maxDeployPerSwap);
    }
}
