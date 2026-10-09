// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";
import { ChainlinkSessionOracle } from "../../src/oracle/ChainlinkSessionOracle.sol";
import { MockAggregator, MockSessionStatus } from "../../src/test-only/MockStrategyFakes.sol";

contract ChainlinkSessionOracleTest is Test {
    MockAggregator internal feed;
    MockSessionStatus internal sessions;
    ChainlinkSessionOracle internal oracle;

    function setUp() public {
        feed = new MockAggregator(8, 250e8);
        sessions = new MockSessionStatus(2); // regular session
        oracle = new ChainlinkSessionOracle(address(feed), address(sessions), 300);
    }

    function test_freshRegular_isValid() public view {
        ChainlinkSessionOracle.PriceData memory data = oracle.getPrice();
        assertEq(data.mid, int192(250e8));
        assertEq(data.bid, data.mid);
        assertEq(data.ask, data.mid);
        assertEq(data.marketStatus, 2);
        assertEq(data.session, 1); // Regular
        assertTrue(data.valid);
        assertEq(oracle.decimals(), 8);
    }

    function test_stale_feed_invalid() public {
        vm.warp(block.timestamp + 301);
        ChainlinkSessionOracle.PriceData memory data = oracle.getPrice();
        assertFalse(data.valid);
        assertEq(data.mid, int192(250e8));
    }

    function test_sessionNone_invalid() public {
        sessions.setMarketStatus(0);
        ChainlinkSessionOracle.PriceData memory data = oracle.getPrice();
        assertFalse(data.valid);
        assertEq(data.session, 0);
    }

    function test_sessionMapping() public {
        sessions.setMarketStatus(4);
        assertEq(oracle.getPrice().session, 3); // Overnight
        sessions.setMarketStatus(1);
        assertEq(oracle.getPrice().session, 2); // Extended
        sessions.setMarketStatus(3);
        assertEq(oracle.getPrice().session, 2); // Extended
    }

    function test_negativeAnswer_invalid() public {
        feed.setAnswer(-1);
        ChainlinkSessionOracle.PriceData memory data = oracle.getPrice();
        assertEq(data.mid, 0);
        assertFalse(data.valid);
    }

    function test_feedRefresh_revalidates() public {
        vm.warp(block.timestamp + 400);
        assertFalse(oracle.getPrice().valid);
        feed.setAnswer(255e8);
        assertTrue(oracle.getPrice().valid);
        assertEq(oracle.getPrice().mid, int192(255e8));
    }

    function test_ownerGates() public {
        vm.prank(makeAddr("mallory"));
        vm.expectRevert(abi.encodeWithSelector(ChainlinkSessionOracle.NotOwner.selector, makeAddr("mallory")));
        oracle.setMaxPriceAge(600);

        oracle.setMaxPriceAge(600);
        assertEq(oracle.maxPriceAge(), 600);

        MockAggregator feed18 = new MockAggregator(18, 1e18);
        oracle.setPriceFeed(address(feed18));
        assertEq(oracle.decimals(), 18);

        MockSessionStatus newSessions = new MockSessionStatus(2);
        oracle.setSessionSource(address(newSessions));
        assertEq(address(oracle.sessionSource()), address(newSessions));
    }
}
