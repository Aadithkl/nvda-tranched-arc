// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IPoolManager } from "v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "v4-core/src/types/PoolKey.sol";
import { SwapParams } from "v4-core/src/types/PoolOperation.sol";

/// @notice External per-swap EV simulator used by `PoolGuardHook` (kept out of the hook to stay
///         inside EIP-170; the hook calls this contract and treats any failure as EV-unknown).
interface IPoolGuardSimulator {
    struct Input {
        int24 guardLo;
        int24 guardHi;
        uint128 guardLiquidity;
        /// @dev True when the guard position is already part of the pool's total liquidity.
        bool guardIncluded;
        int24 baseLo;
        int24 baseHi;
        uint128 baseLiquidity;
        address quote;
        uint8 quoteDecimals;
        address equity;
        uint8 equityDecimals;
        /// @dev Equity price in quote, scaled 1e18.
        uint256 mid1e18;
    }

    struct Result {
        bool ok;
        int256 ev;
        uint256 ourNotional;
    }

    function simulate(IPoolManager manager, PoolKey memory key, SwapParams memory params, Input memory input)
        external
        view
        returns (Result memory);
}
