// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { ERC7540 } from "openzeppelin-community-contracts/token/ERC20/extensions/ERC7540.sol";
import { ERC7540SyncDeposit } from "openzeppelin-community-contracts/token/ERC20/extensions/ERC7540SyncDeposit.sol";
import { ERC7540AdminRedeem } from "openzeppelin-community-contracts/token/ERC20/extensions/ERC7540AdminRedeem.sol";
import { IHookShareToken } from "../interfaces/IHookShareToken.sol";
import { IHookSharePipe } from "../interfaces/IHookSharePipe.sol";
import { ITrancheAccountant } from "../interfaces/ITrancheAccountant.sol";

abstract contract TrancheVault is ERC7540SyncDeposit, ERC7540AdminRedeem {
    using SafeERC20 for IERC20;
    using Math for uint256;

    IERC20 public immutable usdc;
    IHookShareToken public immutable hookShare;
    IHookSharePipe public immutable pipe;
    bool public immutable isSenior;

    address public owner;
    address public pendingOwner;
    address public guardian;
    address public accountant;
    bool public depositsPaused;
    uint256 public maxTotalAssets;

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

    error NotOwner(address caller);
    error NotPendingOwner(address caller);
    error NotOwnerOrGuardian(address caller);
    error NotAccountant(address caller);
    error ZeroAddress();
    error ZeroAmount();
    error DepositCapExceeded(uint256 assets, uint256 maxAssets);
    error SeniorUsdcOnly();

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
        IHookSharePipe pipe_,
        bool isSenior_,
        address owner_,
        address accountant_
    ) ERC20(name_, symbol_) ERC7540(asset_) {
        if (address(usdc_) == address(0) || address(pipe_) == address(0)) revert ZeroAddress();
        usdc = usdc_;
        hookShare = IHookShareToken(address(asset_));
        pipe = pipe_;
        isSenior = isSenior_;
        owner = owner_ == address(0) ? msg.sender : owner_;
        guardian = owner;
        accountant = accountant_;
        emit OwnerUpdated(owner);
        emit GuardianUpdated(guardian);
        emit AccountantUpdated(accountant_);
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
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        IERC20(address(hookShare)).safeTransfer(to, amount);
        emit SharesMoved(to, amount);
    }

    function depositUSDC(uint256 usdcAmount, address receiver) external returns (uint256 shares) {
        if (usdcAmount == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        uint256 maxAssets = maxDeposit(receiver);
        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        usdc.forceApprove(address(pipe), usdcAmount);
        uint256 assets = pipe.wrapUSDC(usdcAmount, address(this));
        if (assets > maxAssets) revert DepositCapExceeded(assets, maxAssets);

        uint256 assetsBefore = totalAssets() - assets;
        shares = assets.mulDiv(totalSupply() + 10 ** _decimalsOffset(), assetsBefore + 1, Math.Rounding.Floor);
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
        emit UsdcDeposited(msg.sender, receiver, usdcAmount, shares);
        _notifyDeposit(assets);
    }

    function deposit(uint256 assets, address receiver) public virtual override returns (uint256 shares) {
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

    function claimAndUnwrapUSDC(uint256 shares, address receiver, address ownerOrController)
        external
        returns (uint256 usdcAmount)
    {
        return claimAndUnwrapUSDC(shares, receiver, ownerOrController, 0);
    }

    function claimAndUnwrapUSDC(uint256 shares, address receiver, address ownerOrController, uint256 minUsdcOut)
        public
        returns (uint256 usdcAmount)
    {
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
        returns (uint256 equityAmount)
    {
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
    ) public returns (uint256 usdcAmount, uint256 equityAmount) {
        if (isSenior) revert SeniorUsdcOnly();
        if (receiver == address(0)) revert ZeroAddress();
        uint256 assets = redeem(shares, address(this), ownerOrController);
        (usdcAmount, equityAmount) = pipe.unwrapProportional(assets, receiver, minUsdcOut, minEquityOut);
        emit ProportionalUnwrapped(msg.sender, receiver, assets, usdcAmount, equityAmount);
    }

    function maxDeposit(address) public view virtual override returns (uint256) {
        if (depositsPaused) return 0;
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

    function _decimalsOffset() internal view virtual override returns (uint8) {
        return 3;
    }
}
