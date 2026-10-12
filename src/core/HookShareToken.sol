// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IHookShareToken } from "../interfaces/IHookShareToken.sol";

/// @notice The book's share token. ERC-20 plus the ERC-7575 share-to-vault lookup (`vault`) and
///         ERC-165 support for the share-side interface id `0xf815c03d` (SHOULD per EIP-7575).
///         Mint/burn are vault-only. `vault(asset)` returns the registered ERC-7575 entry point
///         for the asset (initially the vault itself; the vault owner can point it at the
///         dedicated entry contract and the `VaultUpdate` event fires, as the EIP prescribes).
contract HookShareToken is ERC20, IHookShareToken {
    address public immutable hook;
    address public immutable asset;
    address public vaultLookup;

    error NotHook(address caller);
    error ZeroAddress();

    event VaultUpdate(address indexed asset, address vault);

    modifier onlyHook() {
        if (msg.sender != hook) revert NotHook(msg.sender);
        _;
    }

    constructor(address hook_, address asset_) ERC20("Tranche JIT Share", "tjSHARE") {
        if (hook_ == address(0) || asset_ == address(0)) revert ZeroAddress();
        hook = hook_;
        asset = asset_;
        vaultLookup = hook_;
    }

    function vault(address asset_) external view returns (address) {
        return asset_ == asset ? vaultLookup : address(0);
    }

    /// @notice Registers the ERC-7575 entry point for the asset (vault-only, EIP-7575 lookup).
    function setVault(address vault_) external onlyHook {
        if (vault_ == address(0)) revert ZeroAddress();
        vaultLookup = vault_;
        emit VaultUpdate(asset, vault_);
    }

    /// @notice ERC-165: true for ERC-165 itself and the ERC-7575 share-side interface id.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0xf815c03d;
    }

    function mint(address to, uint256 amount) external onlyHook {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyHook {
        _burn(from, amount);
    }
}
