// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { HookParams } from "../hook/libraries/HookParams.sol";
import { ITrancheHookParams } from "./ITrancheHookParams.sol";
import { IRebalanceModule } from "../interfaces/IRebalanceModule.sol";

contract StrategyController {
    uint16 public constant MAX_DEVIATION_BPS = 5_000;
    uint16 public constant MAX_TOXICITY_MULTIPLIER_BPS = 10_000;
    uint32 public constant MAX_TTL = 86_400;
    uint32 public constant MAX_GRACE_PERIOD = 86_400;

    struct Bounds {
        uint16 maxDeviationBps;
        uint16 maxToxicityMultiplierBps;
        uint32 maxTtl;
        uint32 maxGracePeriod;
        uint128 maxDeployPerSwap;
        uint128 maxRebalanceSwapUsdc;
        uint32 rebalanceCooldown;
    }

    address public owner;
    address public pendingOwner;
    address public guardian;
    address public hook;
    address public rebalanceTarget;
    mapping(address => bool) public agents;
    Bounds public bounds;
    bool public paused;
    uint256 public lastRebalanceAt;

    event OwnerUpdated(address indexed owner);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event GuardianUpdated(address indexed guardian);
    event PausedSet(bool paused);
    event HookUpdated(address indexed hook);
    event RebalanceTargetUpdated(address indexed rebalanceTarget);
    event AgentUpdated(address indexed agent, bool allowed);
    event BoundsUpdated(Bounds bounds);
    event ParamsSubmitted(address indexed agent, HookParams.Params params);
    event BaseFeeSubmitted(address indexed agent, uint24 baseFee);
    event QuotingSubmitted(address indexed agent, bool enabled);
    event RebalanceSubmitted(address indexed agent, bool equityOut, uint256 amountIn, uint256 minOut, uint256 deadline);

    error NotOwner(address caller);
    error NotPendingOwner(address caller);
    error NotGuardianOrOwner(address caller);
    error NotAgent(address caller);
    error HookNotSet();
    error ZeroAddress();
    error IsPaused();
    error InvalidBounds();
    error DeadlineExpired(uint256 deadline);
    error DeviationTooHigh(uint16 maxDeviationBps, uint16 bound);
    error MultiplierTooHigh(uint16 toxicityMultiplierBps, uint16 bound);
    error TtlTooLong(uint32 ttl, uint32 bound);
    error GraceTooLong(uint32 gracePeriod, uint32 bound);
    error DeployTooHigh(uint128 maxDeployPerSwap, uint128 bound);
    error RebalanceTooLarge(uint256 amountIn, uint256 maxAmountIn);
    error RebalanceCooldownActive(uint256 readyAt);
    error RebalanceTargetNotSet();
    error ZeroAmount();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    modifier onlyAgent() {
        if (!agents[msg.sender]) revert NotAgent(msg.sender);
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert IsPaused();
        _;
    }

    constructor(address owner_) {
        owner = owner_ == address(0) ? msg.sender : owner_;
        guardian = owner;
        bounds = Bounds({
            maxDeviationBps: 500,
            maxToxicityMultiplierBps: 2_500,
            maxTtl: 3_600,
            maxGracePeriod: 3_600,
            maxDeployPerSwap: 100_000e6,
            maxRebalanceSwapUsdc: 10_000e6,
            rebalanceCooldown: 0
        });
        _validateBounds(bounds);
        emit OwnerUpdated(owner);
        emit GuardianUpdated(guardian);
        emit BoundsUpdated(bounds);
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

    function setGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert ZeroAddress();
        guardian = newGuardian;
        emit GuardianUpdated(newGuardian);
    }

    function setPaused(bool paused_) external {
        if (msg.sender != owner && msg.sender != guardian) revert NotGuardianOrOwner(msg.sender);
        paused = paused_;
        emit PausedSet(paused_);
    }

    function setHook(address hook_) external onlyOwner {
        if (hook_ == address(0)) revert ZeroAddress();
        hook = hook_;
        emit HookUpdated(hook_);
    }

    function setRebalanceTarget(address target) external onlyOwner {
        rebalanceTarget = target;
        emit RebalanceTargetUpdated(target);
    }

    function setAgent(address agent, bool allowed) external onlyOwner {
        if (agent == address(0)) revert ZeroAddress();
        agents[agent] = allowed;
        emit AgentUpdated(agent, allowed);
    }

    function setBounds(Bounds calldata newBounds) external onlyOwner {
        _validateBounds(newBounds);
        bounds = newBounds;
        emit BoundsUpdated(newBounds);
    }

    function setHookParams(HookParams.Params calldata newParams) external onlyAgent whenNotPaused {
        _checkBounds(newParams);
        _hook().setParams(newParams);
        emit ParamsSubmitted(msg.sender, newParams);
    }

    function setBaseFee(uint24 baseFee) external onlyAgent whenNotPaused {
        _hook().setBaseFee(baseFee);
        emit BaseFeeSubmitted(msg.sender, baseFee);
    }

    function setQuotingEnabled(bool enabled) external onlyAgent {
        // While paused the agent may still reduce risk (disable quoting) but never re-enable it.
        if (enabled && paused) revert IsPaused();
        _hook().setQuotingEnabled(enabled);
        emit QuotingSubmitted(msg.sender, enabled);
    }

    function submitRebalance(bool equityOut, uint256 amountIn, uint256 minOut, uint256 deadline)
        external
        onlyAgent
        whenNotPaused
    {
        if (amountIn == 0) revert ZeroAmount();
        if (block.timestamp > deadline) revert DeadlineExpired(deadline);
        address target = rebalanceTarget;
        if (target == address(0)) revert RebalanceTargetNotSet();
        Bounds memory b = bounds;
        uint256 usdcValue = equityOut ? IRebalanceModule(target).equityToUsdc(amountIn) : amountIn;
        if (usdcValue > b.maxRebalanceSwapUsdc) revert RebalanceTooLarge(usdcValue, b.maxRebalanceSwapUsdc);
        if (lastRebalanceAt != 0 && block.timestamp < lastRebalanceAt + b.rebalanceCooldown) {
            revert RebalanceCooldownActive(lastRebalanceAt + b.rebalanceCooldown);
        }
        lastRebalanceAt = block.timestamp;
        IRebalanceModule(target).rebalanceSwap(equityOut, amountIn, minOut, deadline);
        emit RebalanceSubmitted(msg.sender, equityOut, amountIn, minOut, deadline);
    }

    function _validateBounds(Bounds memory b) internal pure {
        if (
            b.maxDeviationBps > MAX_DEVIATION_BPS || b.maxToxicityMultiplierBps > MAX_TOXICITY_MULTIPLIER_BPS
                || b.maxTtl == 0 || b.maxTtl > MAX_TTL || b.maxGracePeriod > MAX_GRACE_PERIOD || b.maxDeployPerSwap == 0
                || b.maxRebalanceSwapUsdc == 0
        ) revert InvalidBounds();
    }

    function _hook() internal view returns (ITrancheHookParams) {
        address hook_ = hook;
        if (hook_ == address(0)) revert HookNotSet();
        return ITrancheHookParams(hook_);
    }

    function _checkBounds(HookParams.Params calldata p) internal view {
        Bounds memory b = bounds;
        if (p.maxDeviationBps > b.maxDeviationBps) revert DeviationTooHigh(p.maxDeviationBps, b.maxDeviationBps);
        if (p.toxicityMultiplierBps > b.maxToxicityMultiplierBps) {
            revert MultiplierTooHigh(p.toxicityMultiplierBps, b.maxToxicityMultiplierBps);
        }
        if (p.ttl > b.maxTtl) revert TtlTooLong(p.ttl, b.maxTtl);
        if (p.gracePeriod > b.maxGracePeriod) revert GraceTooLong(p.gracePeriod, b.maxGracePeriod);
        if (p.maxDeployPerSwap > b.maxDeployPerSwap) revert DeployTooHigh(p.maxDeployPerSwap, b.maxDeployPerSwap);
    }
}
