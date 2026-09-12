// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { HookParams } from "../hook/libraries/HookParams.sol";

interface ITrancheHookParams {
    function setParams(HookParams.Params calldata newParams) external;

    function setBaseFee(uint24 baseFee) external;

    function setQuotingEnabled(bool enabled) external;
}
