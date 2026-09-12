// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface ITrancheAccountant {
    function seniorVault() external view returns (address);

    function juniorVault() external view returns (address);

    function seniorClaim() external view returns (uint256);

    function juniorClaim() external view returns (uint256);

    function poolValue() external view returns (uint256);

    function rebalance() external returns (uint256 seniorShares, uint256 juniorShares);
}
