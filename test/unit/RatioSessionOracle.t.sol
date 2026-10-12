// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";
import { RatioSessionOracle } from "../../src/oracle/RatioSessionOracle.sol";
import { MockAggregator, MockSessionStatus } from "../../src/test-only/MockStrategyFakes.sol";

/// @notice Composite NVDA/USD ÷ ETH/USD oracle: mid = WETH per NVDA at 1e18.
///         $200 NVDA / $2500 ETH = 0.08 WETH per NVDA.
contract RatioSessionOracleTest is Test {
    MockAggregator internal nvdaFeed;
    MockAggregator internal ethFeed;
    MockSessionStatus internal sessions;
    RatioSessionOracle internal oracle;

    function setUp() public {
        nvdaFeed = new MockAggregator(8, 200e8);
        ethFeed = new MockAggregator(8, 2500e8);
        sessions = new MockSessionStatus(2); // regular session
        oracle = new RatioSessionOracle(address(nvdaFeed), address(ethFeed), address(sessions), 300);
    }

    function test_freshRegular_isValid() public view {
        RatioSessionOracle.PriceData memory data = oracle.getPrice();
        assertEq(data.mid, int192(0.08e18));
        assertEq(data.bid, data.mid);
        assertEq(data.ask, data.mid);
        assertEq(data.marketStatus, 2);
        assertEq(data.session, 1); // Regular
        assertTrue(data.valid);
        assertEq(oracle.decimals(), 18);
    }

    function test_eitherLegStale_invalid() public {
        vm.warp(block.timestamp + 301);
        assertFalse(oracle.getPrice().valid);

        // Fresh legs revalidate (staleness is per-leg, worst leg governs).
        nvdaFeed.setAnswer(200e8);
        ethFeed.setAnswer(2500e8);
        assertTrue(oracle.getPrice().valid);
    }

    function test_zeroDenominator_invalid() public {
        ethFeed.setAnswer(0);
        RatioSessionOracle.PriceData memory data = oracle.getPrice();
        assertEq(data.mid, 0);
        assertFalse(data.valid);
    }

    function test_negativeNumerator_invalid() public {
        nvdaFeed.setAnswer(-1);
        RatioSessionOracle.PriceData memory data = oracle.getPrice();
        assertEq(data.mid, 0);
        assertFalse(data.valid);
    }

    function test_sessionNone_invalid() public {
        sessions.setMarketStatus(0);
        RatioSessionOracle.PriceData memory data = oracle.getPrice();
        assertFalse(data.valid);
        assertEq(data.session, 0);
    }

    function test_mixedDecimals_scaleTo18() public {
        MockAggregator eth18 = new MockAggregator(18, 2500e18);
        RatioSessionOracle mixed = new RatioSessionOracle(address(nvdaFeed), address(eth18), address(sessions), 300);
        assertEq(mixed.getPrice().mid, int192(0.08e18));
    }

    function test_ownerGates() public {
        vm.prank(makeAddr("mallory"));
        vm.expectRevert(abi.encodeWithSelector(RatioSessionOracle.NotOwner.selector, makeAddr("mallory")));
        oracle.setMaxPriceAge(600);

        oracle.setMaxPriceAge(600);
        assertEq(oracle.maxPriceAge(), 600);

        MockAggregator fresh = new MockAggregator(8, 210e8);
        oracle.setNvdaFeed(address(fresh));
        assertEq(address(oracle.nvdaFeed()), address(fresh));

        MockSessionStatus newSessions = new MockSessionStatus(2);
        oracle.setSessionSource(address(newSessions));
        assertEq(address(oracle.sessionSource()), address(newSessions));
    }
}
