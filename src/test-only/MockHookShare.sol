// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IHookShareToken } from "../interfaces/IHookShareToken.sol";
import { IHookSharePipe } from "../interfaces/IHookSharePipe.sol";

contract MockHookShare is ERC20, IHookShareToken, IHookSharePipe {
    using SafeERC20 for IERC20;

    uint256 internal constant SHARE_DECIMALS = 18;

    IERC20 public immutable usdc;
    address public immutable authority;
    uint256 public immutable scale;

    error SlippageExceeded(uint256 received, uint256 minOut);

    constructor(IERC20 usdc_, address authority_) ERC20("Mock Hook Share", "mHS") {
        usdc = usdc_;
        authority = authority_;
        scale = 10 ** (SHARE_DECIMALS - IERC20Metadata(address(usdc_)).decimals());
    }

    function vault(address asset_) external view returns (address) {
        return asset_ == address(usdc) ? authority : address(0);
    }

    function wrapUSDC(uint256 usdcAmount, address receiver) external returns (uint256 shares) {
        shares = usdcAmount * scale;
        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        _mint(receiver, shares);
    }

    function unwrapUSDC(uint256 shares, address receiver) external returns (uint256) {
        return unwrapUSDC(shares, receiver, 0);
    }

    function unwrapUSDC(uint256 shares, address receiver, uint256 minUsdcOut) public returns (uint256 usdcAmount) {
        usdcAmount = shares / scale;
        if (usdcAmount < minUsdcOut) revert SlippageExceeded(usdcAmount, minUsdcOut);
        _burn(msg.sender, shares);
        usdc.safeTransfer(receiver, usdcAmount);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}
