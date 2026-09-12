// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { DataTypes } from "./DataTypes.sol";

library ReserveConfiguration {
    uint256 internal constant LTV_MASK = ~(uint256(0xFFFF) << 0);
    uint256 internal constant LIQUIDATION_THRESHOLD_MASK = ~(uint256(0xFFFF) << 16);
    uint256 internal constant LIQUIDATION_BONUS_MASK = ~(uint256(0xFFFF) << 32);
    uint256 internal constant DECIMALS_MASK = ~(uint256(0xFF) << 48);
    uint256 internal constant ACTIVE_MASK = ~(uint256(1) << 56);
    uint256 internal constant FROZEN_MASK = ~(uint256(1) << 57);
    uint256 internal constant BORROWING_MASK = ~(uint256(1) << 58);
    uint256 internal constant STABLE_BORROWING_MASK = ~(uint256(1) << 59);
    uint256 internal constant RESERVE_FACTOR_MASK = ~(uint256(0xFFFF) << 64);

    uint256 internal constant LTV_START_BIT = 0;
    uint256 internal constant LIQUIDATION_THRESHOLD_START_BIT = 16;
    uint256 internal constant LIQUIDATION_BONUS_START_BIT = 32;
    uint256 internal constant DECIMALS_START_BIT = 48;
    uint256 internal constant ACTIVE_START_BIT = 56;
    uint256 internal constant FROZEN_START_BIT = 57;
    uint256 internal constant BORROWING_START_BIT = 58;
    uint256 internal constant STABLE_BORROWING_START_BIT = 59;
    uint256 internal constant RESERVE_FACTOR_START_BIT = 64;

    uint256 internal constant MAX_VALID_LTV = 65_535;
    uint256 internal constant MAX_VALID_LIQUIDATION_THRESHOLD = 65_535;
    uint256 internal constant MAX_VALID_LIQUIDATION_BONUS = 65_535;
    uint256 internal constant MAX_VALID_DECIMALS = 255;
    uint256 internal constant MAX_VALID_RESERVE_FACTOR = 65_535;

    function setLtv(DataTypes.ReserveConfigurationMap memory self, uint256 ltv) internal pure {
        require(ltv <= MAX_VALID_LTV, "Invalid LTV");
        self.data = (self.data & LTV_MASK) | ltv;
    }

    function getLtv(DataTypes.ReserveConfigurationMap memory self) internal pure returns (uint256) {
        return self.data & ~LTV_MASK;
    }

    function setLiquidationThreshold(DataTypes.ReserveConfigurationMap memory self, uint256 threshold) internal pure {
        require(threshold <= MAX_VALID_LIQUIDATION_THRESHOLD, "Invalid liquidation threshold");
        self.data = (self.data & LIQUIDATION_THRESHOLD_MASK) | (threshold << LIQUIDATION_THRESHOLD_START_BIT);
    }

    function getLiquidationThreshold(DataTypes.ReserveConfigurationMap memory self) internal pure returns (uint256) {
        return (self.data & ~LIQUIDATION_THRESHOLD_MASK) >> LIQUIDATION_THRESHOLD_START_BIT;
    }

    function setLiquidationBonus(DataTypes.ReserveConfigurationMap memory self, uint256 bonus) internal pure {
        require(bonus <= MAX_VALID_LIQUIDATION_BONUS, "Invalid liquidation bonus");
        self.data = (self.data & LIQUIDATION_BONUS_MASK) | (bonus << LIQUIDATION_BONUS_START_BIT);
    }

    function getLiquidationBonus(DataTypes.ReserveConfigurationMap memory self) internal pure returns (uint256) {
        return (self.data & ~LIQUIDATION_BONUS_MASK) >> LIQUIDATION_BONUS_START_BIT;
    }

    function setDecimals(DataTypes.ReserveConfigurationMap memory self, uint256 decimals) internal pure {
        require(decimals <= MAX_VALID_DECIMALS, "Invalid decimals");
        self.data = (self.data & DECIMALS_MASK) | (decimals << DECIMALS_START_BIT);
    }

    function getDecimals(DataTypes.ReserveConfigurationMap memory self) internal pure returns (uint256) {
        return (self.data & ~DECIMALS_MASK) >> DECIMALS_START_BIT;
    }

    function setActive(DataTypes.ReserveConfigurationMap memory self, bool active) internal pure {
        self.data = (self.data & ACTIVE_MASK) | (uint256(active ? 1 : 0) << ACTIVE_START_BIT);
    }

    function getActive(DataTypes.ReserveConfigurationMap memory self) internal pure returns (bool) {
        return (self.data & ~ACTIVE_MASK) != 0;
    }

    function setFrozen(DataTypes.ReserveConfigurationMap memory self, bool frozen) internal pure {
        self.data = (self.data & FROZEN_MASK) | (uint256(frozen ? 1 : 0) << FROZEN_START_BIT);
    }

    function getFrozen(DataTypes.ReserveConfigurationMap memory self) internal pure returns (bool) {
        return (self.data & ~FROZEN_MASK) != 0;
    }

    function setBorrowingEnabled(DataTypes.ReserveConfigurationMap memory self, bool enabled) internal pure {
        self.data = (self.data & BORROWING_MASK) | (uint256(enabled ? 1 : 0) << BORROWING_START_BIT);
    }

    function getBorrowingEnabled(DataTypes.ReserveConfigurationMap memory self) internal pure returns (bool) {
        return (self.data & ~BORROWING_MASK) != 0;
    }

    function setStableRateBorrowingEnabled(DataTypes.ReserveConfigurationMap memory self, bool enabled) internal pure {
        self.data = (self.data & STABLE_BORROWING_MASK) | (uint256(enabled ? 1 : 0) << STABLE_BORROWING_START_BIT);
    }

    function getStableRateBorrowingEnabled(DataTypes.ReserveConfigurationMap memory self) internal pure returns (bool) {
        return (self.data & ~STABLE_BORROWING_MASK) != 0;
    }

    function setReserveFactor(DataTypes.ReserveConfigurationMap memory self, uint256 reserveFactor) internal pure {
        require(reserveFactor <= MAX_VALID_RESERVE_FACTOR, "Invalid reserve factor");
        self.data = (self.data & RESERVE_FACTOR_MASK) | (reserveFactor << RESERVE_FACTOR_START_BIT);
    }

    function getReserveFactor(DataTypes.ReserveConfigurationMap memory self) internal pure returns (uint256) {
        return (self.data & ~RESERVE_FACTOR_MASK) >> RESERVE_FACTOR_START_BIT;
    }
}
