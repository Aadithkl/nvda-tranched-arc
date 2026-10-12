// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice ERC-7575 (Multi-Asset ERC-4626 Vaults) entry-point surface: ERC-4626 minus the ERC-20
///         methods and events, plus `share()`. This is what an entry point (a "Pipe" in EIP-7575
///         terms) exposes for one asset; the external share token carries the ERC-20 and the
///         share-to-vault lookup (`vault(address)`), and the ERC-20 dependency is intentionally
///         not part of the vault.
///
///         ERC-165: implementing vaults MUST return true for the EIP-7575 vault id `0x2f0a18c5`
///         (and the ERC-165 id `0x01ffc9a7`); the share token returns `0xf815c03d` for the
///         share-side interface. Per the EIP, vaults implement ERC-4626 *excluding* the ERC-20
///         methods and events, while still returning the constant id.
interface IERC7575 {
    /// @dev `owner` is the receiver of the minted shares.
    event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares);

    /// @dev `receiver` receives the assets; `owner` is the address whose shares are burned.
    event Withdraw(
        address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares
    );

    /// @notice Address of the external ERC-20 share token received on deposit.
    function share() external view returns (address);

    /// @notice The vault's single asset for this entry point (the quote unit, e.g. USDG).
    function asset() external view returns (address);

    /// @notice Total value managed by the book, in `asset` units (the vault's NAV definition).
    function totalAssets() external view returns (uint256);

    function convertToShares(uint256 assets) external view returns (uint256);

    function convertToAssets(uint256 shares) external view returns (uint256);

    function maxDeposit(address receiver) external view returns (uint256);

    function previewDeposit(uint256 assets) external view returns (uint256);

    function deposit(uint256 assets, address receiver) external returns (uint256 shares);

    function maxMint(address receiver) external view returns (uint256);

    function previewMint(uint256 shares) external view returns (uint256);

    function mint(uint256 shares, address receiver) external returns (uint256 assets);

    function maxWithdraw(address owner) external view returns (uint256);

    function previewWithdraw(uint256 assets) external view returns (uint256);

    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);

    function maxRedeem(address owner) external view returns (uint256);

    function previewRedeem(uint256 shares) external view returns (uint256);

    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
}
