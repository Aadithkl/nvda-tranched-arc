// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { HookParams } from "../hook/libraries/HookParams.sol";

interface IStrategyController {
    function setHookParams(HookParams.Params calldata newParams) external;

    function setBaseFee(uint24 baseFee) external;

    function setQuotingEnabled(bool enabled) external;

    function submitRebalance(bool equityOut, uint256 amountIn, uint256 minOut, uint256 deadline) external;
}
