// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IHookShareToken } from "../interfaces/IHookShareToken.sol";

contract HookShareToken is ERC20, IHookShareToken {
    address public immutable hook;
    address public immutable asset;

    error NotHook(address caller);
    error ZeroAddress();

    modifier onlyHook() {
        if (msg.sender != hook) revert NotHook(msg.sender);
        _;
    }

    constructor(address hook_, address asset_) ERC20("Tranche JIT Share", "tjSHARE") {
        if (hook_ == address(0) || asset_ == address(0)) revert ZeroAddress();
        hook = hook_;
        asset = asset_;
    }

    function vault(address asset_) external view returns (address) {
        return asset_ == asset ? hook : address(0);
    }

    function mint(address to, uint256 amount) external onlyHook {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyHook {
        _burn(from, amount);
    }
}
