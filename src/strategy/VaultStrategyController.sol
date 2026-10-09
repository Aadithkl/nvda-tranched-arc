// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { GuardParams } from "../hook/libraries/GuardParams.sol";

interface IVaultStrategy {
    function setGuardParams(GuardParams.Params calldata params) external;
    function recenterGuard() external;
    function setHookDeployEnabled(bool enabled) external;
    function recallFromHook() external;
    function fundHook(uint256 quoteAmount, uint256 equityAmount) external;
    function rebalanceSwap(bool equityOut, uint256 amountIn, uint256 minOut, uint256 deadline) external;
    function equityToUsdc(uint256 equityAmount) external view returns (uint256);
}

/// @notice Bounded control plane for `RegimeVault`: the agent (offchain operator) may only move the
///         vault inside hard rails — guard band widths, liquidity caps, EV floor, recheck cadence,
///         funding caps and recenter/rebalance cooldowns. The vault keeper is set to this
///         controller, so every agent action flows through here while the vault owner keeps direct
///         access for governance.
contract VaultStrategyController {
    int24 public constant MAX_TICK_WIDTH = 100_000;
    uint16 public constant MAX_BPS = 10_000;
    uint32 public constant MAX_RECHECK_INTERVAL = 86_400;
    uint32 public constant MAX_PRICE_AGE = 86_400;

    struct Bounds {
        int24 maxGuardTickWidth;
        int24 maxBaseTickWidth;
        uint128 maxGuardLiquidity;
        uint128 maxBaseLiquidity;
        uint16 maxMinEvBps;
        uint32 minRecheckInterval;
        uint32 maxRecheckInterval;
        uint16 maxRecheckMaxDeviationBps;
        uint32 maxMaxPriceAge;
        uint256 maxFundQuotePerCall;
        uint256 maxFundEquityPerCall;
        uint256 maxRebalanceSwapUsdc;
        uint32 recenterCooldown;
        uint32 rebalanceCooldown;
    }

    address public owner;
    address public pendingOwner;
    address public guardian;
    address public vault;
    mapping(address => bool) public agents;
    Bounds public bounds;
    bool public paused;
    uint256 public lastRecenterAt;
    uint256 public lastRebalanceAt;

    event OwnerUpdated(address indexed owner);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event GuardianUpdated(address indexed guardian);
    event PausedSet(bool paused);
    event VaultUpdated(address indexed vault);
    event AgentUpdated(address indexed agent, bool allowed);
    event BoundsUpdated(Bounds bounds);
    event GuardParamsSubmitted(address indexed agent, GuardParams.Params params);
    event RecenterSubmitted(address indexed agent);
    event DeployEnabledSubmitted(address indexed agent, bool enabled);
    event RecallSubmitted(address indexed agent);
    event FundSubmitted(address indexed agent, uint256 quoteAmount, uint256 equityAmount);
    event RebalanceSubmitted(address indexed agent, bool equityOut, uint256 amountIn, uint256 minOut, uint256 deadline);

    error NotOwner(address caller);
    error NotPendingOwner(address caller);
    error NotGuardianOrOwner(address caller);
    error NotAgent(address caller);
    error VaultNotSet();
    error ZeroAddress();
    error IsPaused();
    error InvalidBounds();
    error ZeroAmount();
    error GuardWidthTooLarge(int24 width, int24 bound);
    error BaseWidthTooLarge(int24 width, int24 bound);
    error GuardLiquidityTooLarge(uint128 liquidity, uint128 bound);
    error BaseLiquidityTooLarge(uint128 liquidity, uint128 bound);
    error MinEvTooHigh(uint16 minEvBps, uint16 bound);
    error RecheckIntervalOutOfRange(uint32 interval, uint32 min, uint32 max);
    error RecheckDeviationTooHigh(uint16 deviationBps, uint16 bound);
    error MaxPriceAgeTooHigh(uint32 maxPriceAge, uint32 bound);
    error FundTooLarge(uint256 amount, uint256 bound);
    error NothingToFund();
    error RebalanceTooLarge(uint256 usdcValue, uint256 maxAmountIn);
    error RecenterCooldownActive(uint256 readyAt);
    error RebalanceCooldownActive(uint256 readyAt);
    error DeadlineExpired(uint256 deadline);

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
            maxGuardTickWidth: 3_000,
            maxBaseTickWidth: 30_000,
            maxGuardLiquidity: 5_000e12,
            maxBaseLiquidity: 500e12,
            maxMinEvBps: 100,
            minRecheckInterval: 60,
            maxRecheckInterval: 3_600,
            maxRecheckMaxDeviationBps: 500,
            maxMaxPriceAge: 900,
            maxFundQuotePerCall: 100_000e6,
            maxFundEquityPerCall: 1_000e18,
            maxRebalanceSwapUsdc: 10_000e6,
            recenterCooldown: 60,
            rebalanceCooldown: 0
        });
        _validateBounds(bounds);
        emit OwnerUpdated(owner);
        emit GuardianUpdated(guardian);
        emit BoundsUpdated(bounds);
    }

    // ---------------------------------------------------------------------
    // Ownership / config
    // ---------------------------------------------------------------------

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

    function setVault(address vault_) external onlyOwner {
        if (vault_ == address(0)) revert ZeroAddress();
        vault = vault_;
        emit VaultUpdated(vault_);
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

    // ---------------------------------------------------------------------
    // Agent surface (bounded)
    // ---------------------------------------------------------------------

    function submitGuardParams(GuardParams.Params calldata params) external onlyAgent whenNotPaused {
        _checkBounds(params);
        _vault().setGuardParams(params);
        emit GuardParamsSubmitted(msg.sender, params);
    }

    function submitRecenter() external onlyAgent whenNotPaused {
        Bounds memory b = bounds;
        if (lastRecenterAt != 0 && block.timestamp < lastRecenterAt + b.recenterCooldown) {
            revert RecenterCooldownActive(lastRecenterAt + b.recenterCooldown);
        }
        lastRecenterAt = block.timestamp;
        _vault().recenterGuard();
        emit RecenterSubmitted(msg.sender);
    }

    /// @dev The agent may always stand the book down; re-enabling deployments needs an unpaused controller.
    function submitDeployEnabled(bool enabled) external onlyAgent {
        if (enabled && paused) revert IsPaused();
        _vault().setHookDeployEnabled(enabled);
        emit DeployEnabledSubmitted(msg.sender, enabled);
    }

    /// @dev De-risking call: allowed while paused.
    function submitRecall() external onlyAgent {
        _vault().recallFromHook();
        emit RecallSubmitted(msg.sender);
    }

    function submitFund(uint256 quoteAmount, uint256 equityAmount) external onlyAgent whenNotPaused {
        Bounds memory b = bounds;
        if (quoteAmount == 0 && equityAmount == 0) revert NothingToFund();
        if (quoteAmount > b.maxFundQuotePerCall) revert FundTooLarge(quoteAmount, b.maxFundQuotePerCall);
        if (equityAmount > b.maxFundEquityPerCall) revert FundTooLarge(equityAmount, b.maxFundEquityPerCall);
        _vault().fundHook(quoteAmount, equityAmount);
        emit FundSubmitted(msg.sender, quoteAmount, equityAmount);
    }

    function submitRebalance(bool equityOut, uint256 amountIn, uint256 minOut, uint256 deadline)
        external
        onlyAgent
        whenNotPaused
    {
        if (amountIn == 0) revert ZeroAmount();
        if (block.timestamp > deadline) revert DeadlineExpired(deadline);
        Bounds memory b = bounds;
        uint256 usdcValue = equityOut ? _vault().equityToUsdc(amountIn) : amountIn;
        if (usdcValue > b.maxRebalanceSwapUsdc) revert RebalanceTooLarge(usdcValue, b.maxRebalanceSwapUsdc);
        if (lastRebalanceAt != 0 && block.timestamp < lastRebalanceAt + b.rebalanceCooldown) {
            revert RebalanceCooldownActive(lastRebalanceAt + b.rebalanceCooldown);
        }
        lastRebalanceAt = block.timestamp;
        _vault().rebalanceSwap(equityOut, amountIn, minOut, deadline);
        emit RebalanceSubmitted(msg.sender, equityOut, amountIn, minOut, deadline);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _vault() internal view returns (IVaultStrategy) {
        address vault_ = vault;
        if (vault_ == address(0)) revert VaultNotSet();
        return IVaultStrategy(vault_);
    }

    function _validateBounds(Bounds memory b) internal pure {
        if (
            b.maxGuardTickWidth <= 0 || b.maxGuardTickWidth > MAX_TICK_WIDTH || b.maxBaseTickWidth <= 0
                || b.maxBaseTickWidth > MAX_TICK_WIDTH || b.maxGuardLiquidity == 0 || b.maxBaseLiquidity == 0
                || b.maxMinEvBps > MAX_BPS || b.minRecheckInterval == 0 || b.maxRecheckInterval < b.minRecheckInterval
                || b.maxRecheckInterval > MAX_RECHECK_INTERVAL || b.maxRecheckMaxDeviationBps > MAX_BPS
                || b.maxMaxPriceAge == 0 || b.maxMaxPriceAge > MAX_PRICE_AGE || b.maxFundQuotePerCall == 0
                || b.maxRebalanceSwapUsdc == 0
        ) revert InvalidBounds();
    }

    function _checkBounds(GuardParams.Params calldata p) internal view {
        Bounds memory b = bounds;
        if (p.guardTickWidth > b.maxGuardTickWidth) revert GuardWidthTooLarge(p.guardTickWidth, b.maxGuardTickWidth);
        if (p.baseTickWidth > b.maxBaseTickWidth) revert BaseWidthTooLarge(p.baseTickWidth, b.maxBaseTickWidth);
        if (p.guardLiquidity > b.maxGuardLiquidity) {
            revert GuardLiquidityTooLarge(p.guardLiquidity, b.maxGuardLiquidity);
        }
        if (p.baseLiquidity > b.maxBaseLiquidity) revert BaseLiquidityTooLarge(p.baseLiquidity, b.maxBaseLiquidity);
        if (p.minEvBps > b.maxMinEvBps) revert MinEvTooHigh(p.minEvBps, b.maxMinEvBps);
        if (p.recheckInterval < b.minRecheckInterval || p.recheckInterval > b.maxRecheckInterval) {
            revert RecheckIntervalOutOfRange(p.recheckInterval, b.minRecheckInterval, b.maxRecheckInterval);
        }
        if (p.recheckMaxDeviationBps > b.maxRecheckMaxDeviationBps) {
            revert RecheckDeviationTooHigh(p.recheckMaxDeviationBps, b.maxRecheckMaxDeviationBps);
        }
        if (p.maxPriceAge > b.maxMaxPriceAge) revert MaxPriceAgeTooHigh(p.maxPriceAge, b.maxMaxPriceAge);
    }
}
