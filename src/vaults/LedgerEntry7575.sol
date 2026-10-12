// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IPoolManager } from "v4-core/src/interfaces/IPoolManager.sol";
import { Currency } from "v4-core/src/types/Currency.sol";
import { TickMath } from "v4-core/src/libraries/TickMath.sol";
import { StateLibrary } from "v4-core/src/libraries/StateLibrary.sol";
import { IERC7575 } from "../interfaces/IERC7575.sol";
import { HookShareToken } from "../core/HookShareToken.sol";
import { INVDAPriceOracle } from "../interfaces/INVDAPriceOracle.sol";
import { IBookHook } from "../interfaces/IBookHook.sol";
import { IStrategyModule } from "../adapters/IStrategyModule.sol";
import { LiquidityAmounts } from "../hook/libraries/LiquidityAmounts.sol";

/// @notice Minimal pipe/read surface the entry needs from the book vault.
interface ILedgerVaultPipe {
    function wrapQuote(uint256 quoteAmount, address receiver) external returns (uint256 shares);
    function wrapSharesExact(uint256 shares, address receiver) external returns (uint256 assets);
    function unwrapQuote(uint256 shares, address receiver, uint256 minQuoteOut) external returns (uint256 quoteAmount);
    function totalManagedAssets() external view returns (uint256);
    function convertToShares(uint256 quoteAmount) external view returns (uint256);
    function convertToQuote(uint256 shares) external view returns (uint256);
    function expired() external view returns (bool);
    function guardRecallOnWithdraw() external view returns (bool);
    function SHARE_SCALE() external view returns (uint256);
    function virtualAssets() external view returns (uint256);
    function shareToken() external view returns (address);
    function quote() external view returns (address);
    function equity() external view returns (address);
    function hook() external view returns (address);
    function poolManager() external view returns (address);
    function priceOracle() external view returns (address);
    function aToken() external view returns (address);
    function strategyModule() external view returns (address);
}

/// @notice ERC-7575 (multi-asset ERC-4626) entry point for the book's USDG side. Stateless
///         pass-through: it implements the standard surface by piping through `LedgerVault`'s
///         existing wrap/unwrap functions and the share token's standard ERC-20 allowances, so
///         the audited vault stays untouched. Deposits/redemptions require approving this entry
///         (QUOTE for entries, shares for exits); acting for another `owner` requires that owner's
///         share allowance to this entry. The share token's `vault(USDG)` lookup is pointed here
///         by the vault owner (`LedgerVault.setShareVault`), per EIP-7575.
///
///         Rounding note: `withdraw` transfers exactly `assets` (the burned shares are rounded up
///         in the vault's favor; at most a rounding unit of QUOTE remains in this entry).
contract LedgerEntry7575 is IERC7575 {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;

    /// @dev Must match LedgerVault's virtual-share offsets (consistency is asserted in tests).
    uint256 internal constant VIRTUAL_SHARES = 1e3;

    address public immutable vault;
    HookShareToken public immutable shareToken;
    IERC20 public immutable quote;
    IERC20 public immutable equity;
    IBookHook public immutable hook;
    IPoolManager public immutable poolManager;
    address public immutable priceOracle;
    uint256 public immutable shareScale;
    bool public immutable quoteIs0;

    error ZeroAmount();
    error ZeroAddress();
    error OracleInvalid();

    constructor(address vault_) {
        if (vault_ == address(0)) revert ZeroAddress();
        vault = vault_;
        ILedgerVaultPipe pipe = ILedgerVaultPipe(vault_);
        shareToken = HookShareToken(pipe.shareToken());
        quote = IERC20(pipe.quote());
        equity = IERC20(pipe.equity());
        hook = IBookHook(pipe.hook());
        poolManager = IPoolManager(pipe.poolManager());
        priceOracle = pipe.priceOracle();
        shareScale = pipe.SHARE_SCALE();
        quoteIs0 = address(quote) < address(equity);
    }

    // ---------------------------------------------------------------------
    // ERC-165 / ERC-7575 surface
    // ---------------------------------------------------------------------

    /// @notice ERC-165: ERC-165 itself and the ERC-7575 vault interface id (EIP-7575 constant).
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x2f0a18c5;
    }

    function share() external view returns (address) {
        return address(shareToken);
    }

    function asset() external view returns (address) {
        return address(quote);
    }

    function totalAssets() public view returns (uint256) {
        return ILedgerVaultPipe(vault).totalManagedAssets();
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        return ILedgerVaultPipe(vault).convertToShares(assets);
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return ILedgerVaultPipe(vault).convertToQuote(shares);
    }

    function previewDeposit(uint256 assets) external view returns (uint256) {
        return convertToShares(assets);
    }

    /// @dev Rounded up (ERC-4626); mirrors the vault's exact-share mint.
    function previewMint(uint256 shares) public view returns (uint256) {
        uint256 scaledTotal = totalAssets() * shareScale;
        uint256 scaledSupply = (shareToken.totalSupply() + VIRTUAL_SHARES) * shareScale;
        return
            Math.mulDiv(shares, scaledTotal + ILedgerVaultPipe(vault).virtualAssets(), scaledSupply, Math.Rounding.Ceil);
    }

    /// @dev Rounded up (ERC-4626); mirrors the vault's share math for a given quote amount.
    function previewWithdraw(uint256 assets) public view returns (uint256) {
        uint256 scaledTotal = totalAssets() * shareScale;
        return Math.mulDiv(
            assets * shareScale,
            shareToken.totalSupply() + VIRTUAL_SHARES,
            scaledTotal + ILedgerVaultPipe(vault).virtualAssets(),
            Math.Rounding.Ceil
        );
    }

    function previewRedeem(uint256 shares) external view returns (uint256) {
        return convertToAssets(shares);
    }

    function maxDeposit(address) public view returns (uint256) {
        return _entryOpen() ? type(uint256).max : 0;
    }

    function maxMint(address) external view returns (uint256) {
        return maxDeposit(address(0));
    }

    function maxWithdraw(address owner) public view returns (uint256) {
        uint256 value = convertToAssets(shareToken.balanceOf(owner));
        uint256 available = maxWithdrawableQuote();
        return value < available ? value : available;
    }

    function maxRedeem(address owner) public view returns (uint256) {
        uint256 balance = shareToken.balanceOf(owner);
        uint256 forLiquidity = convertToShares(maxWithdrawableQuote());
        return balance < forLiquidity ? balance : forLiquidity;
    }

    /// @notice Quote units the book's redemption ladder can reach in one transaction (mirrors
    ///         LedgerVault._ensureQuote): idle, hook inventory, venue cash, redemption-safe
    ///         strategy adapters and (last resort) the guard position under recall policy.
    function maxWithdrawableQuote() public view returns (uint256 available) {
        available = quote.balanceOf(vault) + hook.quoteIdle();

        address aToken = ILedgerVaultPipe(vault).aToken();
        if (aToken != address(0)) {
            uint256 held = IERC20(aToken).balanceOf(vault);
            uint256 cash = quote.balanceOf(aToken);
            available += held < cash ? held : cash;
        }

        address module = ILedgerVaultPipe(vault).strategyModule();
        if (module != address(0)) available += IStrategyModule(module).pullableAssets();

        if (ILedgerVaultPipe(vault).guardRecallOnWithdraw() && hook.guardPresent()) {
            (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(hook.activePoolId());
            if (sqrtPriceX96 != 0) {
                (int24 lo, int24 hi, uint128 liquidity) = hook.guardPosition();
                if (liquidity != 0) {
                    (uint256 a0, uint256 a1) = LiquidityAmounts.getAmountsForLiquidity(
                        sqrtPriceX96, TickMath.getSqrtPriceAtTick(lo), TickMath.getSqrtPriceAtTick(hi), liquidity
                    );
                    available += quoteIs0 ? a0 : a1;
                }
            }
        }
    }

    // ---------------------------------------------------------------------
    // Flows (stateless pass-through; approvals to this entry, shares hop through it)
    // ---------------------------------------------------------------------

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        quote.safeTransferFrom(msg.sender, address(this), assets);
        quote.forceApprove(vault, assets);
        shares = ILedgerVaultPipe(vault).wrapQuote(assets, receiver);
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    function mint(uint256 shares, address receiver) external returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        assets = previewMint(shares);
        quote.safeTransferFrom(msg.sender, address(this), assets);
        quote.forceApprove(vault, assets);
        ILedgerVaultPipe(vault).wrapSharesExact(shares, receiver);
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        shares = previewWithdraw(assets);
        shareToken.transferFrom(owner, address(this), shares);
        ILedgerVaultPipe(vault).unwrapQuote(shares, address(this), 0);
        quote.safeTransfer(receiver, assets);
        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }

    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        shareToken.transferFrom(owner, address(this), shares);
        assets = ILedgerVaultPipe(vault).unwrapQuote(shares, receiver, 0);
        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _entryOpen() internal view returns (bool) {
        if (ILedgerVaultPipe(vault).expired()) return false;
        INVDAPriceOracle.PriceData memory data = INVDAPriceOracle(priceOracle).getPrice();
        return data.valid && data.mid > 0;
    }
}
