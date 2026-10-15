// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { IStrategyAdapter } from "./IStrategyAdapter.sol";

/// @notice Fixed-function adapter for any ERC-4626 venue (lend/rest venue, always-withdrawable;
///         redemption-safe). Reports `realAssets` via the vault's own accounting.
contract ERC4626Adapter is IStrategyAdapter {
    using SafeERC20 for IERC20;

    address public immutable override authority;
    address public immutable override asset;
    IERC4626 public immutable target;

    constructor(address authority_, address target_, address asset_) {
        if (authority_ == address(0) || target_ == address(0) || asset_ == address(0)) revert ZeroAddress();
        if (IERC4626(target_).asset() != asset_) revert AssetMismatch();
        authority = authority_;
        target = IERC4626(target_);
        asset = asset_;
    }

    error AssetMismatch();

    modifier onlyAuthority() {
        if (msg.sender != authority) revert NotAuthority(msg.sender);
        _;
    }

    function realAssets() public view returns (uint256) {
        uint256 shares = target.balanceOf(address(this));
        return shares == 0 ? 0 : target.convertToAssets(shares);
    }

    function maxWithdrawable() public view returns (uint256) {
        uint256 held = realAssets();
        uint256 venueLimit = target.maxWithdraw(address(this));
        return held < venueLimit ? held : venueLimit;
    }

    function deposit(uint256 amount) external onlyAuthority returns (uint256 deployed) {
        if (amount == 0) revert ZeroAmount();
        IERC20(asset).safeTransferFrom(authority, address(this), amount);
        IERC20(asset).forceApprove(address(target), amount);
        // `target.deposit` returns SHARES, not assets. Accounting it as assets
        // double-counts when pps>1 and underflows when pps<1.
        uint256 shares = target.deposit(amount, address(this));
        IERC20(asset).forceApprove(address(target), 0);
        deployed = shares == 0 ? 0 : target.convertToAssets(shares);
        if (deployed > amount) deployed = amount;
    }

    function withdraw(uint256 amount, address to) external onlyAuthority returns (uint256 withdrawn) {
        if (amount == 0 || to == address(0)) revert ZeroAmount();
        uint256 limit = maxWithdrawable();
        amount = amount < limit ? amount : limit;
        if (amount == 0) return 0;
        withdrawn = target.withdraw(amount, to, address(this));
    }

    function exit(uint256 amount, address to) external onlyAuthority returns (uint256 withdrawn) {
        uint256 limit = maxWithdrawable();
        amount = amount < limit ? amount : limit;
        if (amount == 0 || to == address(0)) return 0;
        withdrawn = target.withdraw(amount, to, address(this));
    }
}
