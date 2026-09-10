// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { AutomationCompatibleInterface } from "./interfaces/AutomationCompatibleInterface.sol";
import { NVDAPriceOracle } from "./NVDAPriceOracle.sol";

contract PriceUpdater is AutomationCompatibleInterface {
    NVDAPriceOracle public immutable oracle;

    event ReportsSubmitted(uint256 count);

    error NoReports();

    constructor(address oracle_) {
        oracle = NVDAPriceOracle(oracle_);
    }

    function checkUpkeep(bytes calldata) external view override returns (bool upkeepNeeded, bytes memory performData) {
        NVDAPriceOracle.PriceData memory priceData = oracle.getPrice();
        upkeepNeeded = !priceData.valid;
        performData = "";
    }

    function performUpkeep(bytes calldata performData) external override {
        bytes[] memory reports = abi.decode(performData, (bytes[]));
        uint256 length = reports.length;
        if (length == 0) revert NoReports();
        for (uint256 i; i < length; ++i) {
            oracle.verifyAndUpdate(reports[i]);
        }
        emit ReportsSubmitted(length);
    }
}
