// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IHooks } from "v4-core/src/interfaces/IHooks.sol";
import { IPoolManager } from "v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "v4-core/src/types/PoolKey.sol";
import { PoolId } from "v4-core/src/types/PoolId.sol";
import { Currency, CurrencyLibrary } from "v4-core/src/types/Currency.sol";
import { PoolGuardHook } from "./PoolGuardHook.sol";
import { GuardParams } from "./libraries/GuardParams.sol";
import { IBookHook } from "../interfaces/IBookHook.sol";

/// @notice Custody + execution for the two static-fee books (low/high fee, same token pair).
///         Owns BOTH `PoolGuardHook` instances and implements `IBookHook` by forwarding to the
///         active book and aggregating idle/claims over both, so the vault, the 7575 entry and
///         readiness work through it unchanged. The vault owns this hub (single-step Ownable —
///         the vault cannot accept two-step ownership); the keeper (strategy controller) drives
///         day-to-day ops. Hook inventory sweeps go straight to the hook-recorded vault, never
///         resting here, except transiently inside a migration (fundHub -> pushToActive).
///         Migration itself is policy-gated on the controller; this hub only executes.
///         Book sweeps land here (each book's recorded vault is this hub), so every
///         mutating path ends with a sweep to the real vault — the hub never holds
///         between transactions and the box stays fully counted.
contract DualBookHub is Ownable2Step, IBookHook, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using CurrencyLibrary for Currency;

    IPoolManager public immutable poolManager;
    /// @notice The real vault: sweep target. Set once by the owner at deploy (it cannot be
    ///         a constructor arg — the vault itself takes the hub as its hook). Owner-only,
    ///         and ownership moves to the vault immediately after, so no redirection window.
    address public vault;
    PoolGuardHook public immutable bookA;
    PoolGuardHook public immutable bookB;
    PoolKey internal _keyA;
    PoolKey internal _keyB;
    IERC20 public immutable quote;
    IERC20 public immutable equity;
    address public keeper;
    uint8 public activeBook;

    event KeeperUpdated(address indexed keeper);
    event ActiveBookSet(uint8 indexed fromBook, uint8 indexed toBook);

    error ZeroAddress();
    error NotOwnerOrKeeper(address caller);
    error UnknownBook(uint8 book);
    error SameBook(uint8 book);
    error PairMismatch();
    error InvalidBookKey();

    modifier onlyOwnerOrKeeper() {
        if (msg.sender != owner() && msg.sender != keeper) revert NotOwnerOrKeeper(msg.sender);
        _;
    }

    constructor(
        IPoolManager poolManager_,
        PoolGuardHook bookA_,
        PoolGuardHook bookB_,
        PoolKey memory keyA_,
        PoolKey memory keyB_,
        IERC20 quote_,
        IERC20 equity_,
        address owner_,
        address keeper_
    ) Ownable(owner_ == address(0) ? msg.sender : owner_) {
        if (
            address(poolManager_) == address(0) || address(bookA_) == address(0) || address(bookB_) == address(0)
                || address(bookA_) == address(bookB_) || address(quote_) == address(0) || address(equity_) == address(0)
        ) revert ZeroAddress();
        if (
            Currency.unwrap(keyA_.currency0) != Currency.unwrap(keyB_.currency0)
                || Currency.unwrap(keyA_.currency1) != Currency.unwrap(keyB_.currency1)
        ) revert PairMismatch();
        poolManager = poolManager_;
        bookA = bookA_;
        bookB = bookB_;
        _keyA = keyA_;
        _keyB = keyB_;
        quote = quote_;
        equity = equity_;
        keeper = keeper_;
        emit KeeperUpdated(keeper_);
    }

    function setKeeper(address keeper_) external onlyOwner {
        keeper = keeper_;
        emit KeeperUpdated(keeper_);
    }

    event VaultUpdated(address indexed vault);

    /// @notice Sets the real vault (deploy wiring; use once before handing ownership over).
    function setVault(address vault_) external onlyOwner {
        if (vault_ == address(0)) revert ZeroAddress();
        vault = vault_;
        emit VaultUpdated(vault_);
    }

    function _book(uint8 i) internal view returns (PoolGuardHook) {
        if (i > 1) revert UnknownBook(i);
        return i == 0 ? bookA : bookB;
    }

    function _active() internal view returns (PoolGuardHook) {
        return _book(activeBook);
    }

    // ---------------------------------------------------------------------
    // Active-book forwarders (IBookHook surface)
    // ---------------------------------------------------------------------

    function setDeployEnabled(bool enabled) external override onlyOwnerOrKeeper nonReentrant {
        _active().setDeployEnabled(enabled);
    }

    function recenterGuard() external override onlyOwnerOrKeeper nonReentrant {
        _active().recenterGuard();
    }

    function deployGuard() external override onlyOwnerOrKeeper nonReentrant {
        _active().deployGuard();
    }

    function rearm() external override onlyOwnerOrKeeper nonReentrant {
        _active().rearm();
    }

    function setGuardParams(GuardParams.Params calldata params) external override onlyOwnerOrKeeper nonReentrant {
        _active().setGuardParams(params);
    }

    /// @notice Routes by the key's hook address (both books share the token pair, so
    ///         currency matching cannot tell them apart). Each book re-validates.
    function initializeBook(PoolKey calldata key, uint160 sqrtPriceX96)
        external
        override
        onlyOwnerOrKeeper
        nonReentrant
        returns (int24 tick)
    {
        if (address(key.hooks) == address(bookA)) return bookA.initializeBook(key, sqrtPriceX96);
        if (address(key.hooks) == address(bookB)) return bookB.initializeBook(key, sqrtPriceX96);
        revert InvalidBookKey();
    }

    function acceptHookOwnership() external override onlyOwnerOrKeeper {
        bookA.acceptOwnership();
        bookB.acceptOwnership();
    }

    /// @notice Pulls the guard and returns inventory to the vault on BOTH books (safe
    ///         stand-down). Skips books never initialized (staged deployments). Book sweeps
    ///         land here first; forwarded to the real vault at the end.
    function recallToVault() external override onlyOwnerOrKeeper nonReentrant {
        if (bookA.poolInitialized()) bookA.recallToVault();
        if (bookB.poolInitialized()) bookB.recallToVault();
        _sweepToVault();
    }

    /// @notice Exact idle amounts back to the vault, active book first, remainder from
    ///         inactive. Book pulls land here first; forwarded to the real vault at the end.
    function withdrawInventory(uint256 quoteAmount, uint256 equityAmount)
        external
        override
        onlyOwnerOrKeeper
        nonReentrant
    {
        IdlePair memory idle = _idleOf(_active());
        uint256 qTake = quoteAmount < idle.quoteIdle ? quoteAmount : idle.quoteIdle;
        uint256 eTake = equityAmount < idle.equityIdle ? equityAmount : idle.equityIdle;
        if (qTake != 0 || eTake != 0) _active().withdrawInventory(qTake, eTake);
        uint256 qRest = quoteAmount - qTake;
        uint256 eRest = equityAmount - eTake;
        if (qRest != 0 || eRest != 0) _book(activeBook == 0 ? 1 : 0).withdrawInventory(qRest, eRest);
        _sweepToVault();
    }

    /// @notice Redeems pool-manager claims into idle inventory on both books (permissionless
    ///         upstream). Skips books never initialized.
    function unwindClaims() external override nonReentrant {
        if (bookA.poolInitialized()) bookA.unwindClaims();
        if (bookB.poolInitialized()) bookB.unwindClaims();
    }

    /// @notice Full exit on both books (halt/settlement path). Skips uninitialized books and
    ///         books already exited — halt must stay idempotent across migrations. Book sweeps
    ///         land here first; forwarded to the real vault at the end.
    function pullAll() external override onlyOwnerOrKeeper nonReentrant {
        if (bookA.poolInitialized() && !bookA.exited()) bookA.pullAll();
        if (bookB.poolInitialized() && !bookB.exited()) bookB.pullAll();
        _sweepToVault();
    }

    // ---------------------------------------------------------------------
    // Migration (controller policy-gated upstream; execution only here)
    // ---------------------------------------------------------------------

    /// @notice Pulls the from-book fully out, sweeps everything to the vault (counted),
    ///         and flips the pointer. Fund + arm the new book afterwards (vault funds hub,
    ///         pushToActive forwards, activateAndDeploy arms). Both pools stay initialized.
    ///         Skips uninitialized/exited from-books and requires the target book
    ///         to be initialized (pulling a never-initialized from-book would revert
    ///         with `BookNotInitialized` on a flipped pointer).
    function pullInactiveAndActivate(uint8 to) external onlyOwnerOrKeeper nonReentrant {
        if (to > 1) revert UnknownBook(to);
        uint8 from = activeBook;
        if (to == from) revert SameBook(to);
        if (!_book(to).poolInitialized()) revert InvalidBookKey();
        // Flip first (checks-effects-interactions): the pull below calls out to the
        // book/pool, and no reentrant path may observe the stale pointer.
        activeBook = to;
        emit ActiveBookSet(from, to);
        if (_book(from).poolInitialized() && !_book(from).exited()) _book(from).pullAll();
        _sweepToVault();
    }

    /// @notice Forwards tokens transiently held here (vault funding) into the active book.
    function pushToActive() external onlyOwnerOrKeeper nonReentrant {
        PoolGuardHook b = _active();
        uint256 quoteBal = quote.balanceOf(address(this));
        uint256 equityBal = equity.balanceOf(address(this));
        if (quoteBal != 0) quote.safeTransfer(address(b), quoteBal);
        if (equityBal != 0) equity.safeTransfer(address(b), equityBal);
    }

    /// @notice Arms the active book after funding: re-arms a previously pulled book
    ///         (restores base + guard from the pushed inventory) or deploys the guard on
    ///         a fresh book. The plain `deployGuard` stays a strict forward — no magic.
    function activateAndDeploy() external onlyOwnerOrKeeper nonReentrant {
        PoolGuardHook b = _active();
        if (b.exited()) b.rearm();
        else b.deployGuard();
    }

    // ---------------------------------------------------------------------
    // Views (IBookHook surface + hub aggregation)
    // ---------------------------------------------------------------------

    function poolInitialized() external view override returns (bool) {
        return _active().poolInitialized();
    }

    function exited() external view override returns (bool) {
        return bookA.exited() && bookB.exited();
    }

    function guardPresent() external view override returns (bool) {
        return _active().guardPresent();
    }

    function basePosition() external view override returns (int24 tickLower, int24 tickUpper, uint128 liquidity) {
        return _active().basePosition();
    }

    function guardPosition() external view override returns (int24 tickLower, int24 tickUpper, uint128 liquidity) {
        return _active().guardPosition();
    }

    function activePoolId() external view override returns (PoolId) {
        return _active().activePoolId();
    }

    function activeKey() external view returns (PoolKey memory) {
        return activeBook == 0 ? _keyA : _keyB;
    }

    function quoteIdle() external view override returns (uint256) {
        return _idleOf(bookA).quoteIdle + _idleOf(bookB).quoteIdle + quote.balanceOf(address(this));
    }

    function equityIdle() external view override returns (uint256) {
        return _idleOf(bookA).equityIdle + _idleOf(bookB).equityIdle + equity.balanceOf(address(this));
    }

    function claims(address token) external view override returns (uint256) {
        return poolManager.balanceOf(address(bookA), Currency.wrap(token).toId())
            + poolManager.balanceOf(address(bookB), Currency.wrap(token).toId());
    }

    /// @notice Deviation of the ACTIVE book (the only one with positions —
    ///         migration pulls the from-book fully before flipping).
    function oracleDeviationBps() external view override returns (bool ok, uint256 deviationBps) {
        return _active().oracleDeviationBps();
    }

    function inventory() external view returns (uint256 quoteUnits, uint256 equityUnits) {
        // Transient migration funding (fundHub -> pushToActive) sits here between
        // transactions — include `address(this)` so the box stays fully counted.
        quoteUnits = quote.balanceOf(address(bookA)) + quote.balanceOf(address(bookB)) + quote.balanceOf(address(this));
        equityUnits =
            equity.balanceOf(address(bookA)) + equity.balanceOf(address(bookB)) + equity.balanceOf(address(this));
    }

    /// @notice Per-book liveness views (medium: active-only views hid the inactive book).
    function bookExited(uint8 book) external view returns (bool) {
        return _book(book).exited();
    }

    function bookGuardPresent(uint8 book) external view returns (bool) {
        return _book(book).guardPresent();
    }

    function bookPoolInitialized(uint8 book) external view returns (bool) {
        return _book(book).poolInitialized();
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    struct IdlePair {
        uint256 quoteIdle;
        uint256 equityIdle;
    }

    function _idleOf(PoolGuardHook book) internal view returns (IdlePair memory idle) {
        idle.quoteIdle = quote.balanceOf(address(book));
        idle.equityIdle = equity.balanceOf(address(book));
    }

    /// @notice Forwards everything held here to the real vault. Book sweeps land here
    ///         because each book's recorded vault is this hub — without this the funds
    ///         would strand mid-custody and leave the box uncounted.
    function _sweepToVault() internal {
        address vault_ = vault;
        if (vault_ == address(0)) revert ZeroAddress();
        uint256 quoteBal = quote.balanceOf(address(this));
        uint256 equityBal = equity.balanceOf(address(this));
        if (quoteBal != 0) quote.safeTransfer(vault_, quoteBal);
        if (equityBal != 0) equity.safeTransfer(vault_, equityBal);
    }
}
