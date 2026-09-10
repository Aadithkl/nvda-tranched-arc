// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {NVDAPriceOracle} from "../../src/oracle/NVDAPriceOracle.sol";

contract NVDAPriceOracleTest is Test {
    NVDAPriceOracle internal oracle;

    uint32 internal constant STALENESS = 300;
    address internal constant WRITER = address(0xA11CE);
    address internal constant STRANGER = address(0xBAD);
    bytes32 internal constant PAYMENT_REF = keccak256("x402-payment-receipt");

    function setUp() public {
        oracle = new NVDAPriceOracle(8, address(this));
        oracle.setWriter(WRITER, true);
        oracle.setMaxStaleness(STALENESS);
    }

    function _push(int192 mid, uint32 status) internal {
        vm.prank(WRITER);
        oracle.updatePrice(mid, status, uint32(block.timestamp), PAYMENT_REF);
    }

    function test_configDefaults() public view {
        assertEq(oracle.decimals(), 8);
        assertEq(oracle.owner(), address(this));
        assertTrue(oracle.writers(WRITER));
        assertEq(oracle.maxStaleness(), STALENESS);
        assertEq(oracle.marketStatus(), 0);
        assertFalse(oracle.paused());
    }

    function test_update_valid() public {
        _push(3000e8, 2);

        NVDAPriceOracle.PriceData memory data = oracle.getPrice();
        assertTrue(data.valid);
        assertEq(data.mid, 3000e8);
        assertEq(data.bid, 3000e8);
        assertEq(data.ask, 3000e8);
        assertEq(data.marketStatus, 2);
        assertEq(uint8(data.session), uint8(NVDAPriceOracle.Session.Regular));
        assertEq(data.paymentRef, PAYMENT_REF);
        assertEq(oracle.marketStatus(), 2);
    }

    function test_update_extended_sessions() public {
        _push(3000e8, 1);
        assertEq(uint8(oracle.getPrice().session), uint8(NVDAPriceOracle.Session.Extended));

        _push(3001e8, 3);
        NVDAPriceOracle.PriceData memory data = oracle.getPrice();
        assertTrue(data.valid);
        assertEq(uint8(data.session), uint8(NVDAPriceOracle.Session.Extended));
    }

    function test_update_overnight() public {
        _push(2999e8, 4);
        NVDAPriceOracle.PriceData memory data = oracle.getPrice();
        assertTrue(data.valid);
        assertEq(uint8(data.session), uint8(NVDAPriceOracle.Session.Overnight));
    }

    function test_update_onlyWriter() public {
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(NVDAPriceOracle.NotWriter.selector, STRANGER));
        oracle.updatePrice(3000e8, 2, uint32(block.timestamp), PAYMENT_REF);
    }

    function test_update_rejectsNonPositivePrice() public {
        vm.prank(WRITER);
        vm.expectRevert(abi.encodeWithSelector(NVDAPriceOracle.InvalidPrice.selector, int192(0)));
        oracle.updatePrice(0, 2, uint32(block.timestamp), PAYMENT_REF);
    }

    function test_update_rejectsInvalidStatus() public {
        vm.prank(WRITER);
        vm.expectRevert(abi.encodeWithSelector(NVDAPriceOracle.InvalidMarketStatus.selector, uint32(6)));
        oracle.updatePrice(3000e8, 6, uint32(block.timestamp), PAYMENT_REF);
    }

    function test_staleInvalidates() public {
        _push(3000e8, 2);
        assertTrue(oracle.getPrice().valid);

        skip(STALENESS + 1);

        NVDAPriceOracle.PriceData memory data = oracle.getPrice();
        assertFalse(data.valid);
        assertEq(data.mid, 3000e8);
    }

    function test_freshBoundaryStillValid() public {
        _push(3000e8, 2);
        skip(STALENESS);
        assertTrue(oracle.getPrice().valid);
    }

    function test_closedStatusInvalidates() public {
        _push(3000e8, 2);
        _push(3000e8, 5);

        NVDAPriceOracle.PriceData memory data = oracle.getPrice();
        assertFalse(data.valid);
        assertEq(data.marketStatus, 5);
        assertEq(uint8(data.session), uint8(NVDAPriceOracle.Session.None));
    }

    function test_unknownStatusInvalidates() public {
        _push(3000e8, 4);
        _push(3000e8, 0);
        assertFalse(oracle.getPrice().valid);
    }

    function test_pauseBlocksUpdates() public {
        oracle.setPaused(true);
        vm.prank(WRITER);
        vm.expectRevert(NVDAPriceOracle.IsPaused.selector);
        oracle.updatePrice(3000e8, 2, uint32(block.timestamp), PAYMENT_REF);
    }

    function test_setWriter_onlyOwner() public {
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(NVDAPriceOracle.NotOwner.selector, STRANGER));
        oracle.setWriter(STRANGER, true);
    }

    function test_setMaxStaleness_onlyOwner() public {
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(NVDAPriceOracle.NotOwner.selector, STRANGER));
        oracle.setMaxStaleness(60);
    }

    function test_revokedWriter_reverts() public {
        oracle.setWriter(WRITER, false);
        vm.prank(WRITER);
        vm.expectRevert(abi.encodeWithSelector(NVDAPriceOracle.NotWriter.selector, WRITER));
        oracle.updatePrice(3000e8, 2, uint32(block.timestamp), PAYMENT_REF);
    }

    function test_latestRoundData_revertsWithoutPrice() public {
        vm.expectRevert(NVDAPriceOracle.NoPriceData.selector);
        oracle.latestRoundData();
    }

    function test_latestRoundData_afterUpdate() public {
        _push(3000e8, 2);
        (, int256 answer,, uint256 updatedAt,) = oracle.latestRoundData();
        assertEq(answer, 3000e8);
        assertEq(updatedAt, block.timestamp);
    }

    function testFuzz_update_valid(uint192 mid) public {
        mid = uint192(bound(mid, 1, uint256(int256(type(int192).max))));
        _push(int192(mid), 2);
        NVDAPriceOracle.PriceData memory data = oracle.getPrice();
        assertTrue(data.valid);
        assertEq(data.mid, int192(mid));
    }
}
