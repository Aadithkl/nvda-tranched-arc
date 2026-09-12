// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { AToken } from "./AToken.sol";
import { VariableDebtToken } from "./VariableDebtToken.sol";
import { LendingPool } from "./LendingPool.sol";
import { ILendingPoolAddressesProvider } from "./interfaces/ILendingPoolAddressesProvider.sol";

contract LendingPoolConfigurator {
    uint256 public constant MAX_BPS = 1e4;

    ILendingPoolAddressesProvider public immutable addressesProvider;

    event ReserveInitialized(
        address indexed asset,
        address indexed aToken,
        address variableDebtToken,
        address interestRateStrategy,
        uint8 decimals
    );
    event CollateralConfigurationChanged(
        address indexed asset, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus
    );
    event BorrowingEnabledSet(address indexed asset, bool enabled);
    event ReserveFactorChanged(address indexed asset, uint256 reserveFactor);

    error NotPoolAdmin(address caller);
    error InvalidConfiguration();

    modifier onlyPoolAdmin() {
        if (msg.sender != addressesProvider.getPoolAdmin()) revert NotPoolAdmin(msg.sender);
        _;
    }

    constructor(address addressesProvider_) {
        addressesProvider = ILendingPoolAddressesProvider(addressesProvider_);
    }

    function _pool() internal view returns (LendingPool) {
        return LendingPool(addressesProvider.getLendingPool());
    }

    function initReserve(
        address asset,
        uint8 decimals,
        string calldata aTokenName,
        string calldata aTokenSymbol,
        address interestRateStrategy
    ) external onlyPoolAdmin returns (address aToken, address variableDebtToken) {
        address pool = addressesProvider.getLendingPool();
        aToken = address(new AToken(pool, asset, aTokenName, aTokenSymbol, decimals));
        variableDebtToken = address(new VariableDebtToken(pool, asset));
        _pool().initReserve(asset, aToken, variableDebtToken, interestRateStrategy, decimals);
        emit ReserveInitialized(asset, aToken, variableDebtToken, interestRateStrategy, decimals);
    }

    function configureReserveAsCollateral(
        address asset,
        uint256 ltv,
        uint256 liquidationThreshold,
        uint256 liquidationBonus
    ) external onlyPoolAdmin {
        if (ltv > liquidationThreshold || liquidationThreshold > MAX_BPS || liquidationBonus < MAX_BPS) {
            revert InvalidConfiguration();
        }
        _pool().setReserveConfiguration(asset, ltv, liquidationThreshold, liquidationBonus);
        emit CollateralConfigurationChanged(asset, ltv, liquidationThreshold, liquidationBonus);
    }

    function enableBorrowingOnReserve(address asset, bool enabled) external onlyPoolAdmin {
        _pool().setReserveBorrowing(asset, enabled);
        emit BorrowingEnabledSet(asset, enabled);
    }

    function setReserveFactor(address asset, uint256 reserveFactor) external onlyPoolAdmin {
        if (reserveFactor > MAX_BPS) revert InvalidConfiguration();
        _pool().setReserveFactor(asset, reserveFactor);
        emit ReserveFactorChanged(asset, reserveFactor);
    }

    function setReserveActive(address asset, bool active) external onlyPoolAdmin {
        _pool().setReserveActive(asset, active);
    }

    function setReserveFreeze(address asset, bool frozen) external onlyPoolAdmin {
        _pool().setReserveFreeze(asset, frozen);
    }

    function setReserveInterestRateStrategyAddress(address asset, address strategy) external onlyPoolAdmin {
        _pool().setReserveInterestRateStrategyAddress(asset, strategy);
    }
}
