// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { GuardParams } from "../hook/libraries/GuardParams.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { PoolKey } from "v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "v4-core/src/types/PoolId.sol";
import { Currency, CurrencyLibrary } from "v4-core/src/types/Currency.sol";
import { ITrancheAccountant } from "../interfaces/ITrancheAccountant.sol";
import { IStrategyModule } from "../adapters/IStrategyModule.sol";

interface IVaultStrategy {
    function setGuardParams(GuardParams.Params calldata params) external;
    function recenterGuard() external;
    function setHookDeployEnabled(bool enabled) external;
    function recallFromHook() external;
    function fundHook(uint256 quoteAmount, uint256 equityAmount) external;
    function pullForRebalance(address token, uint256 amount) external;
    function equityToQuote(uint256 equityAmount) external view returns (uint256);
    function quoteToEquity(uint256 quoteAmount) external view returns (uint256);
    function quote() external view returns (IERC20);
    function equity() external view returns (IERC20);
    function accountant() external view returns (address);
    function expired() external view returns (bool);
    function oracleValid() external view returns (bool);
}

interface ISwapRouter {
    function swapExactIn(
        PoolKey calldata key,
        bool zeroForOne,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256 deadline
    ) external;
}

/// @notice Minimal dual-book hub surface the controller needs for atomic migration.
interface IDualBookHub {
    function pullInactiveAndActivate(uint8 to) external;
    function pushToActive() external;
    function activateAndDeploy() external;
}

/// @notice Bounded control plane for `LedgerVault`: the agent (offchain operator) may only move the
///         vault inside hard rails — guard band widths, liquidity caps, EV floor, recheck cadence,
///         funding caps and recenter/rebalance cooldowns. The vault keeper is set to this
///         controller, so every agent action flows through here while the vault owner keeps direct
///         access for governance.
contract VaultStrategyController is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;

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
        uint256 maxRebalanceSwapQuote;
        uint256 maxAllocatePerCall;
        uint256 maxCollateralPerCall;
        uint256 maxBorrowPerCall;
        uint32 recenterCooldown;
        uint32 rebalanceCooldown;
    }

    /// @notice Target mix across venues in bps (must sum to 10_000). Guides the offchain
    ///         1-2 h loop; onchain enforces per-call caps, cooldowns and module caps.
    struct Targets {
        uint16 hookBps;
        uint16 morphoQuoteBps;
        uint16 morphoEquityBps;
        uint16 idleBps;
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

    PoolKey internal _rebalanceKey;
    address public rebalanceRouter;
    uint16 public maxRebalanceSlippageBps = 100;

    /// @notice Bottom-layer strategy venues: one quote-asset Morpho module covers both
    ///         sleeves (WETH lend + NVDA-collateral loop). The controller is set as its
    ///         allocator (moves within caps) and sentinel (de-risk only).
    address public strategyModule;

    /// @notice Two-book registry: hook A (low fee) + hook B (high fee). `activeBook` is
    ///         0 for A, 1 for B. Switching stands the old book down to idle and stages the
    ///         new one; funding the new book lands with the hub (atomic migrate).
    address public bookA;
    address public bookB;
    /// @notice Dual-book hub (owns both hooks). When set, a switch migrates atomically:
    ///         stand the old book down, fund the new book, arm its guard — one agent call.
    ///         When unset the deployment is single-book and a switch only recalls to the vault.
    address public hub;
    uint8 public activeBook;
    uint32 public switchDwell = 1 hours;
    /// @notice Terminal wind-down flag for final withdrawal: while set, no new risk anywhere
    ///         on this controller (switch, allocate, borrow, fund, swap) — only exits.
    ///         Set approaching expiry/settlement and never unset; pause stays the reversible
    ///         incident halt.
    bool public switchFrozen;
    uint256 public lastSwitchAt;

    Targets public targets;

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
    event RebalanceVenueUpdated(address indexed router, bytes32 indexed poolId);
    event RebalancedSwap(bool equityOut, uint256 amountIn, uint256 amountOut);
    event StrategyModuleUpdated(address indexed module);
    event BooksUpdated(address indexed bookA, address indexed bookB);
    event HubUpdated(address indexed hub);
    event SwitchDwellUpdated(uint32 dwell);
    event SwitchFrozenSet(bool frozen);
    event SwitchStaged(address indexed agent, uint8 indexed fromBook, uint8 indexed toBook);
    event TargetsUpdated(uint16 hookBps, uint16 morphoQuoteBps, uint16 morphoEquityBps, uint16 idleBps);
    event AllocateSubmitted(address indexed agent, address indexed adapter, uint256 amount);
    event DeallocateSubmitted(address indexed agent, address indexed adapter, uint256 withdrawn);
    event RepaySubmitted(address indexed agent, address indexed adapter, uint256 repaid);
    event DeleverageSubmitted(address indexed agent, address indexed adapter, uint256 repaid, uint256 withdrawn);
    event AdapterDisabledSubmitted(address indexed agent, address indexed adapter);
    event CapsLoweredSubmitted(
        address indexed agent, address indexed adapter, uint256 absoluteCap, uint16 relativeCapBps
    );
    event PendingCancelledSubmitted(address indexed agent, address indexed adapter);
    event CollateralAllocatedSubmitted(address indexed agent, address indexed adapter, uint256 amount);
    event BorrowSubmitted(address indexed agent, address indexed adapter, uint256 amount);
    event AllocateCapsUpdated(uint256 maxAllocatePerCall, uint256 maxCollateralPerCall, uint256 maxBorrowPerCall);

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
    error RebalanceTooLarge(uint256 quoteValue, uint256 maxAmountIn);
    error RecenterCooldownActive(uint256 readyAt);
    error RebalanceCooldownActive(uint256 readyAt);
    error DeadlineExpired(uint256 deadline);
    error ConversionFeeTooHigh(uint16 feeBps);
    error TradingClosed();
    error OracleInvalid();
    error RebalanceVenueUnset();
    error SlippageBoundUnmet(uint256 minOut, uint256 oracleFloor);
    error RebalanceNotFunded();
    error ModuleUnset();
    error AllocateTooLarge(uint256 amount, uint256 bound);
    error CollateralTooLarge(uint256 amount, uint256 bound);
    error BorrowTooLarge(uint256 amount, uint256 bound);
    error InvalidBooks();
    error UnknownBook(uint8 book);
    error SameBook(uint8 book);
    error SwitchFrozen();
    error SwitchDwellActive(uint256 readyAt);
    error InvalidTargets();
    error NotSelf(address caller);
    error NothingPending(bytes32 key);
    error TimelockActive(uint64 executableAt);
    error KnobExecutionFailed();

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

    /// @notice Risk-knob setters below run only through the 24h timelock queue
    ///         (propose → execute). No instant tuning path exists by design.
    modifier onlySelf() {
        if (msg.sender != address(this)) revert NotSelf(msg.sender);
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
            maxRebalanceSwapQuote: 10_000e6,
            maxAllocatePerCall: 100e18,
            maxCollateralPerCall: 1_000e18,
            maxBorrowPerCall: 10_000e6,
            recenterCooldown: 60,
            rebalanceCooldown: 0
        });
        _validateBounds(bounds);
        targets = Targets({ hookBps: 7_000, morphoQuoteBps: 2_000, morphoEquityBps: 0, idleBps: 1_000 });
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

    /// @notice Risk-knob timelock queue: tuning below runs ONLY here. Owner proposes an
    ///         allowlisted setter call; anyone executes it after 24h; owner/guardian cancels.
    ///         No instant tuning path exists — emergencies use the instant tools instead
    ///         (module disable/lowerCaps, pause, freeze, recall, deallocate...).
    uint256 public constant KNOB_TIMELOCK = 24 hours;

    struct PendingKnob {
        bytes data;
        uint64 executableAt;
    }

    mapping(bytes32 => PendingKnob) public pendingKnobs;

    event KnobProposed(bytes32 indexed key, uint64 executableAt);
    event KnobExecuted(bytes32 indexed key);
    event KnobCancelled(bytes32 indexed key);

    /// @notice Typed proposers (one per tunable knob): each stages an exact setter call.
    ///         No raw-calldata path exists, so no allowlist is needed — unlisted setters
    ///         simply have no proposer and can never enter the queue.
    function proposeBounds(Bounds calldata b) external onlyOwner returns (bytes32 key) {
        key = _queueKnob(abi.encodeCall(this.setBounds, (b)));
    }

    function proposeTargets(uint16 hookBps, uint16 morphoQuoteBps, uint16 morphoEquityBps, uint16 idleBps)
        external
        onlyOwner
        returns (bytes32 key)
    {
        key = _queueKnob(abi.encodeCall(this.setTargets, (hookBps, morphoQuoteBps, morphoEquityBps, idleBps)));
    }

    function proposeAllocateCaps(uint256 maxAllocate, uint256 maxCollateral, uint256 maxBorrow)
        external
        onlyOwner
        returns (bytes32 key)
    {
        key = _queueKnob(abi.encodeCall(this.setAllocateCaps, (maxAllocate, maxCollateral, maxBorrow)));
    }

    function proposeSwitchDwell(uint32 dwell) external onlyOwner returns (bytes32 key) {
        key = _queueKnob(abi.encodeCall(this.setSwitchDwell, (dwell)));
    }

    function proposeRebalanceVenue(PoolKey calldata key_, address router) external onlyOwner returns (bytes32 key) {
        key = _queueKnob(abi.encodeCall(this.setRebalanceVenue, (key_, router)));
    }

    function proposeSlippageBps(uint16 bps) external onlyOwner returns (bytes32 key) {
        key = _queueKnob(abi.encodeCall(this.setMaxRebalanceSlippageBps, (bps)));
    }

    function _queueKnob(bytes memory data) internal returns (bytes32 key) {
        key = keccak256(data);
        pendingKnobs[key] = PendingKnob({ data: data, executableAt: uint64(block.timestamp + KNOB_TIMELOCK) });
        emit KnobProposed(key, uint64(block.timestamp + KNOB_TIMELOCK));
    }

    function executeKnob(bytes32 key) external {
        uint64 at = pendingKnobs[key].executableAt;
        if (at == 0) revert NothingPending(key);
        if (block.timestamp < at) revert TimelockActive(at);
        bytes memory data = pendingKnobs[key].data;
        delete pendingKnobs[key];
        (bool ok,) = address(this).call(data);
        if (!ok) revert KnobExecutionFailed();
        emit KnobExecuted(key);
    }

    function cancelKnob(bytes32 key) external {
        if (msg.sender != owner && msg.sender != guardian) revert NotGuardianOrOwner(msg.sender);
        if (pendingKnobs[key].executableAt == 0) revert NothingPending(key);
        delete pendingKnobs[key];
        emit KnobCancelled(key);
    }

    function setBounds(Bounds calldata newBounds) external onlySelf {
        _validateBounds(newBounds);
        bounds = newBounds;
        emit BoundsUpdated(newBounds);
    }

    /// @notice Bottom-layer swap venue: which pool + router the rebalance swap runs through.
    function setRebalanceVenue(PoolKey calldata key, address router) external onlySelf {
        if (router == address(0)) revert ZeroAddress();
        _rebalanceKey = key;
        rebalanceRouter = router;
        emit RebalanceVenueUpdated(router, PoolId.unwrap(key.toId()));
    }

    function setMaxRebalanceSlippageBps(uint16 bps) external onlySelf {
        if (bps > 1_000) revert ConversionFeeTooHigh(bps);
        maxRebalanceSlippageBps = bps;
    }

    /// @notice Wires the quote-asset Morpho module this controller allocates through.
    ///         The module owner must separately set this controller as allocator/sentinel.
    function setStrategyModule(address module_) external onlyOwner {
        if (module_ == address(0)) revert ZeroAddress();
        strategyModule = module_;
        emit StrategyModuleUpdated(module_);
    }

    /// @notice Registers the two book hooks (A = low fee, B = high fee). Must differ.
    function setBooks(address bookA_, address bookB_) external onlyOwner {
        if (bookA_ == address(0) || bookB_ == address(0) || bookA_ == bookB_) revert InvalidBooks();
        bookA = bookA_;
        bookB = bookB_;
        emit BooksUpdated(bookA_, bookB_);
    }

    function setSwitchDwell(uint32 dwell_) external onlySelf {
        switchDwell = dwell_;
        emit SwitchDwellUpdated(dwell_);
    }

    function setSwitchFrozen(bool frozen_) external {
        if (msg.sender != owner && msg.sender != guardian) revert NotGuardianOrOwner(msg.sender);
        switchFrozen = frozen_;
        emit SwitchFrozenSet(frozen_);
    }

    /// @notice Tightens/loosens the per-call strategy caps without rewriting the whole
    ///         Bounds struct. Zero disables that path (deallocate/repay stay open).
    function setAllocateCaps(uint256 maxAllocate_, uint256 maxCollateral_, uint256 maxBorrow_) external onlySelf {
        bounds.maxAllocatePerCall = maxAllocate_;
        bounds.maxCollateralPerCall = maxCollateral_;
        bounds.maxBorrowPerCall = maxBorrow_;
        emit AllocateCapsUpdated(maxAllocate_, maxCollateral_, maxBorrow_);
    }

    /// @notice Target mix across venues in bps; must sum to exactly 10_000.
    function setTargets(uint16 hookBps_, uint16 morphoQuoteBps_, uint16 morphoEquityBps_, uint16 idleBps_)
        external
        onlySelf
    {
        if (uint256(hookBps_) + morphoQuoteBps_ + morphoEquityBps_ + idleBps_ != MAX_BPS) {
            revert InvalidTargets();
        }
        targets = Targets(hookBps_, morphoQuoteBps_, morphoEquityBps_, idleBps_);
        emit TargetsUpdated(hookBps_, morphoQuoteBps_, morphoEquityBps_, idleBps_);
    }

    // ---------------------------------------------------------------------
    // Agent surface (bounded)
    // ---------------------------------------------------------------------

    function submitGuardParams(GuardParams.Params calldata params) external onlyAgent whenNotPaused {
        if (switchFrozen) revert SwitchFrozen();
        _checkBounds(params);
        _vault().setGuardParams(params);
        emit GuardParamsSubmitted(msg.sender, params);
    }

    function submitRecenter() external onlyAgent whenNotPaused {
        if (switchFrozen) revert SwitchFrozen();
        Bounds memory b = bounds;
        if (lastRecenterAt != 0 && block.timestamp < lastRecenterAt + b.recenterCooldown) {
            revert RecenterCooldownActive(lastRecenterAt + b.recenterCooldown);
        }
        lastRecenterAt = block.timestamp;
        _vault().recenterGuard();
        emit RecenterSubmitted(msg.sender);
    }

    /// @dev The agent may always stand the book down; re-enabling deployments needs an unpaused,
    ///      unfrozen controller.
    function submitDeployEnabled(bool enabled) external onlyAgent {
        if (enabled && paused) revert IsPaused();
        if (enabled && switchFrozen) revert SwitchFrozen();
        _vault().setHookDeployEnabled(enabled);
        emit DeployEnabledSubmitted(msg.sender, enabled);
    }

    /// @dev De-risking call: allowed while paused.
    function submitRecall() external onlyAgent {
        _vault().recallFromHook();
        emit RecallSubmitted(msg.sender);
    }

    function submitFund(uint256 quoteAmount, uint256 equityAmount) external onlyAgent whenNotPaused {
        if (switchFrozen) revert SwitchFrozen();
        Bounds memory b = bounds;
        if (quoteAmount == 0 && equityAmount == 0) revert NothingToFund();
        if (quoteAmount > b.maxFundQuotePerCall) revert FundTooLarge(quoteAmount, b.maxFundQuotePerCall);
        if (equityAmount > b.maxFundEquityPerCall) revert FundTooLarge(equityAmount, b.maxFundEquityPerCall);
        _vault().fundHook(quoteAmount, equityAmount);
        emit FundSubmitted(msg.sender, quoteAmount, equityAmount);
    }

    /// @notice Moves vault capital into a Morpho adapter (WETH lend sleeve). Bounded per
    ///         call here; the module enforces absolute + relative caps and expiry gating.
    function submitAllocate(address adapter, uint256 amount) external onlyAgent whenNotPaused nonReentrant {
        if (switchFrozen) revert SwitchFrozen();
        address module_ = _module();
        if (amount == 0) revert ZeroAmount();
        if (amount > bounds.maxAllocatePerCall) revert AllocateTooLarge(amount, bounds.maxAllocatePerCall);
        IStrategyModule(module_).allocate(adapter, amount);
        emit AllocateSubmitted(msg.sender, adapter, amount);
    }

    /// @notice Pulls capital back from a Morpho adapter to the vault. De-risking call:
    ///         allowed while paused.
    function submitDeallocate(address adapter, uint256 amount)
        external
        onlyAgent
        nonReentrant
        returns (uint256 withdrawn)
    {
        address module_ = _module();
        if (amount == 0) revert ZeroAmount();
        withdrawn = IStrategyModule(module_).deallocate(adapter, amount);
        emit DeallocateSubmitted(msg.sender, adapter, withdrawn);
    }

    /// @notice Repays loop-sleeve debt from vault capital. De-risking call: allowed while paused.
    function submitRepay(address adapter, uint256 amount) external onlyAgent nonReentrant {
        address module_ = _module();
        if (amount == 0) revert ZeroAmount();
        IStrategyModule(module_).repay(adapter, amount);
        emit RepaySubmitted(msg.sender, adapter, amount);
    }

    /// @notice Repays debt and/or pulls NVDA collateral back to the vault. De-risking call:
    ///         allowed while paused.
    function submitDeleverage(address adapter, uint256 repayAmount, uint256 collateralWithdrawn)
        external
        onlyAgent
        nonReentrant
    {
        address module_ = _module();
        IStrategyModule(module_).deleverage(adapter, repayAmount, collateralWithdrawn);
        emit DeleverageSubmitted(msg.sender, adapter, repayAmount, collateralWithdrawn);
    }

    /// @notice Sentinel de-risk: instantly blocks new allocations to an adapter.
    ///         De-risking call: allowed while paused. Requires this controller to be the
    ///         module's sentinel (wired at deploy).
    function submitDisableAdapter(address adapter) external onlyAgent nonReentrant {
        address module_ = _module();
        IStrategyModule(module_).disableAdapter(adapter);
        emit AdapterDisabledSubmitted(msg.sender, adapter);
    }

    /// @notice Sentinel de-risk: instantly lowers an adapter's caps (never raises).
    ///         De-risking call: allowed while paused.
    function submitLowerCaps(address adapter, uint256 absoluteCap, uint16 relativeCapBps)
        external
        onlyAgent
        nonReentrant
    {
        address module_ = _module();
        IStrategyModule(module_).lowerCaps(adapter, absoluteCap, relativeCapBps);
        emit CapsLoweredSubmitted(msg.sender, adapter, absoluteCap, relativeCapBps);
    }

    /// @notice Sentinel de-risk: cancels a pending timelocked adapter. De-risking call:
    ///         allowed while paused.
    function submitCancelPending(address adapter) external onlyAgent nonReentrant {
        address module_ = _module();
        IStrategyModule(module_).cancelPending(adapter);
        emit PendingCancelledSubmitted(msg.sender, adapter);
    }

    /// @notice Opens/grows the NVDA-collateral loop sleeve. Risk-increasing: blocked while
    ///         paused or frozen; bounded per call here plus exposure caps inside the module.
    function submitAllocateCollateral(address adapter, uint256 amount) external onlyAgent whenNotPaused nonReentrant {
        if (switchFrozen) revert SwitchFrozen();
        address module_ = _module();
        if (amount == 0) revert ZeroAmount();
        if (amount > bounds.maxCollateralPerCall) revert CollateralTooLarge(amount, bounds.maxCollateralPerCall);
        IStrategyModule(module_).allocateCollateral(adapter, amount);
        emit CollateralAllocatedSubmitted(msg.sender, adapter, amount);
    }

    /// @notice Borrows quote against loop collateral to the vault. Risk-increasing: blocked
    ///         while paused or frozen. The module checks no borrow cap itself, so this
    ///         per-call cap is the brake — size it tight.
    function submitBorrow(address adapter, uint256 amount) external onlyAgent whenNotPaused nonReentrant {
        if (switchFrozen) revert SwitchFrozen();
        address module_ = _module();
        if (amount == 0) revert ZeroAmount();
        if (amount > bounds.maxBorrowPerCall) revert BorrowTooLarge(amount, bounds.maxBorrowPerCall);
        IStrategyModule(module_).borrow(adapter, amount);
        emit BorrowSubmitted(msg.sender, adapter, amount);
    }

    /// @notice Owner sets the dual-book hub that owns both hooks (zero = single-book mode).
    function setHub(address hub_) external onlyOwner {
        hub = hub_;
        emit HubUpdated(hub_);
    }

    /// @notice Regime flip between the two books. Policy-gated; stands the old book down
    ///         and stages the new one. With the hub set the migration is atomic — pull the
    ///         old book, fund the new book, arm it in this call — and reverts as a no-op if
    ///         the new book has no guard params staged (fail-closed, funds stay deployed in
    ///         the old book; stage params on each book before handing ownership to the hub).
    ///         Round-trips re-arm the previously pulled book. Without the hub, capital waits
    ///         in the vault, counted, until funded.
    function submitSwitchBook(uint8 to) external onlyAgent whenNotPaused nonReentrant {
        if (to > 1) revert UnknownBook(to);
        address target = to == 0 ? bookA : bookB;
        if (target == address(0)) revert UnknownBook(to);
        if (to == activeBook) revert SameBook(to);
        if (switchFrozen) revert SwitchFrozen();
        IVaultStrategy vault_ = _vault();
        if (vault_.expired()) revert TradingClosed();
        if (!vault_.oracleValid()) revert OracleInvalid();
        if (lastSwitchAt != 0 && block.timestamp < lastSwitchAt + switchDwell) {
            revert SwitchDwellActive(lastSwitchAt + switchDwell);
        }

        vault_.recallFromHook();

        if (hub != address(0)) {
            IDualBookHub(hub).pullInactiveAndActivate(to);
            address vaultAddr = address(vault_);
            uint256 quoteBal = vault_.quote().balanceOf(vaultAddr);
            uint256 equityBal = vault_.equity().balanceOf(vaultAddr);
            vault_.fundHook(quoteBal, equityBal);
            IDualBookHub(hub).pushToActive();
            IDualBookHub(hub).activateAndDeploy();
        }

        uint8 from = activeBook;
        activeBook = to;
        lastSwitchAt = block.timestamp;
        emit SwitchStaged(msg.sender, from, to);
    }

    /// @notice Bottom-layer rebalance swap, executed here so the vault stays a pure
    ///         counting box. Pulls input tokens from the vault through its keeper-only
    ///         pull door, swaps via the configured venue, proceeds land back in the vault.
    function submitRebalance(bool equityOut, uint256 amountIn, uint256 minOut, uint256 deadline)
        external
        onlyAgent
        whenNotPaused
        nonReentrant
    {
        if (switchFrozen) revert SwitchFrozen();
        if (amountIn == 0) revert ZeroAmount();
        if (block.timestamp > deadline) revert DeadlineExpired(deadline);
        IVaultStrategy vault_ = _vault();
        if (vault_.expired()) revert TradingClosed();
        Bounds memory b = bounds;
        uint256 quoteValue = equityOut ? vault_.equityToQuote(amountIn) : amountIn;
        if (quoteValue == 0 && equityOut) revert OracleInvalid();
        if (quoteValue > b.maxRebalanceSwapQuote) revert RebalanceTooLarge(quoteValue, b.maxRebalanceSwapQuote);
        if (lastRebalanceAt != 0 && block.timestamp < lastRebalanceAt + b.rebalanceCooldown) {
            revert RebalanceCooldownActive(lastRebalanceAt + b.rebalanceCooldown);
        }
        if (rebalanceRouter == address(0)) revert RebalanceVenueUnset();
        if (!equityOut) {
            address acct = vault_.accountant();
            if (acct != address(0) && !ITrancheAccountant(acct).escrowFunded()) revert RebalanceNotFunded();
        }

        uint256 oracleOut = equityOut ? quoteValue : vault_.quoteToEquity(amountIn);
        if (oracleOut == 0) revert OracleInvalid();
        uint256 floor = Math.mulDiv(oracleOut, MAX_BPS - maxRebalanceSlippageBps, MAX_BPS);
        if (minOut < floor) revert SlippageBoundUnmet(minOut, floor);
        lastRebalanceAt = block.timestamp;

        IERC20 tokenIn = equityOut ? vault_.equity() : vault_.quote();
        IERC20 tokenOut = equityOut ? vault_.quote() : vault_.equity();
        address vaultAddr = address(vault_);

        vault_.pullForRebalance(address(tokenIn), amountIn);

        PoolKey memory rkey = _rebalanceKey;
        uint256 before = tokenOut.balanceOf(vaultAddr);
        tokenIn.forceApprove(rebalanceRouter, amountIn);
        ISwapRouter(rebalanceRouter)
            .swapExactIn(
                rkey, Currency.unwrap(rkey.currency0) == address(tokenIn), amountIn, minOut, vaultAddr, deadline
            );
        tokenIn.forceApprove(rebalanceRouter, 0);
        uint256 amountOut = tokenOut.balanceOf(vaultAddr) - before;

        emit RebalanceSubmitted(msg.sender, equityOut, amountIn, minOut, deadline);
        emit RebalancedSwap(equityOut, amountIn, amountOut);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _vault() internal view returns (IVaultStrategy) {
        address vault_ = vault;
        if (vault_ == address(0)) revert VaultNotSet();
        return IVaultStrategy(vault_);
    }

    function _module() internal view returns (address module_) {
        module_ = strategyModule;
        if (module_ == address(0)) revert ModuleUnset();
    }

    function _validateBounds(Bounds memory b) internal pure {
        if (
            b.maxGuardTickWidth <= 0 || b.maxGuardTickWidth > MAX_TICK_WIDTH || b.maxBaseTickWidth <= 0
                || b.maxBaseTickWidth > MAX_TICK_WIDTH || b.maxGuardLiquidity == 0 || b.maxBaseLiquidity == 0
                || b.maxMinEvBps > MAX_BPS || b.minRecheckInterval == 0 || b.maxRecheckInterval < b.minRecheckInterval
                || b.maxRecheckInterval > MAX_RECHECK_INTERVAL || b.maxRecheckMaxDeviationBps > MAX_BPS
                || b.maxMaxPriceAge == 0 || b.maxMaxPriceAge > MAX_PRICE_AGE || b.maxFundQuotePerCall == 0
                || b.maxRebalanceSwapQuote == 0 || b.maxAllocatePerCall == 0 || b.maxCollateralPerCall == 0
                || b.maxBorrowPerCall == 0
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
