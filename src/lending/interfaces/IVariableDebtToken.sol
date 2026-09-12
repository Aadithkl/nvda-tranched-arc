// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IVariableDebtToken {
    function POOL() external view returns (address);

    function UNDERLYING_ASSET_ADDRESS() external view returns (address);

    function balanceOf(address user) external view returns (uint256);

    function scaledBalanceOf(address user) external view returns (uint256);

    function totalSupply() external view returns (uint256);

    function scaledTotalSupply() external view returns (uint256);

    function mint(address user, uint256 amount) external returns (bool);

    function burn(address user, uint256 amount) external returns (bool);
}
