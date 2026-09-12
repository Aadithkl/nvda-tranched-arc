// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { ITrancheAccountant } from "../interfaces/ITrancheAccountant.sol";
import { TrancheVault } from "../vaults/TrancheVault.sol";

contract MockAccountant is ITrancheAccountant {
    address public immutable override seniorVault;
    address public immutable override juniorVault;

    uint256 public override seniorClaim;
    uint256 public override juniorClaim;

    constructor(address seniorVault_, address juniorVault_) {
        seniorVault = seniorVault_;
        juniorVault = juniorVault_;
    }

    function poolValue() external view override returns (uint256) {
        return seniorClaim + juniorClaim;
    }

    function setClaims(uint256 seniorClaim_, uint256 juniorClaim_) external {
        seniorClaim = seniorClaim_;
        juniorClaim = juniorClaim_;
    }

    function rebalance() external pure override returns (uint256 seniorShares, uint256 juniorShares) {
        return (0, 0);
    }

    function moveShares(TrancheVault vault, address to, uint256 amount) external {
        vault.moveShares(to, amount);
    }

    function fulfill(TrancheVault vault, uint256 shares, uint256 assets, address controller) external {
        vault.fulfillRedeem(shares, assets, controller);
    }
}
