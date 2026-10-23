// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { ITrancheHookValue } from "../../src/interfaces/ITrancheHookValue.sol";
import { IHookSharePipe } from "../../src/interfaces/IHookSharePipe.sol";
import { JuniorVault } from "../../src/vaults/JuniorVault.sol";
import { SeniorVault } from "../../src/vaults/SeniorVault.sol";
import { TrancheAccountant } from "../../src/vaults/TrancheAccountant.sol";
import { TrancheVault } from "../../src/vaults/TrancheVault.sol";
import { MockHookShare } from "../../src/test-only/MockHookShare.sol";
import { TestToken } from "../../src/test-only/TestToken.sol";

/// @notice Audit PoC: the accounting-oracle gate added in 570f495
///         (`_requireAccountingOracle` in `TrancheAccountant`) makes redemption
///         fulfillment and rebalance depend on oracle liveness + a spot-deviation
///         band. The repo's own mocks hardcode `oracleValid() == true`, so the
///         failing state is untested. This file exercises it.
contract ToggleableHookValue is ITrancheHookValue {
    uint256 public rate = 1e6;
    bool public expiredFlag;
    bool public validFlag = true;
    bool public deviationOk = true;
    uint256 public deviationBps = 0;

    function setRate(uint256 rate_) external {
        rate = rate_;
    }

    function setExpired(bool expired_) external {
        expiredFlag = expired_;
    }

    function setOracleValid(bool valid_) external {
        validFlag = valid_;
    }

    function setDeviation(bool ok, uint256 bps) external {
        deviationOk = ok;
        deviationBps = bps;
    }

    function convertToQuote(uint256 shares) external view returns (uint256) {
        return Math.mulDiv(shares, rate, 1e18);
    }

    function expired() external view returns (bool) {
        return expiredFlag;
    }

    function oracleValid() external view returns (bool) {
        return validFlag;
    }

    function spotDeviationBps() external view returns (bool, uint256) {
        return (deviationOk, deviationBps);
    }

    function maxUnwrapDeviationBps() external pure returns (uint16) {
        return 200;
    }
}

contract AuditOracleGateTest is Test {
    TestToken internal quote;
    TestToken internal nvda;
    MockHookShare internal hs;
    ToggleableHookValue internal valueSource;
    TrancheAccountant internal accountant;
    SeniorVault internal senior;
    JuniorVault internal junior;

    address internal alice;
    address internal bob;
    address internal keeper;

    function setUp() public {
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        keeper = makeAddr("keeper");

        quote = new TestToken("USD Coin", "mUSDC", 6);
        nvda = new TestToken("NVIDIA", "mNVDA", 18);
        hs = new MockHookShare(quote, address(this));
        valueSource = new ToggleableHookValue();

        accountant = new TrancheAccountant(address(this));
        accountant.setHook(address(valueSource));
        accountant.setKeeper(keeper);

        senior = new SeniorVault(hs, quote, nvda, IHookSharePipe(address(hs)), address(this), address(0), 0);
        junior = new JuniorVault(hs, quote, nvda, IHookSharePipe(address(hs)), address(this), address(0), 0);
        accountant.setVaults(address(senior), address(junior));
        senior.setAccountant(address(accountant));
        junior.setAccountant(address(accountant));

        hs.mint(alice, 100e18);
        hs.mint(bob, 100e18);
        _deposit(junior, bob, 100e18);
        _deposit(senior, alice, 100e18);
    }

    function _deposit(TrancheVault vault, address user, uint256 amount) internal {
        vm.prank(user);
        hs.approve(address(vault), type(uint256).max);
        vm.prank(user);
        vault.deposit(amount, user);
    }

    /// @notice Baseline: with a healthy oracle the keeper can fulfill a senior redemption.
    function test_fulfillWorksWithHealthyOracle() public {
        uint256 shares = senior.balanceOf(alice);
        vm.prank(alice);
        senior.requestRedeem(shares, alice, alice);

        vm.prank(keeper);
        accountant.fulfillRedeem(true, alice);
        assertGt(senior.claimableRedeemRequest(0, alice), 0);
    }

    /// @notice PoC 1: a stale/invalid oracle (no price push) blocks ALL redemptions.
    function test_fulfillBlockedWhenOracleInvalid() public {
        uint256 shares = senior.balanceOf(alice);
        vm.prank(alice);
        senior.requestRedeem(shares, alice, alice);

        valueSource.setOracleValid(false);

        vm.prank(keeper);
        vm.expectRevert(TrancheAccountant.OracleInvalid.selector);
        accountant.fulfillRedeem(true, alice);
    }

    /// @notice PoC 2: spot outside the 200bps band blocks ALL redemptions.
    function test_fulfillBlockedWhenSpotOutsideBand() public {
        uint256 shares = senior.balanceOf(alice);
        vm.prank(alice);
        senior.requestRedeem(shares, alice, alice);

        valueSource.setDeviation(true, 500); // 5% > 2% band

        vm.prank(keeper);
        vm.expectRevert(TrancheAccountant.OracleInvalid.selector);
        accountant.fulfillRedeem(true, alice);
    }

    /// @notice PoC 3: the same gate blocks the internal rebalance (share pegging).
    function test_rebalanceBlockedWhenOracleInvalid() public {
        valueSource.setOracleValid(false);
        vm.prank(keeper);
        vm.expectRevert(TrancheAccountant.OracleInvalid.selector);
        accountant.rebalance();
    }

    /// @notice PoC 4: the epoch claim path is gated on epoch readiness first; with no
    ///         executed epoch the read never reaches the oracle gate.
    function test_claimEpochNeedsEpochFirst() public {
        valueSource.setOracleValid(false);
        vm.expectRevert();
        accountant.claimEpoch(true, alice);
    }

    /// @notice Control: after expiry the gate is bypassed, so settlement is not liveness-bound.
    function test_expiredBypassesOracleGate() public {
        uint256 shares = senior.balanceOf(alice);
        vm.prank(alice);
        senior.requestRedeem(shares, alice, alice);

        valueSource.setOracleValid(false);
        valueSource.setExpired(true);

        vm.prank(keeper);
        accountant.fulfillRedeem(true, alice);
        assertGt(senior.claimableRedeemRequest(0, alice), 0);
    }
}
