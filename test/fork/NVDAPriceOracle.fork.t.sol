// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { IVerifierProxy } from "../../src/oracle/interfaces/IVerifierProxy.sol";
import { DataStreamsV11 } from "../../src/oracle/libraries/DataStreamsV11.sol";

contract NVDAPriceOracleForkTest is Test {
    address internal constant ARC_VERIFIER = 0x72790f9eB82db492a7DDb6d2af22A270Dcc3Db64;

    bytes32 internal constant REGULAR_FEED = 0x000b1d444945231e44dd47736c6abe288b10cb1b53941c7c68012fbdd2b1755c;
    bytes32 internal constant EXTENDED_FEED = 0x000bf689e4aa5c006c89c207eb155ae99184e433a518753eb745cc552391a743;
    bytes32 internal constant OVERNIGHT_FEED = 0x000b99b86a91cc317e2db8370f1466844dd9460cb51c3bf12fcc8d19d53d97bb;

    function setUp() public {
        string memory rpc = vm.envOr("ARC_RPC_URL", string("https://rpc.testnet.arc.io"));
        vm.createSelectFork(rpc);
    }

    function _fixture(string memory name) internal view returns (bytes memory) {
        string memory path = string.concat("test/fixtures/", name);
        if (!vm.exists(path)) return bytes("");
        string memory json = vm.readFile(path);
        return vm.parseJsonBytes(json, ".fullReport");
    }

    function _verifyFixture(string memory name, bytes32 expectedFeedId) internal {
        bytes memory report = _fixture(name);
        if (report.length == 0) {
            vm.skip(true);
            return;
        }
        bytes memory verified = IVerifierProxy(ARC_VERIFIER).verify(report, "");
        DataStreamsV11.Report memory decoded = DataStreamsV11.decode(verified);
        assertEq(decoded.feedId, expectedFeedId);
        assertGt(decoded.mid, 0);
        assertLe(decoded.marketStatus, 5);
    }

    function test_verifyRealReport_regular() public {
        _verifyFixture("nvda-report-regular.json", REGULAR_FEED);
    }

    function test_verifyRealReport_extended() public {
        _verifyFixture("nvda-report-extended.json", EXTENDED_FEED);
    }

    function test_verifyRealReport_overnight() public {
        _verifyFixture("nvda-report-overnight.json", OVERNIGHT_FEED);
    }

    function test_tamperedReport_reverts() public {
        vm.expectRevert();
        IVerifierProxy(ARC_VERIFIER).verify(hex"deadbeef", "");
    }
}
