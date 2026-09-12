// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IHookSharePipe {
    function wrapUSDC(uint256 usdcAmount, address receiver) external returns (uint256 shares);

    function unwrapUSDC(uint256 shares, address receiver) external returns (uint256 usdcAmount);

    function unwrapUSDC(uint256 shares, address receiver, uint256 minUsdcOut) external returns (uint256 usdcAmount);
}
