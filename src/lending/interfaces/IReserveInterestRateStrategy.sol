// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IReserveInterestRateStrategy {
    function calculateInterestRates(
        address reserve,
        uint256 availableLiquidity,
        uint256 totalVariableDebt,
        uint256 reserveFactor,
        uint256 reserveDecimals
    ) external view returns (uint256 liquidityRate, uint256 stableBorrowRate, uint256 variableBorrowRate);
}
