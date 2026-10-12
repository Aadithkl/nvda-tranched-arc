// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { PoolKey } from "v4-core/src/types/PoolKey.sol";
import { PoolId } from "v4-core/src/types/PoolId.sol";
import { GuardParams } from "../hook/libraries/GuardParams.sol";

/// @notice The book surface the vault, the 7575 entry and readiness use. Implemented by
///         `PoolGuardHook` (single-book deployments) and `DualBookHub` (dual-book: forwards
///         to the active book, aggregates idle/claims over both). Both implementations share
///         these selectors, so wiring works through either without branching.
interface IBookHook {
    function setDeployEnabled(bool enabled) external;
    function recenterGuard() external;
    function deployGuard() external;
    function rearm() external;
    function recallToVault() external;
    function withdrawInventory(uint256 quoteAmount, uint256 equityAmount) external;
    function unwindClaims() external;
    function pullAll() external;
    function initializeBook(PoolKey calldata key, uint160 sqrtPriceX96) external returns (int24 tick);
    function setGuardParams(GuardParams.Params calldata params) external;
    /// @notice Accepts pending hook ownership (deploy-time wiring; use once).
    function acceptHookOwnership() external;
    function poolInitialized() external view returns (bool);
    function exited() external view returns (bool);
    function guardPresent() external view returns (bool);
    function basePosition() external view returns (int24 tickLower, int24 tickUpper, uint128 liquidity);
    function guardPosition() external view returns (int24 tickLower, int24 tickUpper, uint128 liquidity);
    function activePoolId() external view returns (PoolId);
    /// @notice Idle quote inventory (hook-held, undeployed).
    function quoteIdle() external view returns (uint256);
    /// @notice Idle equity inventory (hook-held, undeployed).
    function equityIdle() external view returns (uint256);
    /// @notice Redeemable pool-manager claims for a token (ERC-6909 balances).
    function claims(address token) external view returns (uint256);
}
