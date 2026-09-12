// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IHookSharePipe } from "../interfaces/IHookSharePipe.sol";
import { TrancheVault } from "./TrancheVault.sol";

contract SeniorVault is TrancheVault {
    constructor(IERC20 asset_, IERC20 usdc_, IHookSharePipe pipe_, address owner_, address accountant_)
        TrancheVault("Senior NVDA Tranche", "srNVDA", asset_, usdc_, pipe_, true, owner_, accountant_)
    { }
}
