// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { WadRayMath } from "./libraries/WadRayMath.sol";
import { IReserveInterestRateStrategy } from "./interfaces/IReserveInterestRateStrategy.sol";

contract DefaultReserveInterestRateStrategy is IReserveInterestRateStrategy {
    uint256 public constant OPTIMAL_UTILIZATION_DENOMINATOR = 1e4;
    uint256 public constant RESERVE_FACTOR_DENOMINATOR = 1e4;

    uint256 public immutable baseVariableBorrowRate;
    uint256 public immutable variableRateSlope1;
    uint256 public immutable variableRateSlope2;
    uint256 public immutable optimalUtilization;

    constructor(
        uint256 baseVariableBorrowRate_,
        uint256 variableRateSlope1_,
        uint256 variableRateSlope2_,
        uint256 optimalUtilization_
    ) {
        baseVariableBorrowRate = baseVariableBorrowRate_;
        variableRateSlope1 = variableRateSlope1_;
        variableRateSlope2 = variableRateSlope2_;
        optimalUtilization = optimalUtilization_;
    }

    function calculateInterestRates(
        address,
        uint256 availableLiquidity,
        uint256 totalVariableDebt,
        uint256 reserveFactor,
        uint256
    ) external view returns (uint256 liquidityRate, uint256 stableBorrowRate, uint256 variableBorrowRate) {
        uint256 totalLiquidity = availableLiquidity + totalVariableDebt;
        uint256 utilization = totalLiquidity == 0 ? 0 : WadRayMath.rayDiv(totalVariableDebt, totalLiquidity);

        if (utilization > optimalUtilization) {
            uint256 excess = utilization - optimalUtilization;
            variableBorrowRate = baseVariableBorrowRate + variableRateSlope1
                + WadRayMath.rayDiv(WadRayMath.rayMul(variableRateSlope2, excess), WadRayMath.RAY - optimalUtilization);
        } else {
            variableBorrowRate = baseVariableBorrowRate
                + WadRayMath.rayDiv(WadRayMath.rayMul(variableRateSlope1, utilization), optimalUtilization);
        }

        uint256 rateToPool = WadRayMath.rayMul(
            variableBorrowRate,
            WadRayMath.rayDiv(RESERVE_FACTOR_DENOMINATOR - reserveFactor, RESERVE_FACTOR_DENOMINATOR)
        );
        liquidityRate = WadRayMath.rayMul(utilization, rateToPool);
        stableBorrowRate = 0;
    }
}
