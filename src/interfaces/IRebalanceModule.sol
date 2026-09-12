// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IRebalanceModule {
    function rebalanceSwap(bool equityOut, uint256 amountIn, uint256 minOut, uint256 deadline) external;

    function equityToUsdc(uint256 equityAmount) external view returns (uint256);
}
