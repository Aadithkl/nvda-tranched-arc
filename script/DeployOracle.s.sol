// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Script, console2 } from "forge-std/Script.sol";
import { NVDAPriceOracle } from "../src/oracle/NVDAPriceOracle.sol";

contract DeployOracle is Script {
    bytes32 internal constant REGULAR_FEED = 0x000b1d444945231e44dd47736c6abe288b10cb1b53941c7c68012fbdd2b1755c;
    bytes32 internal constant EXTENDED_FEED = 0x000bf689e4aa5c006c89c207eb155ae99184e433a518753eb745cc552391a743;
    bytes32 internal constant OVERNIGHT_FEED = 0x000b99b86a91cc317e2db8370f1466844dd9460cb51c3bf12fcc8d19d53d97bb;

    address internal constant ARC_TESTNET_VERIFIER = 0x72790f9eB82db492a7DDb6d2af22A270Dcc3Db64;

    function run() external {
        address verifier = vm.envOr("CHAINLINK_VERIFIER", ARC_TESTNET_VERIFIER);
        address oracleOwner = vm.envOr("ORACLE_OWNER", vm.envAddress("DEPLOYER_ADDRESS"));
        address x402Writer = vm.envOr("X402_WRITER", address(0));
        uint32 maxStaleness = uint32(vm.envOr("ORACLE_MAX_STALENESS", uint256(300)));
        uint32 x402MaxStaleness = uint32(vm.envOr("X402_MAX_STALENESS", uint256(300)));
        NVDAPriceOracle.Source primarySource = NVDAPriceOracle.Source(vm.envOr("PRIMARY_SOURCE", uint256(1)));

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        NVDAPriceOracle oracle = new NVDAPriceOracle(verifier, 8, oracleOwner);
        oracle.configureFeed(REGULAR_FEED, NVDAPriceOracle.Session.Regular, maxStaleness);
        oracle.configureFeed(EXTENDED_FEED, NVDAPriceOracle.Session.Extended, maxStaleness);
        oracle.configureFeed(OVERNIGHT_FEED, NVDAPriceOracle.Session.Overnight, maxStaleness);
        oracle.setX402MaxStaleness(x402MaxStaleness);
        oracle.setPrimarySource(primarySource);
        if (x402Writer != address(0)) {
            oracle.setWriter(x402Writer, true);
        }
        vm.stopBroadcast();

        console2.log("NVDAPriceOracle:", address(oracle));
        console2.log("verifier:", verifier);
        console2.log("owner:", oracleOwner);
        console2.log("x402Writer:", x402Writer);
        console2.log("primarySource:", uint256(primarySource));
    }
}
