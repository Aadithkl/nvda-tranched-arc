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

    IERC20 public immutable usdc;
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

    bool public matured;
    uint256 public settledAt;
    uint256 public usdcPerShare1e18;
    uint256 public equityPerShare1e18;
    uint256 private _pendingMaturedShares;

    event OwnerUpdated(address indexed owner);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event GuardianUpdated(address indexed guardian);
    event AccountantUpdated(address indexed accountant);
    event DepositsPausedSet(bool paused);
    event MaxTotalAssetsUpdated(uint256 maxTotalAssets);
    event SharesMoved(address indexed to, uint256 amount);
    event UsdcDeposited(address indexed caller, address indexed receiver, uint256 usdcAmount, uint256 shares);
    event UsdcUnwrapped(address indexed caller, address indexed receiver, uint256 shares, uint256 usdcAmount);
    event EquityUnwrapped(address indexed caller, address indexed receiver, uint256 shares, uint256 equityAmount);
    event ProportionalUnwrapped(
        address indexed caller, address indexed receiver, uint256 shares, uint256 usdcAmount, uint256 equityAmount
    );
    event ExpirySet(uint64 expiry);
    event SettlementCredited(
        uint256 usdcAmount, uint256 equityAmount, uint256 usdcPerShare1e18, uint256 equityPerShare1e18
    );
    event MaturedRedeem(
        address indexed caller, address indexed receiver, uint256 shares, uint256 usdcAmount, uint256 equityAmount
    );

    error NotOwner(address caller);
    error NotPendingOwner(address caller);
    error NotOwnerOrGuardian(address caller);
    error NotAccountant(address caller);
    error NotPipe(address caller);
    error ZeroAddress();
    error ZeroAmount();
    error DepositCapExceeded(uint256 assets, uint256 maxAssets);
    error DepositsPaused();
    error SeniorUsdcOnly();
    error Expired();
    error Matured();
    error NotMatured();
    error SettlementAlreadyCredited();
    error SlippageExceeded(uint256 usdcAmount, uint256 equityAmount, uint256 minUsdcOut, uint256 minEquityOut);

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
        IERC20 usdc_,
        IERC20 equity_,
        IHookSharePipe pipe_,
        bool isSenior_,
        address owner_,
        address accountant_,
        uint64 expiry_
    ) ERC20(name_, symbol_) ERC7540(asset_) {
        if (address(usdc_) == address(0) || address(equity_) == address(0) || address(pipe_) == address(0)) {
            revert ZeroAddress();
        }
        usdc = usdc_;
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
        accountant = newAccountant;
        emit AccountantUpdated(newAccountant);
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
        IERC20(address(hookShare)).safeTransfer(to, amount);
        emit SharesMoved(to, amount);
    }

    function depositUSDC(uint256 usdcAmount, address receiver) external nonReentrant returns (uint256 shares) {
        if (usdcAmount == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        if (expired()) revert Expired();
        if (depositsPaused) revert DepositsPaused();

        uint256 cap = maxTotalAssets;
        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        usdc.forceApprove(address(pipe), usdcAmount);
        uint256 assets = pipe.wrapUSDC(usdcAmount, address(this));

        // Re-check the cap against post-wrap state so a reentrant or upgraded pipe cannot bypass it
        // with the pre-call snapshot (Slither reentrancy-balance).
        if (cap != 0 && totalAssets() > cap) revert DepositCapExceeded(totalAssets(), cap);

        uint256 assetsBefore = totalAssets() - assets;
        shares = assets.mulDiv(totalSupply() + 10 ** _decimalsOffset(), assetsBefore + 1, Math.Rounding.Floor);
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
        emit UsdcDeposited(msg.sender, receiver, usdcAmount, shares);
        _notifyDeposit(assets);
    }

    function deposit(uint256 assets, address receiver) public virtual override nonReentrant returns (uint256 shares) {
        if (expired()) revert Expired();
        shares = super.deposit(assets, receiver);
        _notifyDeposit(assets);
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
    ///      After settlement the vault holds USDC (and equity for junior) instead of hook shares,
    ///      so the payout is the frozen per-share rate (`_transferOut` intercepts the transfer).
    function _withdraw(address caller, address receiver, address sharesOwner, uint256 assets, uint256 shares)
        internal
        virtual
        override
    {
        if (matured) _pendingMaturedShares = shares;
        super._withdraw(caller, receiver, sharesOwner, assets, shares);
        if (matured) _pendingMaturedShares = 0;
        _notifyClaim(assets);
    }

    function _transferOut(address to, uint256 assets) internal virtual override {
        uint256 shares = _pendingMaturedShares;
        if (matured && shares != 0) {
            uint256 usdcAmount = shares.mulDiv(usdcPerShare1e18, 1e18, Math.Rounding.Floor);
            uint256 equityAmount = shares.mulDiv(equityPerShare1e18, 1e18, Math.Rounding.Floor);
            if (usdcAmount != 0) usdc.safeTransfer(to, usdcAmount);
            if (equityAmount != 0) equity.safeTransfer(to, equityAmount);
            emit MaturedRedeem(to, to, shares, usdcAmount, equityAmount);
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
    ///         pushes USDC (and equity for junior) into the vault.
    function creditSettlement(uint256 usdcAmount, uint256 equityAmount) external {
        if (msg.sender != address(pipe)) revert NotPipe(msg.sender);
        if (matured) revert SettlementAlreadyCredited();
        if (isSenior && equityAmount != 0) revert SeniorUsdcOnly();
        matured = true;
        settledAt = block.timestamp;
        uint256 supply = totalSupply();
        if (supply != 0) {
            usdcPerShare1e18 = usdcAmount.mulDiv(1e18, supply);
            equityPerShare1e18 = equityAmount.mulDiv(1e18, supply);
        }
        emit SettlementCredited(usdcAmount, equityAmount, usdcPerShare1e18, equityPerShare1e18);
    }

    function redeemAtExpiry(uint256 shares, address receiver)
        external
        returns (uint256 usdcAmount, uint256 equityAmount)
    {
        return redeemAtExpiry(shares, receiver, 0, 0);
    }

    /// @notice Burns the caller's vault shares and pays the frozen terminal payout directly:
    ///         USDC only for senior, USDC + equity pro-rata for junior. Available only after
    ///         settlement (see `matured`).
    function redeemAtExpiry(uint256 shares, address receiver, uint256 minUsdcOut, uint256 minEquityOut)
        public
        nonReentrant
        returns (uint256 usdcAmount, uint256 equityAmount)
    {
        if (!matured) revert NotMatured();
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        _burn(msg.sender, shares);
        usdcAmount = shares.mulDiv(usdcPerShare1e18, 1e18, Math.Rounding.Floor);
        equityAmount = shares.mulDiv(equityPerShare1e18, 1e18, Math.Rounding.Floor);
        if (usdcAmount < minUsdcOut || equityAmount < minEquityOut) {
            revert SlippageExceeded(usdcAmount, equityAmount, minUsdcOut, minEquityOut);
        }
        if (usdcAmount != 0) usdc.safeTransfer(receiver, usdcAmount);
        if (equityAmount != 0) equity.safeTransfer(receiver, equityAmount);
        emit MaturedRedeem(msg.sender, receiver, shares, usdcAmount, equityAmount);
    }

    function claimAndUnwrapUSDC(uint256 shares, address receiver, address ownerOrController)
        external
        returns (uint256 usdcAmount)
    {
        return claimAndUnwrapUSDC(shares, receiver, ownerOrController, 0);
    }

    function claimAndUnwrapUSDC(uint256 shares, address receiver, address ownerOrController, uint256 minUsdcOut)
        public
        nonReentrant
        returns (uint256 usdcAmount)
    {
        if (matured) revert Matured();
        if (receiver == address(0)) revert ZeroAddress();
        uint256 assets = redeem(shares, address(this), ownerOrController);
        usdcAmount = pipe.unwrapUSDC(assets, receiver, minUsdcOut);
        emit UsdcUnwrapped(msg.sender, receiver, assets, usdcAmount);
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
        if (isSenior) revert SeniorUsdcOnly();
        if (receiver == address(0)) revert ZeroAddress();
        uint256 assets = redeem(shares, address(this), ownerOrController);
        equityAmount = pipe.unwrapEquity(assets, receiver, minEquityOut);
        emit EquityUnwrapped(msg.sender, receiver, assets, equityAmount);
    }

    function claimAndUnwrapProportional(uint256 shares, address receiver, address ownerOrController)
        external
        returns (uint256 usdcAmount, uint256 equityAmount)
    {
        return claimAndUnwrapProportional(shares, receiver, ownerOrController, 0, 0);
    }

    function claimAndUnwrapProportional(
        uint256 shares,
        address receiver,
        address ownerOrController,
        uint256 minUsdcOut,
        uint256 minEquityOut
    ) public nonReentrant returns (uint256 usdcAmount, uint256 equityAmount) {
        if (matured) revert Matured();
        if (isSenior) revert SeniorUsdcOnly();
        if (receiver == address(0)) revert ZeroAddress();
        uint256 assets = redeem(shares, address(this), ownerOrController);
        (usdcAmount, equityAmount) = pipe.unwrapProportional(assets, receiver, minUsdcOut, minEquityOut);
        emit ProportionalUnwrapped(msg.sender, receiver, assets, usdcAmount, equityAmount);
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

    function requestRedeem(uint256 shares, address controller, address sharesOwner)
        public
        virtual
        override
        returns (uint256)
    {
        if (matured) revert Matured();
        return super.requestRedeem(shares, controller, sharesOwner);
    }

    function _requestRedeem(uint256 shares, address controller, address sharesOwner, uint256 requestId)
        internal
        virtual
        override(ERC7540, ERC7540AdminRedeem)
        returns (uint256)
    {
        return super._requestRedeem(shares, controller, sharesOwner, requestId);
    }

    function _decimalsOffset() internal view virtual override returns (uint8) {
        return 3;
    }
}
