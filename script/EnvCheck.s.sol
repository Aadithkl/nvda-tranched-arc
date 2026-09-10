// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

contract EnvCheck is Script {
    function run() external view {
        console2.log("ARC_RPC_URL:", vm.envOr("ARC_RPC_URL", string("MISSING")));
        console2.log("DEPLOYER_ADDRESS:", vm.envOr("DEPLOYER_ADDRESS", string("MISSING")));
        console2.log("X402_STOCK_URL:", vm.envOr("X402_STOCK_URL", string("MISSING")));
        console2.log("X402_WRITER:", vm.envOr("X402_WRITER", string("MISSING")));
        console2.log("ORACLE_ADDRESS:", vm.envOr("ORACLE_ADDRESS", string("MISSING")));
        console2.log("GATEWAY_DOMAIN:", vm.envOr("GATEWAY_DOMAIN", string("MISSING")));
        console2.log("GRAPH_URL:", vm.envOr("GRAPH_URL", string("MISSING")));
    }
}
