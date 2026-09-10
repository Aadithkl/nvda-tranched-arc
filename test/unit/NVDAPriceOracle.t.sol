// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { NVDAPriceOracle } from "../../src/oracle/NVDAPriceOracle.sol";
import { DataStreamsV11 } from "../../src/oracle/libraries/DataStreamsV11.sol";
import { MockVerifierProxy } from "../../src/test-only/MockVerifierProxy.sol";

contract NVDAPriceOracleTest is Test {
    MockVerifierProxy internal verifier;
    NVDAPriceOracle internal oracle;

    bytes32 internal constant REGULAR_FEED = 0x000b1d444945231e44dd47736c6abe288b10cb1b53941c7c68012fbdd2b1755c;
    bytes32 internal constant EXTENDED_FEED = 0x000bf689e4aa5c006c89c207eb155ae99184e433a518753eb745cc552391a743;
    bytes32 internal constant OVERNIGHT_FEED = 0x000b99b86a91cc317e2db8370f1466844dd9460cb51c3bf12fcc8d19d53d97bb;
    bytes32 internal constant UNKNOWN_FEED = bytes32(uint256(0xdead));

    uint32 internal constant STALENESS = 300;

    function setUp() public {
        verifier = new MockVerifierProxy();
        oracle = new NVDAPriceOracle(address(verifier), 8, address(this));
        oracle.configureFeed(REGULAR_FEED, NVDAPriceOracle.Session.Regular, STALENESS);
        oracle.configureFeed(EXTENDED_FEED, NVDAPriceOracle.Session.Extended, STALENESS);
        oracle.configureFeed(OVERNIGHT_FEED, NVDAPriceOracle.Session.Overnight, STALENESS);
    }

    function _push(bytes32 feedId, int192 mid, uint32 status) internal returns (DataStreamsV11.Report memory) {
        DataStreamsV11.Report memory report = DataStreamsV11.Report({
            feedId: feedId,
            validFromTimestamp: uint32(block.timestamp),
            observationsTimestamp: uint32(block.timestamp),
            nativeFee: 0,
            linkFee: 0,
            expiresAt: uint32(block.timestamp + 3600),
            mid: mid,
            lastSeenTimestampNs: 0,
            bid: mid - 1,
            bidVolume: 0,
            ask: mid + 1,
            askVolume: 0,
            lastTradedPrice: mid,
            marketStatus: status
        });
        verifier.setResponse(abi.encode(report));
        return oracle.verifyAndUpdate(hex"00");
    }

    function test_configDefaults() public view {
        assertEq(oracle.feedCount(), 3);
        assertEq(oracle.decimals(), 8);
        assertEq(oracle.owner(), address(this));
        assertEq(oracle.marketStatus(), 0);
    }

    function test_pushRegular_valid() public {
        DataStreamsV11.Report memory report = _push(REGULAR_FEED, 3000e8, 2);
        assertEq(report.feedId, REGULAR_FEED);

        NVDAPriceOracle.PriceData memory data = oracle.getPrice();
        assertTrue(data.valid);
        assertEq(uint8(data.session), uint8(NVDAPriceOracle.Session.Regular));
        assertEq(data.mid, 3000e8);
        assertEq(data.bid, 3000e8 - 1);
        assertEq(data.ask, 3000e8 + 1);
        assertEq(data.marketStatus, 2);
    }

    function test_pushExtendedDuringPreMarket_valid() public {
        _push(EXTENDED_FEED, 3001e8, 1);
        NVDAPriceOracle.PriceData memory data = oracle.getPrice();
        assertTrue(data.valid);
        assertEq(uint8(data.session), uint8(NVDAPriceOracle.Session.Extended));
    }

    function test_pushExtendedDuringPostMarket_valid() public {
        _push(EXTENDED_FEED, 3002e8, 3);
        NVDAPriceOracle.PriceData memory data = oracle.getPrice();
        assertTrue(data.valid);
        assertEq(uint8(data.session), uint8(NVDAPriceOracle.Session.Extended));
    }

    function test_pushOvernight_valid() public {
        _push(OVERNIGHT_FEED, 2999e8, 4);
        NVDAPriceOracle.PriceData memory data = oracle.getPrice();
        assertTrue(data.valid);
        assertEq(uint8(data.session), uint8(NVDAPriceOracle.Session.Overnight));
    }

    function test_rejectUnknownFeed() public {
        DataStreamsV11.Report memory report = DataStreamsV11.Report({
            feedId: UNKNOWN_FEED,
            validFromTimestamp: 0,
            observationsTimestamp: uint32(block.timestamp),
            nativeFee: 0,
            linkFee: 0,
            expiresAt: 0,
            mid: 1,
            lastSeenTimestampNs: 0,
            bid: 1,
            bidVolume: 0,
            ask: 1,
            askVolume: 0,
            lastTradedPrice: 1,
            marketStatus: 2
        });
        verifier.setResponse(abi.encode(report));
        vm.expectRevert(abi.encodeWithSelector(NVDAPriceOracle.UnknownFeed.selector, UNKNOWN_FEED));
        oracle.verifyAndUpdate(hex"00");
    }

    function test_rejectSessionMismatch() public {
        verifier.setResponse(abi.encode(_report(EXTENDED_FEED, 3000e8, 2)));
        vm.expectRevert(
            abi.encodeWithSelector(
                NVDAPriceOracle.SessionMismatch.selector, NVDAPriceOracle.Session.Extended, uint32(2)
            )
        );
        oracle.verifyAndUpdate(hex"00");
    }

    function test_rejectNonPositiveMid() public {
        verifier.setResponse(abi.encode(_report(REGULAR_FEED, 0, 2)));
        vm.expectRevert(abi.encodeWithSelector(NVDAPriceOracle.InvalidPrice.selector, int192(0)));
        oracle.verifyAndUpdate(hex"00");
    }

    function test_stalePriceInvalidates() public {
        _push(REGULAR_FEED, 3000e8, 2);
        assertTrue(oracle.getPrice().valid);

        skip(STALENESS + 1);

        NVDAPriceOracle.PriceData memory data = oracle.getPrice();
        assertFalse(data.valid);
        assertEq(data.mid, 3000e8);
    }

    function test_freshBoundaryStillValid() public {
        _push(REGULAR_FEED, 3000e8, 2);
        skip(STALENESS);
        assertTrue(oracle.getPrice().valid);
    }

    function test_closedStatusInvalidates() public {
        _push(REGULAR_FEED, 3000e8, 2);
        _push(REGULAR_FEED, 3000e8, 5);

        NVDAPriceOracle.PriceData memory data = oracle.getPrice();
        assertFalse(data.valid);
        assertEq(data.marketStatus, 5);
        assertEq(uint8(data.session), uint8(NVDAPriceOracle.Session.None));
    }

    function test_unknownStatusInvalidates() public {
        _push(OVERNIGHT_FEED, 3000e8, 4);
        _push(OVERNIGHT_FEED, 3000e8, 0);
        assertFalse(oracle.getPrice().valid);
    }

    function test_configureOnlyOwner() public {
        vm.prank(address(0xdead));
        vm.expectRevert(abi.encodeWithSelector(NVDAPriceOracle.NotOwner.selector, address(0xdead)));
        oracle.configureFeed(UNKNOWN_FEED, NVDAPriceOracle.Session.Regular, STALENESS);
    }

    function test_pauseBlocksUpdates() public {
        oracle.setPaused(true);
        verifier.setResponse(abi.encode(_report(REGULAR_FEED, 3000e8, 2)));
        vm.expectRevert(NVDAPriceOracle.IsPaused.selector);
        oracle.verifyAndUpdate(hex"00");
    }

    function test_pauseOnlyOwner() public {
        vm.prank(address(0xdead));
        vm.expectRevert(abi.encodeWithSelector(NVDAPriceOracle.NotOwner.selector, address(0xdead)));
        oracle.setPaused(true);
    }

    function test_latestRoundDataRevertsWithoutPrice() public {
        vm.expectRevert(abi.encodeWithSelector(NVDAPriceOracle.NoPriceData.selector, NVDAPriceOracle.Session.None));
        oracle.latestRoundData();
    }

    function test_latestRoundDataAfterUpdate() public {
        _push(REGULAR_FEED, 3000e8, 2);
        (, int256 answer,, uint256 updatedAt,) = oracle.latestRoundData();
        assertEq(answer, 3000e8);
        assertEq(updatedAt, block.timestamp);
    }

    function testFuzz_pushRegular_valid(uint192 mid) public {
        mid = uint192(bound(mid, 2, uint256(int256(type(int192).max)) - 1));
        _push(REGULAR_FEED, int192(mid), 2);
        NVDAPriceOracle.PriceData memory data = oracle.getPrice();
        assertTrue(data.valid);
        assertEq(data.mid, int192(mid));
    }

    function _report(bytes32 feedId, int192 mid, uint32 status) internal view returns (DataStreamsV11.Report memory) {
        return DataStreamsV11.Report({
            feedId: feedId,
            validFromTimestamp: uint32(block.timestamp),
            observationsTimestamp: uint32(block.timestamp),
            nativeFee: 0,
            linkFee: 0,
            expiresAt: uint32(block.timestamp + 3600),
            mid: mid,
            lastSeenTimestampNs: 0,
            bid: mid,
            bidVolume: 0,
            ask: mid,
            askVolume: 0,
            lastTradedPrice: mid,
            marketStatus: status
        });
    }
}
