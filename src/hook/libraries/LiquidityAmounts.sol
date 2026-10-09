// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Amounts-for-liquidity math for v4 positions. In-repo implementation derived from the
///         canonical constant formulas (v4-periphery's `LiquidityAmounts` is BUSL-1.1).
library LiquidityAmounts {
    uint256 internal constant Q96 = 0x1000000000000000000000000;

    function getAmount0ForLiquidity(uint160 sqrtPriceAX96, uint160 sqrtPriceBX96, uint128 liquidity)
        internal
        pure
        returns (uint256)
    {
        if (sqrtPriceAX96 > sqrtPriceBX96) (sqrtPriceAX96, sqrtPriceBX96) = (sqrtPriceBX96, sqrtPriceAX96);
        uint256 diff = uint256(sqrtPriceBX96) - uint256(sqrtPriceAX96);
        return Math.mulDiv(Math.mulDiv(uint256(liquidity), diff, uint256(sqrtPriceBX96)), Q96, uint256(sqrtPriceAX96));
    }

    function getAmount1ForLiquidity(uint160 sqrtPriceAX96, uint160 sqrtPriceBX96, uint128 liquidity)
        internal
        pure
        returns (uint256)
    {
        if (sqrtPriceAX96 > sqrtPriceBX96) (sqrtPriceAX96, sqrtPriceBX96) = (sqrtPriceBX96, sqrtPriceAX96);
        return Math.mulDiv(uint256(liquidity), uint256(sqrtPriceBX96) - uint256(sqrtPriceAX96), Q96);
    }

    function getAmountsForLiquidity(uint160 sqrtPriceX96, uint160 sqrtLowerX96, uint160 sqrtUpperX96, uint128 liquidity)
        internal
        pure
        returns (uint256 amount0, uint256 amount1)
    {
        if (sqrtLowerX96 > sqrtUpperX96) (sqrtLowerX96, sqrtUpperX96) = (sqrtUpperX96, sqrtLowerX96);
        if (sqrtPriceX96 <= sqrtLowerX96) {
            amount0 = getAmount0ForLiquidity(sqrtLowerX96, sqrtUpperX96, liquidity);
        } else if (sqrtPriceX96 < sqrtUpperX96) {
            amount0 = getAmount0ForLiquidity(sqrtPriceX96, sqrtUpperX96, liquidity);
            amount1 = getAmount1ForLiquidity(sqrtLowerX96, sqrtPriceX96, liquidity);
        } else {
            amount1 = getAmount1ForLiquidity(sqrtLowerX96, sqrtUpperX96, liquidity);
        }
    }
}
