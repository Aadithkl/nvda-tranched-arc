// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IMorpho } from "./IMorpho.sol";
import { IStrategyAdapter } from "./IStrategyAdapter.sol";

/// @notice Morpho Blue lending adapter (loan-side only, direct `supply` — permissionless, unlike
///         the gated Vault V2s). Always-withdrawable within market liquidity; redemption-safe.
///         Primary lend venue on Robinhood Chain (USDG markets).
contract MorphoBlueLendAdapter is IStrategyAdapter {
    using SafeERC20 for IERC20;

    uint256 internal constant VIRTUAL_SHARES = 1e6;
    uint256 internal constant VIRTUAL_ASSETS = 1;

    address public immutable override authority;
    address public immutable override asset;
    IMorpho public immutable morpho;
    bytes32 public immutable marketId;

    IMorpho.MarketParams internal _marketParams;

    constructor(address authority_, address morpho_, IMorpho.MarketParams memory marketParams_, address asset_) {
        if (authority_ == address(0) || morpho_ == address(0) || asset_ == address(0)) revert ZeroAddress();
        if (marketParams_.loanToken != asset_) revert AssetMismatch();
        authority = authority_;
        morpho = IMorpho(morpho_);
        asset = asset_;
        _marketParams = marketParams_;
        marketId = keccak256(abi.encode(marketParams_));
    }

    error AssetMismatch();

    modifier onlyAuthority() {
        if (msg.sender != authority) revert NotAuthority(msg.sender);
        _;
    }

    function marketParams() external view returns (IMorpho.MarketParams memory) {
        return _marketParams;
    }

    function supplyShares() public view returns (uint256 shares) {
        (shares,,) = morpho.position(marketId, address(this));
    }

    function realAssets() public view returns (uint256) {
        uint256 shares = supplyShares();
        if (shares == 0) return 0;
        IMorpho.Market memory m = morpho.market(marketId);
        return Math.mulDiv(
            shares, uint256(m.totalSupplyAssets) + VIRTUAL_ASSETS, uint256(m.totalSupplyShares) + VIRTUAL_SHARES
        );
    }

    function maxWithdrawable() public view returns (uint256) {
        uint256 held = realAssets();
        IMorpho.Market memory m = morpho.market(marketId);
        uint256 available = uint256(m.totalSupplyAssets) > uint256(m.totalBorrowAssets)
            ? uint256(m.totalSupplyAssets) - uint256(m.totalBorrowAssets)
            : 0;
        return held < available ? held : available;
    }

    function deposit(uint256 amount) external onlyAuthority returns (uint256 deployed) {
        if (amount == 0) revert ZeroAmount();
        IERC20(asset).safeTransferFrom(authority, address(this), amount);
        IERC20(asset).forceApprove(address(morpho), amount);
        morpho.supply(_marketParams, amount, 0, address(this), "");
        IERC20(asset).forceApprove(address(morpho), 0);
        deployed = amount;
    }

    function withdraw(uint256 amount, address to) external onlyAuthority returns (uint256 withdrawn) {
        if (amount == 0 || to == address(0)) revert ZeroAmount();
        amount = amount < maxWithdrawable() ? amount : maxWithdrawable();
        if (amount == 0) return 0;
        (withdrawn,) = morpho.withdraw(_marketParams, amount, 0, address(this), to);
    }

    function exit(uint256 amount, address to) external onlyAuthority returns (uint256 withdrawn) {
        uint256 limit = maxWithdrawable();
        amount = amount < limit ? amount : limit;
        if (amount == 0 || to == address(0)) return 0;
        (withdrawn,) = morpho.withdraw(_marketParams, amount, 0, address(this), to);
    }
}
