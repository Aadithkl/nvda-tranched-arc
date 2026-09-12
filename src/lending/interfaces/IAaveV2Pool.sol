// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { DataTypes } from "../libraries/DataTypes.sol";

interface IAaveV2Pool {
    event Deposit(
        address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 referralCode
    );
    event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount);
    event Borrow(
        address indexed reserve,
        address user,
        address indexed onBehalfOf,
        uint256 amount,
        uint256 borrowRateMode,
        uint256 borrowRate,
        uint16 referralCode
    );
    event Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount);
    event ReserveDataUpdated(
        address indexed reserve,
        uint256 liquidityRate,
        uint256 stableBorrowRate,
        uint256 variableBorrowRate,
        uint256 liquidityIndex,
        uint256 variableBorrowIndex
    );
    event PausedSet(bool paused);

    function deposit(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;

    function withdraw(address asset, uint256 amount, address to) external returns (uint256);

    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)
        external;

    function repay(address asset, uint256 amount, uint256 rateMode, address onBehalfOf) external returns (uint256);

    function getReserveData(address asset) external view returns (DataTypes.ReserveData memory);

    function getReserveNormalizedIncome(address asset) external view returns (uint256);

    function getReserveNormalizedVariableDebt(address asset) external view returns (uint256);

    function getUserAccountData(address user)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );

    function updateState(address asset) external;

    function paused() external view returns (bool);
}
