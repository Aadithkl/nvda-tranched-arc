// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IPoolManager } from "v4-core/src/interfaces/IPoolManager.sol";
import { IUnlockCallback } from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import { PoolKey } from "v4-core/src/types/PoolKey.sol";
import { Currency } from "v4-core/src/types/Currency.sol";
import { BalanceDelta, BalanceDeltaLibrary } from "v4-core/src/types/BalanceDelta.sol";
import { TickMath } from "v4-core/src/libraries/TickMath.sol";
import { IERC20Minimal } from "v4-core/src/interfaces/external/IERC20Minimal.sol";

contract DemoRouter is IUnlockCallback {
    using BalanceDeltaLibrary for BalanceDelta;

    IPoolManager public immutable poolManager;

    uint8 internal constant ACTION_SWAP = 1;
    uint8 internal constant ACTION_MODIFY = 2;

    error NotPoolManager();
    error SlippageExceeded();
    error AmountExceeded(uint256 amount0, uint256 amount1);

    struct SwapData {
        address payer;
        PoolKey key;
        bool zeroForOne;
        int256 amountSpecified;
        uint256 minAmountOut;
        address recipient;
    }

    struct ModifyData {
        address payer;
        PoolKey key;
        int24 tickLower;
        int24 tickUpper;
        int256 liquidityDelta;
        uint256 amount0Max;
        uint256 amount1Max;
        address recipient;
    }

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
    }

    function initializePool(PoolKey calldata key, uint160 sqrtPriceX96) external returns (int24 tick) {
        return poolManager.initialize(key, sqrtPriceX96);
    }

    function swapExactIn(
        PoolKey calldata key,
        bool zeroForOne,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient
    ) external returns (BalanceDelta delta) {
        SwapData memory data = SwapData({
            payer: msg.sender,
            key: key,
            zeroForOne: zeroForOne,
            amountSpecified: -int256(amountIn),
            minAmountOut: minAmountOut,
            recipient: recipient
        });
        delta = abi.decode(poolManager.unlock(abi.encode(ACTION_SWAP, abi.encode(data))), (BalanceDelta));
    }

    function addLiquidity(
        PoolKey calldata key,
        int24 tickLower,
        int24 tickUpper,
        int256 liquidityDelta,
        uint256 amount0Max,
        uint256 amount1Max,
        address recipient
    ) external returns (BalanceDelta delta) {
        delta = _modifyLiquidity(key, tickLower, tickUpper, liquidityDelta, amount0Max, amount1Max, recipient);
    }

    function removeLiquidity(
        PoolKey calldata key,
        int24 tickLower,
        int24 tickUpper,
        int256 liquidityDelta,
        address recipient
    ) external returns (BalanceDelta delta) {
        delta = _modifyLiquidity(
            key, tickLower, tickUpper, liquidityDelta, type(uint256).max, type(uint256).max, recipient
        );
    }

    function _modifyLiquidity(
        PoolKey calldata key,
        int24 tickLower,
        int24 tickUpper,
        int256 liquidityDelta,
        uint256 amount0Max,
        uint256 amount1Max,
        address recipient
    ) internal returns (BalanceDelta delta) {
        ModifyData memory data = ModifyData({
            payer: msg.sender,
            key: key,
            tickLower: tickLower,
            tickUpper: tickUpper,
            liquidityDelta: liquidityDelta,
            amount0Max: amount0Max,
            amount1Max: amount1Max,
            recipient: recipient
        });
        delta = abi.decode(poolManager.unlock(abi.encode(ACTION_MODIFY, abi.encode(data))), (BalanceDelta));
    }

    function unlockCallback(bytes calldata rawData) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (uint8 action, bytes memory payload) = abi.decode(rawData, (uint8, bytes));
        if (action == ACTION_SWAP) return _swap(payload);
        return _modifyLiquidityCallback(payload);
    }

    function _swap(bytes memory payload) internal returns (bytes memory) {
        SwapData memory data = abi.decode(payload, (SwapData));
        BalanceDelta delta = poolManager.swap(
            data.key,
            IPoolManager.SwapParams({
                zeroForOne: data.zeroForOne,
                amountSpecified: data.amountSpecified,
                sqrtPriceLimitX96: data.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );

        int128 amount0 = delta.amount0();
        int128 amount1 = delta.amount1();

        (Currency currencyIn, Currency currencyOut) =
            data.zeroForOne ? (data.key.currency0, data.key.currency1) : (data.key.currency1, data.key.currency0);

        int128 deltaIn = data.zeroForOne ? amount0 : amount1;
        if (deltaIn < 0) {
            _settle(currencyIn, data.payer, uint256(uint128(-deltaIn)));
        }

        int128 deltaOut = data.zeroForOne ? amount1 : amount0;
        if (deltaOut > 0) {
            uint256 amountOut = uint256(uint128(deltaOut));
            if (amountOut < data.minAmountOut) revert SlippageExceeded();
            poolManager.take(currencyOut, data.recipient, amountOut);
        }

        return abi.encode(delta);
    }

    function _modifyLiquidityCallback(bytes memory payload) internal returns (bytes memory) {
        ModifyData memory data = abi.decode(payload, (ModifyData));
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            data.key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: data.tickLower,
                tickUpper: data.tickUpper,
                liquidityDelta: data.liquidityDelta,
                salt: bytes32(0)
            }),
            ""
        );

        int128 amount0 = delta.amount0();
        int128 amount1 = delta.amount1();

        if (amount0 < 0) {
            uint256 owed = uint256(uint128(-amount0));
            if (owed > data.amount0Max) revert AmountExceeded(owed, 0);
            _settle(data.key.currency0, data.payer, owed);
        } else if (amount0 > 0) {
            poolManager.take(data.key.currency0, data.recipient, uint256(uint128(amount0)));
        }

        if (amount1 < 0) {
            uint256 owed = uint256(uint128(-amount1));
            if (owed > data.amount1Max) revert AmountExceeded(0, owed);
            _settle(data.key.currency1, data.payer, owed);
        } else if (amount1 > 0) {
            poolManager.take(data.key.currency1, data.recipient, uint256(uint128(amount1)));
        }

        return abi.encode(delta);
    }

    function _settle(Currency currency, address payer, uint256 amount) internal {
        poolManager.sync(currency);
        IERC20Minimal(Currency.unwrap(currency)).transferFrom(payer, address(poolManager), amount);
        poolManager.settle();
    }
}
