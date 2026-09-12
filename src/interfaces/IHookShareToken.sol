// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IHookShareToken is IERC20 {
    function vault(address asset) external view returns (address);
}
