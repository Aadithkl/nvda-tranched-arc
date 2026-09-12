// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface ITrancheHookValue {
    function convertToUsdc(uint256 shares) external view returns (uint256);
}
