// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { NVDAPriceOracle } from "../../src/oracle/NVDAPriceOracle.sol";
import { DataStreamsV11 } from "../../src/oracle/libraries/DataStreamsV11.sol";
import { MockVerifierProxy } from "../../src/test-only/MockVerifierProxy.sol";

contract NVDAPriceOracleX402Test is Test {
    MockVerifierProxy internal verifier;
    NVDAPriceOracle internal oracle;

    bytes32 internal constant REGULAR_FEED = 0x000b1d444945231e44dd47736c6abe288b10cb1b53941c7c68012fbdd2b1755c;
    bytes32 internal constant EXTENDED_FEED = 0x000bf689e4aa5c006c89c207eb155ae99184e433a518753eb745cc552391a743;
    bytes32 internal constant OVERNIGHT_FEED = 0x000b99b86a91cc317e2db8370f1466844dd9460cb51c3bf12fcc8d19d53d97bb;

    uint32 internal constant CHAINLINK_STALENESS = 1000;
    uint32 internal constant X402_STALENESS = 300;

    address internal constant WRITER = address(0xA11CE);
    address internal constant STRANGER = address(0xBAD);

    bytes32 internal constant PAYMENT_REF = keccak256("x402-payment-receipt");

    function setUp() public {
        verifier = new MockVerifierProxy();
        oracle = new NVDAPriceOracle(address(verifier), 8, address(this));
        oracle.configureFeed(REGULAR_FEED, NVDAPriceOracle.Session.Regular, CHAINLINK_STALENESS);
        oracle.configureFeed(EXTENDED_FEED, NVDAPriceOracle.Session.Extended, CHAINLINK_STALENESS);
        oracle.configureFeed(OVERNIGHT_FEED, NVDAPriceOracle.Session.Overnight, CHAINLINK_STALENESS);
        oracle.setWriter(WRITER, true);
        oracle.setX402MaxStaleness(X402_STALENESS);
    }

    function _pushChainlink(bytes32 feedId, int192 mid, uint32 status) internal {
        DataStreamsV11.Report memory report = DataStreamsV11.Report({
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
        verifier.setResponse(abi.encode(report));
        oracle.verifyAndUpdate(hex"00");
    }

    function _pushX402(int192 mid, uint32 status) internal {
        vm.prank(WRITER);
        oracle.updateX402Price(mid, status, uint32(block.timestamp), PAYMENT_REF);
    }

    function test_pushX402_valid() public {
        _pushX402(3000e8, 2);

        NVDAPriceOracle.PriceData memory data = oracle.getPriceFrom(NVDAPriceOracle.Source.X402);
        assertTrue(data.valid);
        assertEq(data.mid, 3000e8);
        assertEq(uint8(data.source), uint8(NVDAPriceOracle.Source.X402));
        assertEq(uint8(data.session), uint8(NVDAPriceOracle.Session.Regular));
        assertEq(data.marketStatus, 2);
        assertEq(oracle.marketStatus(), 2);
    }

    function test_pushX402_storesPaymentRef() public {
        _pushX402(3000e8, 2);
        NVDAPriceOracle.X402Point memory point = oracle.x402Point();
        assertEq(point.paymentRef, PAYMENT_REF);
        assertEq(point.mid, 3000e8);
    }

    function test_pushX402_onlyWriter() public {
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(NVDAPriceOracle.NotWriter.selector, STRANGER));
        oracle.updateX402Price(3000e8, 2, uint32(block.timestamp), PAYMENT_REF);
    }

    function test_pushX402_rejectsNonPositivePrice() public {
        vm.prank(WRITER);
        vm.expectRevert(abi.encodeWithSelector(NVDAPriceOracle.InvalidPrice.selector, int192(0)));
        oracle.updateX402Price(0, 2, uint32(block.timestamp), PAYMENT_REF);
    }

    function test_pushX402_rejectsInvalidStatus() public {
        vm.prank(WRITER);
        vm.expectRevert(abi.encodeWithSelector(NVDAPriceOracle.InvalidMarketStatus.selector, uint32(6)));
        oracle.updateX402Price(3000e8, 6, uint32(block.timestamp), PAYMENT_REF);
    }

    function test_pushX402_staleInvalidates() public {
        _pushX402(3000e8, 2);
        assertTrue(oracle.getPriceFrom(NVDAPriceOracle.Source.X402).valid);

        skip(X402_STALENESS + 1);

        assertFalse(oracle.getPriceFrom(NVDAPriceOracle.Source.X402).valid);
    }

    function test_pushX402_closedMarketInvalidates() public {
        _pushX402(3000e8, 5);
        NVDAPriceOracle.PriceData memory data = oracle.getPriceFrom(NVDAPriceOracle.Source.X402);
        assertFalse(data.valid);
        assertEq(uint8(data.session), uint8(NVDAPriceOracle.Session.None));
    }

    function test_primarySourceX402() public {
        oracle.setPrimarySource(NVDAPriceOracle.Source.X402);
        _pushX402(3000e8, 4);

        NVDAPriceOracle.PriceData memory data = oracle.getPrice();
        assertEq(uint8(data.source), uint8(NVDAPriceOracle.Source.X402));
        assertTrue(data.valid);
        assertEq(uint8(data.session), uint8(NVDAPriceOracle.Session.Overnight));
    }

    function test_fallbackToChainlinkWhenX402Stale() public {
        oracle.setPrimarySource(NVDAPriceOracle.Source.X402);
        _pushX402(3000e8, 2);
        _pushChainlink(REGULAR_FEED, 3100e8, 2);

        skip(X402_STALENESS + 1);

        NVDAPriceOracle.PriceData memory data = oracle.getPrice();
        assertEq(uint8(data.source), uint8(NVDAPriceOracle.Source.ChainlinkStreams));
        assertTrue(data.valid);
        assertEq(data.mid, 3100e8);
    }

    function test_fallbackToX402WhenChainlinkStale() public {
        oracle.setX402MaxStaleness(CHAINLINK_STALENESS * 2);
        _pushChainlink(REGULAR_FEED, 3100e8, 2);
        _pushX402(3000e8, 2);

        skip(CHAINLINK_STALENESS + 1);

        NVDAPriceOracle.PriceData memory data = oracle.getPrice();
        assertEq(uint8(data.source), uint8(NVDAPriceOracle.Source.X402));
        assertTrue(data.valid);
        assertEq(data.mid, 3000e8);
    }

    function test_setPrimarySource_rejectsNone() public {
        vm.expectRevert(NVDAPriceOracle.InvalidSource.selector);
        oracle.setPrimarySource(NVDAPriceOracle.Source.None);
    }

    function test_setPrimarySource_onlyOwner() public {
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(NVDAPriceOracle.NotOwner.selector, STRANGER));
        oracle.setPrimarySource(NVDAPriceOracle.Source.X402);
    }

    function test_setWriter_onlyOwner() public {
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(NVDAPriceOracle.NotOwner.selector, STRANGER));
        oracle.setWriter(STRANGER, true);
    }

    function test_setWriter_revokes() public {
        oracle.setWriter(WRITER, false);
        vm.prank(WRITER);
        vm.expectRevert(abi.encodeWithSelector(NVDAPriceOracle.NotWriter.selector, WRITER));
        oracle.updateX402Price(3000e8, 2, uint32(block.timestamp), PAYMENT_REF);
    }

    function test_pauseBlocksX402() public {
        oracle.setPaused(true);
        vm.prank(WRITER);
        vm.expectRevert(NVDAPriceOracle.IsPaused.selector);
        oracle.updateX402Price(3000e8, 2, uint32(block.timestamp), PAYMENT_REF);
    }

    function test_latestRoundData_usesX402() public {
        oracle.setPrimarySource(NVDAPriceOracle.Source.X402);
        _pushX402(3000e8, 2);

        (, int256 answer,, uint256 updatedAt,) = oracle.latestRoundData();
        assertEq(answer, 3000e8);
        assertEq(updatedAt, block.timestamp);
    }
}
