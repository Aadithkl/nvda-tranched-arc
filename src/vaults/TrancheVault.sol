// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { ERC7540 } from "openzeppelin-community-contracts/token/ERC20/extensions/ERC7540.sol";
import { ERC7540SyncDeposit } from "openzeppelin-community-contracts/token/ERC20/extensions/ERC7540SyncDeposit.sol";
import { ERC7540AdminRedeem } from "openzeppelin-community-contracts/token/ERC20/extensions/ERC7540AdminRedeem.sol";
import { IHookShareToken } from "../interfaces/IHookShareToken.sol";
import { IHookSharePipe } from "../interfaces/IHookSharePipe.sol";
import { ITrancheAccountant } from "../interfaces/ITrancheAccountant.sol";

abstract contract TrancheVault is ERC7540SyncDeposit, ERC7540AdminRedeem, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Math for uint256;

    IERC20 public immutable quote;
    IERC20 public immutable equity;
    IHookShareToken public immutable hookShare;
    IHookSharePipe public immutable pipe;
    bool public immutable isSenior;
    uint64 public immutable expiry;

    address public owner;
    address public pendingOwner;
    address public guardian;
    address public accountant;
    bool public depositsPaused;
    uint256 public maxTotalAssets;
    /// @notice Timelocked accountant rotation (C2): instant swaps let a malicious
    ///         accountant drain both tranches via `moveShares`. Non-zero -> non-zero
    ///         rotations must wait ACCOUNTANT_TIMELOCK.
    address public pendingAccountant;
    uint64 public accountantExecutableAt;
    uint64 public constant ACCOUNTANT_TIMELOCK = 24 hours;

    bool public matured;
    uint256 public settledAt;
    uint256 public quotePerShare1e18;
    uint256 public equityPerShare1e18;
    uint256 private _pendingMaturedShares;

    event OwnerUpdated(address indexed owner);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event GuardianUpdated(address indexed guardian);
    event AccountantUpdated(address indexed accountant);
    event AccountantSubmitted(address indexed pendingAccountant, uint64 executableAt);
    event DepositsPausedSet(bool paused);
    event MaxTotalAssetsUpdated(uint256 maxTotalAssets);
    event SharesMoved(address indexed to, uint256 amount);
    event QuoteDeposited(address indexed caller, address indexed receiver, uint256 quoteAmount, uint256 shares);
    event QuoteUnwrapped(address indexed caller, address indexed receiver, uint256 shares, uint256 quoteAmount);
    event EquityUnwrapped(address indexed caller, address indexed receiver, uint256 shares, uint256 equityAmount);
    event ProportionalUnwrapped(
        address indexed caller, address indexed receiver, uint256 shares, uint256 quoteAmount, uint256 equityAmount
    );
    event ExpirySet(uint64 expiry);
    event SettlementCredited(
        uint256 quoteAmount, uint256 equityAmount, uint256 quotePerShare1e18, uint256 equityPerShare1e18
    );
    event MaturedRedeem(
        address indexed caller, address indexed receiver, uint256 shares, uint256 quoteAmount, uint256 equityAmount
    );
    event MaturedRedeemFulfilled(address indexed user, uint256 shares);

    error NotOwner(address caller);
    error NotPendingOwner(address caller);
    error NotOwnerOrGuardian(address caller);
    error NotAccountant(address caller);
    error NotPipe(address caller);
    error ZeroAddress();
    error ZeroAmount();
    error DepositCapExceeded(uint256 assets, uint256 maxAssets);
    error DepositsPaused();
    error FloorBreach(uint256 juniorBal, uint256 seniorBal);
    error SeniorQuoteOnly();
    error Expired();
    error Matured();
    error NotMatured();
    error SettlementAlreadyCredited();
    error SlippageExceeded(uint256 quoteAmount, uint256 equityAmount, uint256 minQuoteOut, uint256 minEquityOut);
    error NothingPendingRedeem();
    error NothingToClaim();
    error InvalidSibling(address to);
    error NothingPending();
    error TimelockActive(uint64 executableAt);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    modifier onlyAccountant() {
        if (msg.sender != accountant) revert NotAccountant(msg.sender);
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        IERC20 asset_,
        IERC20 quote_,
        IERC20 equity_,
        IHookSharePipe pipe_,
        bool isSenior_,
        address owner_,
        address accountant_,
        uint64 expiry_
    ) ERC20(name_, symbol_) ERC7540(asset_) {
        if (address(quote_) == address(0) || address(equity_) == address(0) || address(pipe_) == address(0)) {
            revert ZeroAddress();
        }
        quote = quote_;
        equity = equity_;
        hookShare = IHookShareToken(address(asset_));
        pipe = pipe_;
        isSenior = isSenior_;
        expiry = expiry_;
        owner = owner_ == address(0) ? msg.sender : owner_;
        guardian = owner;
        accountant = accountant_;
        emit OwnerUpdated(owner);
        emit GuardianUpdated(guardian);
        emit AccountantUpdated(accountant_);
        emit ExpirySet(expiry_);
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

    function setAccountant(address newAccountant) external onlyOwner {
        if (newAccountant == address(0)) revert ZeroAddress();
        // Initial wiring (zero -> non-zero) is immediate so deploys don't brick.
        // Every live rotation goes through the timelock queue below.
        if (accountant != address(0)) revert TimelockActive(accountantExecutableAt);
        accountant = newAccountant;
        emit AccountantUpdated(newAccountant);
    }

    /// @notice Schedules an accountant rotation (C2). Executable after 24h.
    function submitAccountant(address newAccountant) external onlyOwner {
        if (newAccountant == address(0)) revert ZeroAddress();
        if (accountant == address(0)) revert NothingPending();
        pendingAccountant = newAccountant;
        accountantExecutableAt = uint64(block.timestamp) + ACCOUNTANT_TIMELOCK;
        emit AccountantSubmitted(newAccountant, accountantExecutableAt);
    }

    /// @notice Executes a scheduled accountant rotation (permissionless post-timelock).
    function executeAccountant() external {
        address pending = pendingAccountant;
        if (pending == address(0)) revert NothingPending();
        if (block.timestamp < accountantExecutableAt) revert TimelockActive(accountantExecutableAt);
        delete pendingAccountant;
        accountantExecutableAt = 0;
        accountant = pending;
        emit AccountantUpdated(pending);
    }

    function cancelAccountant() external onlyOwner {
        if (pendingAccountant == address(0)) revert NothingPending();
        delete pendingAccountant;
        accountantExecutableAt = 0;
        emit AccountantSubmitted(address(0), 0);
    }

    function setDepositsPaused(bool paused_) external {
        if (msg.sender != owner && msg.sender != guardian) revert NotOwnerOrGuardian(msg.sender);
        depositsPaused = paused_;
        emit DepositsPausedSet(paused_);
    }

    function setMaxTotalAssets(uint256 cap) external onlyOwner {
        maxTotalAssets = cap;
        emit MaxTotalAssetsUpdated(cap);
    }

    function fulfillRedeem(uint256 shares, uint256 assets, address controller) external onlyAccountant {
        _fulfillRedeem(shares, assets, controller);
        _notifyRedeem(assets);
    }

    function moveShares(address to, uint256 amount) external onlyAccountant {
        if (matured) revert Matured();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        // C2: sibling-only — an evil accountant must not send shares to anyone.
        // The sibling is the other tranche vault registered in the accountant.
        address sibling =
            isSenior ? ITrancheAccountant(accountant).juniorVault() : ITrancheAccountant(accountant).seniorVault();
        if (to != sibling) revert InvalidSibling(to);
        IERC20(address(hookShare)).safeTransfer(to, amount);
        emit SharesMoved(to, amount);
    }

    function depositQuote(uint256 quoteAmount, address receiver) external nonReentrant returns (uint256 shares) {
        if (quoteAmount == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        if (expired()) revert Expired();
        if (matured) revert Matured();
        if (depositsPaused) revert DepositsPaused();

        uint256 cap = maxTotalAssets;
        quote.safeTransferFrom(msg.sender, address(this), quoteAmount);
        quote.forceApprove(address(pipe), quoteAmount);
        uint256 assets = pipe.wrapQuote(quoteAmount, address(this));

        // Re-check the cap against post-wrap state so a reentrant or upgraded pipe cannot bypass it
        // with the pre-call snapshot (Slither reentrancy-balance).
        if (cap != 0 && totalAssets() > cap) revert DepositCapExceeded(totalAssets(), cap);

        // Senior deposits must preserve the junior buffer floor (Centrifuge-style min
        // subordination, hook-share integer math, no oracle). Junior deposits only raise
        // the fraction, so they skip the check. Reverts roll everything back atomically.
        if (isSenior) _checkDepositFloor();

        uint256 assetsBefore = totalAssets() - assets;
        shares = assets.mulDiv(totalSupply() + 10 ** _decimalsOffset(), assetsBefore + 1, Math.Rounding.Floor);
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
        emit QuoteDeposited(msg.sender, receiver, quoteAmount, shares);
        _notifyDeposit(assets);
    }

    function deposit(uint256 assets, address receiver) public virtual override nonReentrant returns (uint256 shares) {
        if (expired()) revert Expired();
        if (matured) revert Matured();
        shares = super.deposit(assets, receiver);
        if (isSenior) _checkDepositFloor();
        _notifyDeposit(assets);
    }

    /// @notice Post-deposit junior-buffer check for senior money: junior hook backing must be
    ///         at least the floor fraction of combined backing. Genesis must therefore be
    ///         junior-led — the first deposit ever can only succeed on the junior side.
    function _checkDepositFloor() internal view {
        address acct = accountant;
        if (acct == address(0)) return;
        ITrancheAccountant accountant_ = ITrancheAccountant(acct);
        uint256 floor = accountant_.minJuniorFloorBps();
        if (floor == 0) return;
        address seniorVault = accountant_.seniorVault();
        address juniorVault = accountant_.juniorVault();
        if (seniorVault == address(0) || juniorVault == address(0)) return;
        uint256 juniorBal = IERC20(address(hookShare)).balanceOf(juniorVault);
        uint256 seniorBal = IERC20(address(hookShare)).balanceOf(seniorVault);
        if (juniorBal * 10_000 < floor * (juniorBal + seniorBal)) revert FloorBreach(juniorBal, seniorBal);
    }

    function _notifyDeposit(uint256 hookShares) internal {
        address acct = accountant;
        if (acct != address(0)) ITrancheAccountant(acct).onTrancheDeposit(isSenior, hookShares);
    }

    function _notifyRedeem(uint256 hookShares) internal {
        address acct = accountant;
        if (acct != address(0)) ITrancheAccountant(acct).onTrancheRedeem(isSenior, hookShares);
    }

    function _notifyClaim(uint256 hookShares) internal {
        address acct = accountant;
        if (acct != address(0)) ITrancheAccountant(acct).onTrancheClaim(isSenior, hookShares);
    }

    /// @dev Fulfilled redemption assets leave the vault only when the user claims. Report the
    ///      claim so the accountant releases the locked-claim liability tracked at fulfillment.
    ///      After settlement the vault holds QUOTE (and equity for junior) instead of hook shares,
    ///      so the payout is the frozen per-share rate (`_transferOut` intercepts the transfer).
    function _withdraw(address caller, address receiver, address sharesOwner, uint256 assets, uint256 shares)
        internal
        virtual
        override
    {
        if (matured) _pendingMaturedShares = shares;
        super._withdraw(caller, receiver, sharesOwner, assets, shares);
        if (matured) _pendingMaturedShares = 0;
        // Medium: matured payouts are the FROZEN quote value (the `assets` arg comes
        // from hook-share accounting, which is ~0 after settlement). Notify with the
        // frozen quote so the accountant's principal/claimable counters keep tracking
        // what actually left the vault.
        if (matured) {
            _notifyClaim(shares.mulDiv(quotePerShare1e18, 1e18, Math.Rounding.Floor));
        } else {
            _notifyClaim(assets);
        }
    }

    function _transferOut(address to, uint256 assets) internal virtual override {
        uint256 shares = _pendingMaturedShares;
        if (matured && shares != 0) {
            uint256 quoteAmount = shares.mulDiv(quotePerShare1e18, 1e18, Math.Rounding.Floor);
            uint256 equityAmount = shares.mulDiv(equityPerShare1e18, 1e18, Math.Rounding.Floor);
            if (quoteAmount != 0) quote.safeTransfer(to, quoteAmount);
            if (equityAmount != 0) equity.safeTransfer(to, equityAmount);
            emit MaturedRedeem(to, to, shares, quoteAmount, equityAmount);
            return;
        }
        super._transferOut(to, assets);
    }

    /// @notice True once the tranche expiry timestamp is reached. Deposits close and only
    ///         redemption/settlement paths remain.
    function expired() public view returns (bool) {
        return expiry != 0 && block.timestamp >= expiry;
    }

    /// @notice Credits the vault with its settlement payout and freezes the redemption rates at
    ///         the terminal NAV. Called by the pipe after it burns this vault's hook shares and
    ///         pushes QUOTE (and equity for junior) into the vault.
    function creditSettlement(uint256 quoteAmount, uint256 equityAmount) external {
        if (msg.sender != address(pipe)) revert NotPipe(msg.sender);
        if (matured) revert SettlementAlreadyCredited();
        if (isSenior && equityAmount != 0) revert SeniorQuoteOnly();
        matured = true;
        settledAt = block.timestamp;
        // `totalSupply()` already includes pending redeem shares (ERC7540:
        // totalSupply = superSupply + pending). Do NOT add pending again —
        // that would halve every payout (C1).
        uint256 supply = totalSupply();
        if (supply != 0) {
            quotePerShare1e18 = quoteAmount.mulDiv(1e18, supply);
            equityPerShare1e18 = equityAmount.mulDiv(1e18, supply);
        }
        emit SettlementCredited(quoteAmount, equityAmount, quotePerShare1e18, equityPerShare1e18);
    }

    function redeemAtExpiry(uint256 shares, address receiver)
        external
        returns (uint256 quoteAmount, uint256 equityAmount)
    {
        return redeemAtExpiry(shares, receiver, 0, 0);
    }

    /// @notice Burns the caller's vault shares and pays the frozen terminal payout directly:
    ///         QUOTE only for senior, QUOTE + equity pro-rata for junior. Available only after
    ///         settlement (see `matured`).
    function redeemAtExpiry(uint256 shares, address receiver, uint256 minQuoteOut, uint256 minEquityOut)
        public
        nonReentrant
        returns (uint256 quoteAmount, uint256 equityAmount)
    {
        if (!matured) revert NotMatured();
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        _burn(msg.sender, shares);
        quoteAmount = shares.mulDiv(quotePerShare1e18, 1e18, Math.Rounding.Floor);
        equityAmount = shares.mulDiv(equityPerShare1e18, 1e18, Math.Rounding.Floor);
        if (quoteAmount < minQuoteOut || equityAmount < minEquityOut) {
            revert SlippageExceeded(quoteAmount, equityAmount, minQuoteOut, minEquityOut);
        }
        if (quoteAmount != 0) quote.safeTransfer(receiver, quoteAmount);
        if (equityAmount != 0) equity.safeTransfer(receiver, equityAmount);
        emit MaturedRedeem(msg.sender, receiver, shares, quoteAmount, equityAmount);
    }

    function claimAndUnwrapQuote(uint256 shares, address receiver, address ownerOrController)
        external
        returns (uint256 quoteAmount)
    {
        return claimAndUnwrapQuote(shares, receiver, ownerOrController, 0);
    }

    function claimAndUnwrapQuote(uint256 shares, address receiver, address ownerOrController, uint256 minQuoteOut)
        public
        nonReentrant
        returns (uint256 quoteAmount)
    {
        if (matured) revert Matured();
        if (receiver == address(0)) revert ZeroAddress();
        uint256 assets = redeem(shares, address(this), ownerOrController);
        quoteAmount = pipe.unwrapQuote(assets, receiver, minQuoteOut);
        emit QuoteUnwrapped(msg.sender, receiver, assets, quoteAmount);
    }

    function claimAndUnwrapEquity(uint256 shares, address receiver, address ownerOrController)
        external
        returns (uint256 equityAmount)
    {
        return claimAndUnwrapEquity(shares, receiver, ownerOrController, 0);
    }

    function claimAndUnwrapEquity(uint256 shares, address receiver, address ownerOrController, uint256 minEquityOut)
        public
        nonReentrant
        returns (uint256 equityAmount)
    {
        if (matured) revert Matured();
        if (isSenior) revert SeniorQuoteOnly();
        if (receiver == address(0)) revert ZeroAddress();
        uint256 assets = redeem(shares, address(this), ownerOrController);
        equityAmount = pipe.unwrapEquity(assets, receiver, minEquityOut);
        emit EquityUnwrapped(msg.sender, receiver, assets, equityAmount);
    }

    function claimAndUnwrapProportional(uint256 shares, address receiver, address ownerOrController)
        external
        returns (uint256 quoteAmount, uint256 equityAmount)
    {
        return claimAndUnwrapProportional(shares, receiver, ownerOrController, 0, 0);
    }

    function claimAndUnwrapProportional(
        uint256 shares,
        address receiver,
        address ownerOrController,
        uint256 minQuoteOut,
        uint256 minEquityOut
    ) public nonReentrant returns (uint256 quoteAmount, uint256 equityAmount) {
        if (matured) revert Matured();
        if (isSenior) revert SeniorQuoteOnly();
        if (receiver == address(0)) revert ZeroAddress();
        uint256 assets = redeem(shares, address(this), ownerOrController);
        (quoteAmount, equityAmount) = pipe.unwrapProportional(assets, receiver, minQuoteOut, minEquityOut);
        emit ProportionalUnwrapped(msg.sender, receiver, assets, quoteAmount, equityAmount);
    }

    /// @notice Post-settlement: transitions a pending withdraw request into a matured claim at the
    ///         frozen settlement rates. Permissionless — it only moves the user's own entitlement.
    function fulfillRedeemMatured(address user) external nonReentrant {
        if (!matured) revert NotMatured();
        if (user == address(0)) revert ZeroAddress();
        uint256 shares = pendingRedeemRequest(0, user);
        if (shares == 0) revert NothingPendingRedeem();
        _fulfillRedeem(shares, 0, user);
        emit MaturedRedeemFulfilled(user, shares);
    }

    /// @notice Post-settlement claim: pays the frozen settlement rates for all claimable shares of
    ///         the caller (requests fulfilled before or after settlement). Senior pays QUOTE only.
    function claimMatured(address receiver) external nonReentrant returns (uint256 quoteAmount, uint256 equityAmount) {
        if (!matured) revert NotMatured();
        if (receiver == address(0)) revert ZeroAddress();
        uint256 shares = maxRedeem(msg.sender);
        if (shares == 0) revert NothingToClaim();
        quoteAmount = shares.mulDiv(quotePerShare1e18, 1e18, Math.Rounding.Floor);
        equityAmount = shares.mulDiv(equityPerShare1e18, 1e18, Math.Rounding.Floor);
        redeem(shares, receiver, msg.sender);
        emit MaturedRedeem(msg.sender, receiver, shares, quoteAmount, equityAmount);
    }

    function maxDeposit(address) public view virtual override returns (uint256) {
        if (expired() || depositsPaused) return 0;
        uint256 cap = maxTotalAssets;
        if (cap == 0) return type(uint256).max;
        uint256 assets = totalAssets();
        return assets >= cap ? 0 : cap - assets;
    }

    function maxMint(address receiver) public view virtual override returns (uint256) {
        uint256 maxAssets = maxDeposit(receiver);
        if (maxAssets == type(uint256).max) return type(uint256).max;
        return _convertToShares(maxAssets, Math.Rounding.Floor);
    }

    function _requestRedeem(uint256 shares, address controller, address sharesOwner, uint256 requestId)
        internal
        virtual
        override(ERC7540, ERC7540AdminRedeem)
        returns (uint256)
    {
        return super._requestRedeem(shares, controller, sharesOwner, requestId);
    }

    /// @notice Medium (first-depositor inflation): the virtual-share offset scales the
    ///         seed cost of an inflation attack against the hook-share base unit
    ///         (1e15 shares per quote unit). Offset 6 raises the donation needed to
    ///         move the first share price meaningfully. Share decimals become 24.
    function _decimalsOffset() internal view virtual override returns (uint8) {
        return 6;
    }
}
