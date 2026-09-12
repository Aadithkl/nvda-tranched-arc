// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { DataTypes } from "./libraries/DataTypes.sol";
import { ReserveConfiguration } from "./libraries/ReserveConfiguration.sol";
import { WadRayMath } from "./libraries/WadRayMath.sol";
import { IAaveV2Pool } from "./interfaces/IAaveV2Pool.sol";
import { IAToken } from "./interfaces/IAToken.sol";
import { IVariableDebtToken } from "./interfaces/IVariableDebtToken.sol";
import { ILendingPoolAddressesProvider } from "./interfaces/ILendingPoolAddressesProvider.sol";
import { IPriceOracleGetter } from "./interfaces/IPriceOracleGetter.sol";
import { IReserveInterestRateStrategy } from "./interfaces/IReserveInterestRateStrategy.sol";

contract LendingPool is IAaveV2Pool {
    using SafeERC20 for IERC20;
    using ReserveConfiguration for DataTypes.ReserveConfigurationMap;

    uint256 public constant MAX_UINT = type(uint256).max;
    uint256 public constant VARIABLE_RATE_MODE = 2;
    uint256 public constant BPS = 1e4;

    address public immutable ADDRESSES_PROVIDER;

    mapping(address => DataTypes.ReserveData) private _reserves;
    mapping(address => bool) private _reserveInitialized;
    address[] private _reservesList;
    uint8 private _nextReserveId;
    bool public paused;

    event ReserveInitialized(
        address indexed asset, address aToken, address variableDebtToken, address interestRateStrategy
    );
    event ReserveConfigurationChanged(
        address indexed asset, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus
    );
    event ReserveBorrowingSet(address indexed asset, bool enabled);
    event ReserveFactorChanged(address indexed asset, uint256 reserveFactor);
    event ReserveActiveSet(address indexed asset, bool active);
    event ReserveFrozenSet(address indexed asset, bool frozen);
    event ReserveInterestRateStrategyChanged(address indexed asset, address strategy);

    error NotConfigurator(address caller);
    error NotPoolAdmin(address caller);
    error IsPaused();
    error ReserveAlreadyInitialized(address asset);
    error ReserveNotInitialized(address asset);
    error ReserveInactive(address asset);
    error ReserveFrozen(address asset);
    error BorrowingDisabled(address asset);
    error InvalidRateMode(uint256 mode);
    error InvalidAmount();
    error InsufficientLiquidity();
    error BorrowCapacityExceeded(uint256 requested, uint256 available);
    error HealthFactorTooLow(uint256 healthFactor);
    error SelfBorrowOnly();
    error ZeroAddress();

    modifier onlyConfigurator() {
        if (msg.sender != ILendingPoolAddressesProvider(ADDRESSES_PROVIDER).getLendingPoolConfigurator()) {
            revert NotConfigurator(msg.sender);
        }
        _;
    }

    modifier onlyPoolAdmin() {
        if (msg.sender != ILendingPoolAddressesProvider(ADDRESSES_PROVIDER).getPoolAdmin()) {
            revert NotPoolAdmin(msg.sender);
        }
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert IsPaused();
        _;
    }

    constructor(address addressesProvider_) {
        if (addressesProvider_ == address(0)) revert ZeroAddress();
        ADDRESSES_PROVIDER = addressesProvider_;
    }

    function getReservesList() external view returns (address[] memory) {
        return _reservesList;
    }

    function getReserveData(address asset) external view returns (DataTypes.ReserveData memory) {
        if (!_reserveInitialized[asset]) revert ReserveNotInitialized(asset);
        return _reserves[asset];
    }

    function getReserveNormalizedIncome(address asset) external view returns (uint256) {
        if (!_reserveInitialized[asset]) revert ReserveNotInitialized(asset);
        return _reserves[asset].liquidityIndex;
    }

    function getReserveNormalizedVariableDebt(address asset) external view returns (uint256) {
        if (!_reserveInitialized[asset]) revert ReserveNotInitialized(asset);
        return _reserves[asset].variableBorrowIndex;
    }

    function updateState(address asset) external {
        _updateState(asset);
    }

    function initReserve(
        address asset,
        address aToken,
        address variableDebtToken,
        address interestRateStrategy,
        uint8 decimals
    ) external onlyConfigurator {
        if (_reserveInitialized[asset]) revert ReserveAlreadyInitialized(asset);
        if (aToken == address(0) || variableDebtToken == address(0) || interestRateStrategy == address(0)) {
            revert ZeroAddress();
        }

        DataTypes.ReserveData storage reserve = _reserves[asset];
        reserve.liquidityIndex = uint128(WadRayMath.RAY);
        reserve.variableBorrowIndex = uint128(WadRayMath.RAY);
        reserve.lastUpdateTimestamp = uint40(block.timestamp);
        reserve.aTokenAddress = aToken;
        reserve.variableDebtTokenAddress = variableDebtToken;
        reserve.interestRateStrategyAddress = interestRateStrategy;
        reserve.id = _nextReserveId;

        DataTypes.ReserveConfigurationMap memory config;
        config.data = reserve.configuration;
        config.setDecimals(decimals);
        config.setActive(true);
        reserve.configuration = config.data;

        _reserveInitialized[asset] = true;
        _reservesList.push(asset);
        unchecked {
            ++_nextReserveId;
        }

        emit ReserveInitialized(asset, aToken, variableDebtToken, interestRateStrategy);
    }

    function setReserveConfiguration(address asset, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus)
        external
        onlyConfigurator
    {
        DataTypes.ReserveData storage reserve = _reserves[asset];
        if (!_reserveInitialized[asset]) revert ReserveNotInitialized(asset);
        DataTypes.ReserveConfigurationMap memory config;
        config.data = reserve.configuration;
        config.setLtv(ltv);
        config.setLiquidationThreshold(liquidationThreshold);
        config.setLiquidationBonus(liquidationBonus);
        reserve.configuration = config.data;
        emit ReserveConfigurationChanged(asset, ltv, liquidationThreshold, liquidationBonus);
    }

    function setReserveBorrowing(address asset, bool enabled) external onlyConfigurator {
        _requireInitialized(asset);
        DataTypes.ReserveData storage reserve = _reserves[asset];
        DataTypes.ReserveConfigurationMap memory config;
        config.data = reserve.configuration;
        config.setBorrowingEnabled(enabled);
        reserve.configuration = config.data;
        emit ReserveBorrowingSet(asset, enabled);
    }

    function setReserveFactor(address asset, uint256 reserveFactor) external onlyConfigurator {
        _requireInitialized(asset);
        DataTypes.ReserveData storage reserve = _reserves[asset];
        DataTypes.ReserveConfigurationMap memory config;
        config.data = reserve.configuration;
        config.setReserveFactor(reserveFactor);
        reserve.configuration = config.data;
        emit ReserveFactorChanged(asset, reserveFactor);
    }

    function setReserveActive(address asset, bool active) external onlyConfigurator {
        _requireInitialized(asset);
        DataTypes.ReserveData storage reserve = _reserves[asset];
        DataTypes.ReserveConfigurationMap memory config;
        config.data = reserve.configuration;
        config.setActive(active);
        reserve.configuration = config.data;
        emit ReserveActiveSet(asset, active);
    }

    function setReserveFreeze(address asset, bool frozen) external onlyConfigurator {
        _requireInitialized(asset);
        DataTypes.ReserveData storage reserve = _reserves[asset];
        DataTypes.ReserveConfigurationMap memory config;
        config.data = reserve.configuration;
        config.setFrozen(frozen);
        reserve.configuration = config.data;
        emit ReserveFrozenSet(asset, frozen);
    }

    function setReserveInterestRateStrategyAddress(address asset, address strategy) external onlyConfigurator {
        _requireInitialized(asset);
        if (strategy == address(0)) revert ZeroAddress();
        _reserves[asset].interestRateStrategyAddress = strategy;
        emit ReserveInterestRateStrategyChanged(asset, strategy);
    }

    function setPaused(bool paused_) external onlyPoolAdmin {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function deposit(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external whenNotPaused {
        if (amount == 0) revert InvalidAmount();
        _updateState(asset);
        DataTypes.ReserveData storage reserve = _reserves[asset];
        _requireActive(reserve, asset, true);

        IERC20(asset).safeTransferFrom(msg.sender, reserve.aTokenAddress, amount);
        IAToken(reserve.aTokenAddress).mint(onBehalfOf, amount);

        emit Deposit(asset, msg.sender, onBehalfOf, amount, referralCode);
    }

    function withdraw(address asset, uint256 amount, address to) external whenNotPaused returns (uint256) {
        _updateState(asset);
        DataTypes.ReserveData storage reserve = _reserves[asset];
        _requireActive(reserve, asset, false);

        IAToken aToken = IAToken(reserve.aTokenAddress);
        uint256 userBalance = aToken.balanceOf(msg.sender);
        uint256 amountToWithdraw = amount == MAX_UINT ? userBalance : amount;
        if (amountToWithdraw == 0 || amountToWithdraw > userBalance) revert InvalidAmount();

        uint256 availableLiquidity = IERC20(asset).balanceOf(reserve.aTokenAddress);
        if (amountToWithdraw > availableLiquidity) revert InsufficientLiquidity();

        aToken.burn(msg.sender, amountToWithdraw);
        aToken.transferUnderlyingTo(to, amountToWithdraw);

        emit Withdraw(asset, msg.sender, to, amountToWithdraw);
        return amountToWithdraw;
    }

    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)
        external
        whenNotPaused
    {
        if (interestRateMode != VARIABLE_RATE_MODE) revert InvalidRateMode(interestRateMode);
        if (onBehalfOf != msg.sender) revert SelfBorrowOnly();
        if (amount == 0) revert InvalidAmount();

        _updateState(asset);
        DataTypes.ReserveData storage reserve = _reserves[asset];
        _requireActive(reserve, asset, true);

        DataTypes.ReserveConfigurationMap memory config;
        config.data = reserve.configuration;
        if (!config.getBorrowingEnabled()) revert BorrowingDisabled(asset);
        if (config.getLtv() == 0) revert BorrowingDisabled(asset);

        uint256 availableLiquidity = IERC20(asset).balanceOf(reserve.aTokenAddress);
        if (amount > availableLiquidity) revert InsufficientLiquidity();

        (uint256 collateralBase, uint256 debtBase,,, uint256 ltv,) = getUserAccountData(onBehalfOf);
        uint256 borrowCapacity = (collateralBase * ltv) / BPS;
        uint256 availableBorrows = borrowCapacity > debtBase ? borrowCapacity - debtBase : 0;
        if (amount > availableBorrows) revert BorrowCapacityExceeded(amount, availableBorrows);

        IVariableDebtToken(reserve.variableDebtTokenAddress).mint(onBehalfOf, amount);
        IAToken(reserve.aTokenAddress).transferUnderlyingTo(msg.sender, amount);

        (,,,,, uint256 healthFactor) = getUserAccountData(onBehalfOf);
        if (healthFactor < 1e18) revert HealthFactorTooLow(healthFactor);

        emit Borrow(
            asset, msg.sender, onBehalfOf, amount, interestRateMode, reserve.currentVariableBorrowRate, referralCode
        );
    }

    function repay(address asset, uint256 amount, uint256 rateMode, address onBehalfOf) external returns (uint256) {
        if (rateMode != VARIABLE_RATE_MODE) revert InvalidRateMode(rateMode);
        _updateState(asset);
        DataTypes.ReserveData storage reserve = _reserves[asset];
        _requireInitialized(asset);

        IVariableDebtToken debtToken = IVariableDebtToken(reserve.variableDebtTokenAddress);
        uint256 debtBalance = debtToken.balanceOf(onBehalfOf);
        uint256 repayAmount = amount == MAX_UINT ? debtBalance : amount;
        if (repayAmount > debtBalance) repayAmount = debtBalance;
        if (repayAmount == 0) return 0;

        IERC20(asset).safeTransferFrom(msg.sender, reserve.aTokenAddress, repayAmount);
        debtToken.burn(onBehalfOf, repayAmount);

        emit Repay(asset, onBehalfOf, msg.sender, repayAmount);
        return repayAmount;
    }

    function getUserAccountData(address user)
        public
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        )
    {
        address priceOracle = ILendingPoolAddressesProvider(ADDRESSES_PROVIDER).getPriceOracle();
        uint256 weightedLtv;
        uint256 weightedLiquidationThreshold;

        address[] memory reserves = _reservesList;
        for (uint256 i; i < reserves.length; ++i) {
            DataTypes.ReserveData storage reserve = _reserves[reserves[i]];
            DataTypes.ReserveConfigurationMap memory config;
            config.data = reserve.configuration;
            uint256 price = IPriceOracleGetter(priceOracle).getAssetPrice(reserves[i]);
            uint256 assetUnit = 10 ** config.getDecimals();

            uint256 userBalance = IAToken(reserve.aTokenAddress).balanceOf(user);
            if (userBalance != 0) {
                uint256 value = (userBalance * price) / assetUnit;
                totalCollateralBase += value;
                weightedLtv += value * config.getLtv();
                weightedLiquidationThreshold += value * config.getLiquidationThreshold();
            }

            uint256 debt = IVariableDebtToken(reserve.variableDebtTokenAddress).balanceOf(user);
            if (debt != 0) {
                totalDebtBase += (debt * price) / assetUnit;
            }
        }

        if (totalCollateralBase != 0) {
            ltv = weightedLtv / totalCollateralBase;
            currentLiquidationThreshold = weightedLiquidationThreshold / totalCollateralBase;
        }

        uint256 borrowPower = (totalCollateralBase * ltv) / BPS;
        availableBorrowsBase = borrowPower > totalDebtBase ? borrowPower - totalDebtBase : 0;

        healthFactor = totalDebtBase == 0
            ? type(uint256).max
            : ((totalCollateralBase * currentLiquidationThreshold) / BPS) * 1e18 / totalDebtBase;
    }

    function _updateState(address asset) internal {
        if (!_reserveInitialized[asset]) revert ReserveNotInitialized(asset);

        DataTypes.ReserveData storage reserve = _reserves[asset];
        uint256 elapsed = block.timestamp - reserve.lastUpdateTimestamp;
        if (elapsed == 0) return;

        DataTypes.ReserveConfigurationMap memory config;
        config.data = reserve.configuration;

        uint256 totalVariableDebt = IVariableDebtToken(reserve.variableDebtTokenAddress).totalSupply();
        uint256 availableLiquidity = IERC20(asset).balanceOf(reserve.aTokenAddress);

        (uint256 liquidityRate,, uint256 variableBorrowRate) = IReserveInterestRateStrategy(
                reserve.interestRateStrategyAddress
            )
            .calculateInterestRates(
                asset, availableLiquidity, totalVariableDebt, config.getReserveFactor(), config.getDecimals()
            );

        reserve.liquidityIndex = uint128(
            WadRayMath.rayMul(reserve.liquidityIndex, WadRayMath.calculateLinearInterest(liquidityRate, elapsed))
        );
        reserve.variableBorrowIndex = uint128(
            WadRayMath.rayMul(
                reserve.variableBorrowIndex, WadRayMath.calculateLinearInterest(variableBorrowRate, elapsed)
            )
        );
        reserve.currentLiquidityRate = uint128(liquidityRate);
        reserve.currentVariableBorrowRate = uint128(variableBorrowRate);
        reserve.lastUpdateTimestamp = uint40(block.timestamp);

        emit ReserveDataUpdated(
            asset, liquidityRate, 0, variableBorrowRate, reserve.liquidityIndex, reserve.variableBorrowIndex
        );
    }

    function _requireInitialized(address asset) internal view {
        if (!_reserveInitialized[asset]) revert ReserveNotInitialized(asset);
    }

    function _requireActive(DataTypes.ReserveData storage reserve, address asset, bool blocksWhenFrozen) internal view {
        DataTypes.ReserveConfigurationMap memory config;
        config.data = reserve.configuration;
        if (!config.getActive()) revert ReserveInactive(asset);
        if (blocksWhenFrozen && config.getFrozen()) revert ReserveFrozen(asset);
    }
}
