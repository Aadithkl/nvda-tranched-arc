// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {NVDAPriceOracle} from "../src/oracle/NVDAPriceOracle.sol";

contract DeployOracle is Script {
    function run() external {
        address oracleOwner = vm.envOr("ORACLE_OWNER", vm.envAddress("DEPLOYER_ADDRESS"));
        address x402Writer = vm.envOr("X402_WRITER", oracleOwner);
        uint32 maxStaleness = uint32(vm.envOr("X402_MAX_STALENESS", uint256(300)));

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        NVDAPriceOracle oracle = new NVDAPriceOracle(8, oracleOwner);
        oracle.setMaxStaleness(maxStaleness);
        if (x402Writer != address(0)) {
            oracle.setWriter(x402Writer, true);
        }
        vm.stopBroadcast();

        console2.log("NVDAPriceOracle:", address(oracle));
        console2.log("owner:", oracleOwner);
        console2.log("x402Writer:", x402Writer);
        console2.log("maxStaleness:", maxStaleness);
    }
}
