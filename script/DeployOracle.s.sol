// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Script, console2 } from "forge-std/Script.sol";
import { NVDAPriceOracle } from "../src/oracle/NVDAPriceOracle.sol";

contract DeployOracle is Script {
    function run() external {
        address oracleOwner = vm.envOr("ORACLE_OWNER", vm.envAddress("DEPLOYER_ADDRESS"));
        address writer = vm.envOr("ORACLE_WRITER", vm.envOr("AGENT_OPERATOR_ADDRESS", address(0)));
        uint32 maxStaleness = uint32(vm.envOr("X402_MAX_STALENESS", uint256(300)));

        // Only the authorized writer (the agent operator) can publish prices; everyone else
        // reverts NotWriter. The agent pushes fresh quotes automatically on load and each tick.
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        NVDAPriceOracle oracle = new NVDAPriceOracle(8, oracleOwner);
        oracle.setMaxStaleness(maxStaleness);
        if (writer != address(0)) {
            oracle.setWriter(writer, true);
        }
        vm.stopBroadcast();

        console2.log("NVDAPriceOracle:", address(oracle));
        console2.log("owner:", oracleOwner);
        console2.log("writer:", writer);
        console2.log("maxStaleness:", maxStaleness);
    }
}
