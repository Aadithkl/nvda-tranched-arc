// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IHookSharePipe } from "../interfaces/IHookSharePipe.sol";
import { TrancheVault } from "./TrancheVault.sol";

contract JuniorVault is TrancheVault {
    constructor(
        IERC20 asset_,
        IERC20 usdc_,
        IERC20 equity_,
        IHookSharePipe pipe_,
        address owner_,
        address accountant_,
        uint64 expiry_
    )
        TrancheVault(
            "Junior NVDA Tranche", "jrNVDA", asset_, usdc_, equity_, pipe_, false, owner_, accountant_, expiry_
        )
    { }
}
