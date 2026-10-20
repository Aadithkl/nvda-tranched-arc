// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";
import { TrancheAccountant } from "../../src/vaults/TrancheAccountant.sol";
import { SeniorVault } from "../../src/vaults/SeniorVault.sol";
import { JuniorVault } from "../../src/vaults/JuniorVault.sol";
import { TrancheVault } from "../../src/vaults/TrancheVault.sol";
import { MockHookShare } from "../../src/test-only/MockHookShare.sol";
import { TestToken } from "../../src/test-only/TestToken.sol";
import { IHookSharePipe } from "../../src/interfaces/IHookSharePipe.sol";

/// @notice Centrifuge-style withdrawal epochs: 24h boundaries, permissionless execution,
///         seniority order, equal-ratio fills, 25% junior floor (lifted when frozen),
///         auto-rolling remainders, senior deposit gate. No keeper key anywhere here.
contract EpochsTest is Test {
    TestToken internal quote;
    TestToken internal nvda;
    MockHookShare internal hs;
    MockHookValueLocal internal valueSource;
    TrancheAccountant internal accountant;
    SeniorVault internal senior;
    JuniorVault internal junior;

    address internal alice;
    address internal bob;
    address internal rando;

    uint256 internal constant DAY = 1 days;

    function setUp() public {
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        rando = makeAddr("rando");

        quote = new TestToken("USD Coin", "mUSDC", 6);
        nvda = new TestToken("NVIDIA", "mNVDA", 18);
        hs = new MockHookShare(quote, address(this));
        valueSource = new MockHookValueLocal();

        accountant = new TrancheAccountant(address(this));
        accountant.setHook(address(valueSource));

        senior = new SeniorVault(hs, quote, nvda, IHookSharePipe(address(hs)), address(this), address(0), 0);
        junior = new JuniorVault(hs, quote, nvda, IHookSharePipe(address(hs)), address(this), address(0), 0);
        accountant.setVaults(address(senior), address(junior));
        senior.setAccountant(address(accountant));
        junior.setAccountant(address(accountant));
    }

    function _deposit(TrancheVault vault, address user, uint256 amount) internal {
        hs.mint(user, amount);
        vm.prank(user);
        hs.approve(address(vault), type(uint256).max);
        vm.prank(user);
        vault.deposit(amount, user);
    }

    function _requestAll(TrancheVault vault, address user) internal returns (uint256 shares) {
        shares = vault.balanceOf(user);
        vm.prank(user);
        vault.requestRedeem(shares, user, user);
    }

    function _warpToBoundary(uint256 day) internal {
        vm.warp(day * DAY + 3600);
    }

    function test_execute_advancesOnlyPastBoundary() public {
        _warpToBoundary(0);
        vm.expectRevert(abi.encodeWithSelector(TrancheAccountant.EpochNotReady.selector, 0));
        accountant.executeEpoch();

        _warpToBoundary(1);
        assertEq(accountant.executeEpoch(), 1);

        vm.expectRevert(abi.encodeWithSelector(TrancheAccountant.EpochNotReady.selector, 1));
        accountant.executeEpoch();

        _warpToBoundary(2);
        assertEq(accountant.executeEpoch(), 2);
    }

    function test_execute_fullFills_and_permissionlessClaims() public {
        _deposit(junior, bob, 100e18);
        _deposit(senior, alice, 100e18);
        uint256 srShares = _requestAll(senior, alice);
        uint256 jrShares = _requestAll(junior, bob);

        _warpToBoundary(1);
        // Anyone may close the boundary — no keeper key.
        vm.prank(rando);
        uint256 id = accountant.executeEpoch();
        assertEq(id, 1);
        (uint64 snapId, uint16 fS, uint16 fJ, uint256 rS, uint256 rJ) = accountant.epochSnaps(1);
        emit log_named_uint("DBG fS", fS);
        emit log_named_uint("DBG fJ", fJ);
        emit log_named_uint("DBG rS", rS);
        emit log_named_uint("DBG rJ", rJ);
        assertEq(snapId, 1);
        assertEq(fS, 10_000);
        assertEq(fJ, 10_000);

        // Anyone may claim for anyone; value lands with the user, not the caller.
        vm.prank(rando);
        accountant.claimEpoch(true, alice);
        vm.prank(rando);
        accountant.claimEpoch(false, bob);

        assertEq(senior.pendingRedeemRequest(0, alice), 0, "senior remainder rolled: none");
        assertEq(junior.pendingRedeemRequest(0, bob), 0);
        assertGt(senior.claimableRedeemRequest(0, alice), 0);
        assertGt(junior.claimableRedeemRequest(0, bob), 0);

        // Users collect through the standard redeem path.
        vm.prank(alice);
        senior.redeem(srShares, alice, alice);
        vm.prank(bob);
        junior.redeem(jrShares, bob, bob);
        assertGt(hs.balanceOf(alice), 0);
        assertGt(hs.balanceOf(bob), 0);
    }

    function test_floor_trimsJuniorWhenSeniorStays_remainderRolls() public {
        // Junior-led genesis (deposit gate). Only junior orders: the floor binds because
        // senior backing stays put (joint full exits would preserve it trivially).
        _deposit(junior, bob, 30e18);
        _deposit(senior, alice, 70e18);
        _requestAll(junior, bob);

        _warpToBoundary(1);
        accountant.executeEpoch();
        (, uint16 fS, uint16 fJ,,) = accountant.epochSnaps(1);
        assertEq(fS, 10_000, "no senior orders: vacuous full");
        assertLt(fJ, 10_000, "junior trimmed by the floor");
        assertGt(fJ, 0, "but not to zero");

        // Junior claims the partial fill; the rest stays pending (auto-roll, no re-ask).
        accountant.claimEpoch(false, bob);
        assertGt(junior.pendingRedeemRequest(0, bob), 0, "remainder rolls");
        uint256 bobMax = junior.maxRedeem(bob);
        vm.prank(bob);
        junior.redeem(bobMax, bob, bob);

        // Senior exits fully (raises the fraction); next boundary completes junior.
        _requestAll(senior, alice);
        _warpToBoundary(2);
        accountant.executeEpoch();
        accountant.claimEpoch(true, alice);
        uint256 aliceMax = senior.maxRedeem(alice);
        vm.prank(alice);
        senior.redeem(aliceMax, alice, alice);

        _warpToBoundary(3);
        accountant.executeEpoch();
        (,, uint16 fJ3,,) = accountant.epochSnaps(3);
        assertEq(fJ3, 10_000, "remainder fills once cover is ample");
        accountant.claimEpoch(false, bob);
        assertEq(junior.pendingRedeemRequest(0, bob), 0);
    }

    function test_profit_valueCapsBind_shareFillsStayFull() public {
        _deposit(junior, bob, 100e18);
        _deposit(senior, alice, 100e18);
        // Book doubles: senior value-capped at promise, junior takes the residual upside.
        valueSource.setRate(2e6);
        _requestAll(senior, alice);
        _requestAll(junior, bob);

        _warpToBoundary(1);
        accountant.executeEpoch();
        (, uint16 fS, uint16 fJ,,) = accountant.epochSnaps(1);
        assertEq(fS, 10_000, "share fills complete for both sides");
        assertEq(fJ, 10_000, "share fills complete for both sides");
        assertLe(fJ, fS, "equal-ratio holds structurally");

        accountant.claimEpoch(true, alice);
        accountant.claimEpoch(false, bob);

        // Senior locked value respects the promise cap despite the fat book...
        uint256 seniorLockedValue = valueSource.convertToQuote(accountant.claimableSenior());
        assertLe(seniorLockedValue, accountant.seniorPrincipal(), "senior never above promise");
        // ...while junior locked value exceeds its principal (upside belongs to residual).
        uint256 juniorLockedValue = valueSource.convertToQuote(accountant.claimableJunior());
        assertGt(juniorLockedValue, 100e6, "junior captures upside");
    }

    function test_frozen_liftsFloor() public {
        _deposit(junior, bob, 30e18);
        _deposit(senior, alice, 70e18);
        _requestAll(junior, bob);

        accountant.setFrozen(true);
        _warpToBoundary(1);
        accountant.executeEpoch();
        (,, uint16 fJ,,) = accountant.epochSnaps(1);
        assertEq(fJ, 10_000, "frozen wind-down opens all doors");
    }

    function test_expired_refusesEpochPaths() public {
        _deposit(junior, bob, 100e18);
        _deposit(senior, alice, 100e18);
        _requestAll(senior, alice);

        valueSource.setExpired(true);
        _warpToBoundary(1);
        vm.expectRevert(TrancheAccountant.Expired.selector);
        accountant.executeEpoch();
        vm.expectRevert(TrancheAccountant.Expired.selector);
        accountant.claimEpoch(true, alice);
    }

    function test_depositGate_blocksBreachingSenior() public {
        _deposit(junior, bob, 20e18);
        // Senior would take the junior slice to ~9% — refused.
        hs.mint(alice, 100e18);
        vm.prank(alice);
        hs.approve(address(senior), type(uint256).max);
        vm.prank(alice);
        vm.expectRevert();
        senior.deposit(100e18, alice);

        // Junior money always welcome (only raises coverage).
        _deposit(junior, bob, 100e18);
        // Now 120/220 ≈ 55% — senior fits.
        _deposit(senior, alice, 100e18);
        assertGt(senior.balanceOf(alice), 0);
    }

    function test_noOrders_advances() public {
        _warpToBoundary(3);
        assertEq(accountant.executeEpoch(), 3);
    }
}

contract MockHookValueLocal {
    uint256 public rate = 1e6;
    bool public expiredFlag;

    function setRate(uint256 rate_) external {
        rate = rate_;
    }

    function setExpired(bool expired_) external {
        expiredFlag = expired_;
    }

    function convertToQuote(uint256 shares) external view returns (uint256) {
        return shares * rate / 1e18;
    }

    function expired() external view returns (bool) {
        return expiredFlag;
    }

    function oracleValid() external pure returns (bool) {
        return true;
    }

    function spotDeviationBps() external pure returns (bool, uint256) {
        return (true, 0);
    }

    function maxUnwrapDeviationBps() external pure returns (uint16) {
        return 200;
    }
}

