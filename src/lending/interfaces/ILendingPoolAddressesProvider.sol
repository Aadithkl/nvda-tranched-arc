// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface ILendingPoolAddressesProvider {
    function getAddress(bytes32 id) external view returns (address);

    function getPoolAdmin() external view returns (address);

    function getLendingPool() external view returns (address);

    function getLendingPoolConfigurator() external view returns (address);

    function getPriceOracle() external view returns (address);
}
