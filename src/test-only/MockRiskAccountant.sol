// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { ITrancheAccountant } from "../interfaces/ITrancheAccountant.sol";

contract MockRiskAccountant is ITrancheAccountant {
    address public immutable override seniorVault;
    address public immutable override juniorVault;

    uint256 public override seniorClaim;
    uint256 public override juniorClaim;
    bool public override escrowFunded;

    constructor() {
        seniorVault = address(0);
        juniorVault = address(0);
    }

    function setClaims(uint256 seniorClaim_, uint256 juniorClaim_) external {
        seniorClaim = seniorClaim_;
        juniorClaim = juniorClaim_;
    }

    function setJuniorClaim(uint256 juniorClaim_) external {
        juniorClaim = juniorClaim_;
    }

    function setEscrowFunded(bool funded) external {
        escrowFunded = funded;
    }

    function poolValue() external view override returns (uint256) {
        return seniorClaim + juniorClaim;
    }

    function rebalance() external pure override returns (uint256, uint256) {
        return (0, 0);
    }
}
