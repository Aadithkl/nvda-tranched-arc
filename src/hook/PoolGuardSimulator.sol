// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IPoolManager } from "v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "v4-core/src/types/PoolId.sol";
import { Currency } from "v4-core/src/types/Currency.sol";
import { SwapParams } from "v4-core/src/types/PoolOperation.sol";
import { TickMath } from "v4-core/src/libraries/TickMath.sol";
import { SwapMath } from "v4-core/src/libraries/SwapMath.sol";
import { LiquidityMath } from "v4-core/src/libraries/LiquidityMath.sol";
import { TickBitmap } from "v4-core/src/libraries/TickBitmap.sol";
import { BitMath } from "v4-core/src/libraries/BitMath.sol";
import { StateLibrary } from "v4-core/src/libraries/StateLibrary.sol";
import { IPoolGuardSimulator } from "../interfaces/IPoolGuardSimulator.sol";

/// @notice Walks an arriving swap with `SwapMath.computeSwapStep` across initialized ticks (view
///         reads only, MIT v4-core primitives), bounded to the hook's base+guard ranges, and
///         accumulates the oracle-valued edge attributable to the hook's liquidity:
///           ev = Σ (ourL / totalL) · (oracleValue(in) − oracleValue(out))
///         Positive = fees/price beat oracle fair value; negative = adverse selection. The walk is
///         step-capped; exhaustion returns `ok = false` so the hook can fail safe (pull).
contract PoolGuardSimulator is IPoolGuardSimulator {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint8 internal constant MAX_STEPS = 16;

    function simulate(IPoolManager manager, PoolKey memory key, SwapParams memory params, Input memory input)
        external
        view
        returns (Result memory result)
    {
        if (params.amountSpecified == 0) {
            result.ok = true;
            return result;
        }

        PoolId id = key.toId();
        (uint160 sqrtPrice, int24 tick,,) = manager.getSlot0(id);
        if (sqrtPrice == 0) return result;

        uint256 totalLiquidity = manager.getLiquidity(id);

        int24 spanLo = input.guardLo < input.baseLo ? input.guardLo : input.baseLo;
        int24 spanHi = input.guardHi > input.baseHi ? input.guardHi : input.baseHi;

        bool zeroForOne = params.zeroForOne;
        int256 remaining = params.amountSpecified;
        uint160 limit = params.sqrtPriceLimitX96;

        int256 ev;
        uint256 notional;
        int256 totalEv;
        uint256 totalNotional;
        uint8 steps;

        while (remaining != 0 && sqrtPrice != limit) {
            if (++steps > MAX_STEPS) return result;

            (int24 nextTick, bool initialized) = _nextInitializedTick(manager, id, tick, key.tickSpacing, zeroForOne);
            if (nextTick <= TickMath.MIN_TICK) nextTick = TickMath.MIN_TICK;
            if (nextTick >= TickMath.MAX_TICK) nextTick = TickMath.MAX_TICK;
            uint160 sqrtNext = TickMath.getSqrtPriceAtTick(nextTick);
            uint160 target = SwapMath.getSqrtPriceTarget(zeroForOne, sqrtNext, limit);

            bool guardActive = input.guardLo <= tick && tick < input.guardHi;
            bool baseActive = input.baseLo <= tick && tick < input.baseHi;
            uint256 ourL =
                (guardActive ? uint256(input.guardLiquidity) : 0) + (baseActive ? uint256(input.baseLiquidity) : 0);
            uint256 liquidity =
                totalLiquidity + ((guardActive && !input.guardIncluded) ? uint256(input.guardLiquidity) : 0);
            if (liquidity > type(uint128).max) return result;

            uint160 sqrtPriceStart = sqrtPrice;

            if (liquidity != 0) {
                (uint160 sqrtPriceNew, uint256 amountIn, uint256 amountOut, uint256 feeAmount) =
                    SwapMath.computeSwapStep(sqrtPrice, target, uint128(liquidity), remaining, key.fee);
                sqrtPrice = sqrtPriceNew;

                if (ourL != 0 && (amountIn != 0 || amountOut != 0)) {
                    uint256 grossIn = amountIn + feeAmount;
                    (address inAsset, address outAsset) = zeroForOne
                        ? (Currency.unwrap(key.currency0), Currency.unwrap(key.currency1))
                        : (Currency.unwrap(key.currency1), Currency.unwrap(key.currency0));
                    uint256 inValue = _value(grossIn, inAsset, input);
                    uint256 outValue = _value(amountOut, outAsset, input);
                    uint256 shareE18 = Math.mulDiv(ourL, 1e18, liquidity);
                    ev += (int256(inValue) - int256(outValue)) * int256(shareE18) / 1e18;
                    notional += Math.mulDiv(inValue, shareE18, 1e18);
                    // H1: unscaled totals — toxic flow is toxic even if our share is ~0.
                    totalEv += int256(inValue) - int256(outValue);
                    totalNotional += inValue;
                } else if (amountIn != 0 || amountOut != 0) {
                    // No hook liquidity on this step — still count the total edge so a
                    // whale-diluted step cannot hide adverse selection.
                    uint256 grossIn = amountIn + feeAmount;
                    (address inAsset, address outAsset) = zeroForOne
                        ? (Currency.unwrap(key.currency0), Currency.unwrap(key.currency1))
                        : (Currency.unwrap(key.currency1), Currency.unwrap(key.currency0));
                    uint256 inValue = _value(grossIn, inAsset, input);
                    uint256 outValue = _value(amountOut, outAsset, input);
                    totalEv += int256(inValue) - int256(outValue);
                    totalNotional += inValue;
                }

                if (params.amountSpecified > 0) {
                    remaining -= int256(amountOut);
                } else {
                    remaining += int256(amountIn + feeAmount);
                }
            } else {
                sqrtPrice = target;
            }

            if (sqrtPrice == sqrtNext) {
                if (initialized) {
                    (, int128 liquidityNet) = manager.getTickLiquidity(id, nextTick);
                    if (zeroForOne) liquidityNet = -liquidityNet;
                    totalLiquidity = uint256(LiquidityMath.addDelta(uint128(totalLiquidity), liquidityNet));
                }
                tick = zeroForOne ? nextTick - 1 : nextTick;
            } else if (sqrtPrice != sqrtPriceStart) {
                tick = TickMath.getTickAtSqrtPrice(sqrtPrice);
            }

            if (zeroForOne) {
                if (tick < spanLo) break;
            } else if (tick >= spanHi) {
                break;
            }
        }

        result.ok = true;
        result.ev = ev;
        result.ourNotional = notional;
        result.totalEv = totalEv;
        result.totalNotional = totalNotional;
    }

    function _value(uint256 amount, address asset, Input memory input) private pure returns (uint256) {
        if (asset == input.quote) return amount * (10 ** (18 - input.quoteDecimals));
        return Math.mulDiv(amount, input.mid1e18, 10 ** input.equityDecimals);
    }

    function _nextInitializedTick(IPoolManager manager, PoolId id, int24 tick, int24 tickSpacing, bool lte)
        private
        view
        returns (int24 next, bool initialized)
    {
        int24 compressed = TickBitmap.compress(tick, tickSpacing);
        if (lte) {
            (int16 wordPos, uint8 bitPos) = TickBitmap.position(compressed);
            uint256 word = manager.getTickBitmap(id, wordPos);
            uint256 mask = type(uint256).max >> (uint256(type(uint8).max) - bitPos);
            uint256 masked = word & mask;
            initialized = masked != 0;
            next = initialized
                ? (compressed - int24(uint24(bitPos - BitMath.mostSignificantBit(masked)))) * tickSpacing
                : (compressed - int24(uint24(bitPos))) * tickSpacing;
        } else {
            (int16 wordPos, uint8 bitPos) = TickBitmap.position(++compressed);
            uint256 word = manager.getTickBitmap(id, wordPos);
            uint256 mask = ~((1 << bitPos) - 1);
            uint256 masked = word & mask;
            initialized = masked != 0;
            next = initialized
                ? (compressed + int24(uint24(BitMath.leastSignificantBit(masked) - bitPos))) * tickSpacing
                : (compressed + int24(uint24(type(uint8).max - bitPos))) * tickSpacing;
        }
    }
}

