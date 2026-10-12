// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface ITrancheHookValue {
    function convertToQuote(uint256 shares) external view returns (uint256);

    function expired() external view returns (bool);
}
