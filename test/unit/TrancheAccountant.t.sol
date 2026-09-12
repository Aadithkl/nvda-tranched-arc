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

contract MockHookValue is ITrancheHookValue {
    uint256 public rate = 1e6;
    bool public expiredFlag;

    function setRate(uint256 rate_) external {
        rate = rate_;
    }

    function setExpired(bool expired_) external {
        expiredFlag = expired_;
    }

    function convertToUsdc(uint256 shares) external view returns (uint256) {
        return Math.mulDiv(shares, rate, 1e18);
    }

    function expired() external view returns (bool) {
        return expiredFlag;
    }
}

contract TrancheAccountantTest is Test {
    TestToken internal usdc;
    TestToken internal nvda;
    MockHookShare internal hs;
    MockHookValue internal valueSource;
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

        usdc = new TestToken("USD Coin", "mUSDC", 6);
        nvda = new TestToken("NVIDIA", "mNVDA", 18);
        hs = new MockHookShare(usdc, address(this));
        valueSource = new MockHookValue();

        accountant = new TrancheAccountant(address(this));
        accountant.setHook(address(valueSource));
        accountant.setKeeper(keeper);

        senior = new SeniorVault(hs, usdc, nvda, IHookSharePipe(address(hs)), address(this), address(0), 0);
        junior = new JuniorVault(hs, usdc, nvda, IHookSharePipe(address(hs)), address(this), address(0), 0);
        accountant.setVaults(address(senior), address(junior));
        senior.setAccountant(address(accountant));
        junior.setAccountant(address(accountant));

        hs.mint(alice, 100e18);
        hs.mint(bob, 100e18);
        _deposit(senior, alice, 100e18);
        _deposit(junior, bob, 100e18);
    }

    function _deposit(TrancheVault vault, address user, uint256 amount) internal {
        vm.prank(user);
        hs.approve(address(vault), type(uint256).max);
        vm.prank(user);
        vault.deposit(amount, user);
    }

    function test_fulfillRedeem_permissionlessAfterExpiry() public {
        uint256 shares = senior.balanceOf(alice);
        vm.prank(alice);
        senior.requestRedeem(shares, alice, alice);

        address rando = makeAddr("rando");
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(TrancheAccountant.NotKeeper.selector, rando));
        accountant.fulfillRedeem(true, alice);

        valueSource.setExpired(true);
        vm.prank(rando);
        accountant.fulfillRedeem(true, alice);
        assertGt(senior.claimableRedeemRequest(0, alice), 0);
    }

    function test_depositsReportPrincipal() public view {
        assertEq(accountant.seniorPrincipal(), 100e6);
        assertEq(accountant.juniorPrincipal(), 100e6);
        assertEq(accountant.poolValue(), 200e6);
    }

    function test_claims_seniorCouponJuniorResidual() public view {
        assertEq(accountant.seniorClaim(), 105e6);
        assertEq(accountant.juniorClaim(), 95e6);
        assertTrue(accountant.escrowFunded());
    }

    function test_rebalance_movesEscrowSharesToSenior() public {
        (uint256 movedToSenior, uint256 movedToJunior) = accountant.rebalance();
        assertEq(movedToSenior, 5e18);
        assertEq(movedToJunior, 0);
        assertEq(hs.balanceOf(address(senior)), 105e18);
        assertEq(hs.balanceOf(address(junior)), 95e18);
        assertEq(accountant.poolValue(), 200e6);
    }

    function test_profit_increasesJuniorClaim() public {
        valueSource.setRate(1.05e6);
        assertEq(accountant.poolValue(), 210e6);
        assertEq(accountant.seniorClaim(), 105e6);
        assertEq(accountant.juniorClaim(), 105e6);
    }

    function test_loss_juniorAbsorbs() public {
        valueSource.setRate(0.9e6);
        (uint256 movedToSenior,) = accountant.rebalance();
        assertEq(accountant.poolValue(), 180e6);
        assertEq(accountant.seniorClaim(), 105e6);
        assertEq(accountant.juniorClaim(), 75e6);
        uint256 expectedSeniorShares = Math.mulDiv(200e18, 105, 180);
        assertEq(movedToSenior, expectedSeniorShares - 100e18);
        assertEq(hs.balanceOf(address(senior)), expectedSeniorShares);
    }

    function test_seniorHaircut_juniorWiped() public {
        valueSource.setRate(0.5e6);
        accountant.rebalance();
        assertEq(accountant.poolValue(), 100e6);
        assertEq(accountant.seniorClaim(), 100e6);
        assertEq(accountant.juniorClaim(), 0);
        assertEq(hs.balanceOf(address(junior)), 0);
        assertEq(hs.balanceOf(address(senior)), 200e18);
    }

    function test_escrowFunded_falseOnDeepLoss() public {
        valueSource.setRate(0.2e6);
        assertFalse(accountant.escrowFunded());
    }

    function test_fulfillRedeem_seniorPriority() public {
        uint256 aliceShares = senior.balanceOf(alice);
        vm.prank(alice);
        senior.requestRedeem(aliceShares, alice, alice);
        uint256 bobShares = junior.balanceOf(bob);
        vm.prank(bob);
        junior.requestRedeem(bobShares, bob, bob);

        vm.prank(keeper);
        vm.expectRevert(TrancheAccountant.SeniorPriority.selector);
        accountant.fulfillRedeem(false, bob);

        vm.prank(keeper);
        accountant.fulfillRedeem(true, alice);
        assertEq(senior.claimableRedeemRequest(0, alice), senior.maxRedeem(alice));
    }

    function test_fulfillRedeem_reducesPrincipal() public {
        uint256 principalBefore = accountant.seniorPrincipal();
        uint256 aliceShares = senior.balanceOf(alice);
        vm.prank(alice);
        senior.requestRedeem(aliceShares, alice, alice);

        vm.prank(keeper);
        accountant.fulfillRedeem(true, alice);
        assertLt(accountant.seniorPrincipal(), principalBefore);
    }

    function test_fulfillRedeem_onlyKeeper() public {
        uint256 aliceShares = senior.balanceOf(alice);
        vm.prank(alice);
        senior.requestRedeem(aliceShares, alice, alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TrancheAccountant.NotKeeper.selector, alice));
        accountant.fulfillRedeem(true, alice);
    }

    function test_rebalance_keepsLockedRedeemAssets() public {
        valueSource.setRate(1.05e6);
        accountant.rebalance();

        uint256 aliceShares = senior.balanceOf(alice);
        vm.prank(alice);
        senior.requestRedeem(aliceShares, alice, alice);

        vm.prank(keeper);
        accountant.fulfillRedeem(true, alice);
        uint256 locked = senior.maxWithdraw(alice);
        assertGt(locked, 0);
        assertEq(accountant.claimableSenior(), locked);

        // Any later rebalance must leave the assets backing the fulfilled claim untouched.
        accountant.rebalance();
        assertGe(hs.balanceOf(address(senior)), locked);

        vm.prank(alice);
        uint256 got = senior.redeem(aliceShares, alice, alice);
        assertEq(got, locked);
        assertEq(accountant.claimableSenior(), 0);
    }

    function test_effectivePool_excludesLockedClaims() public {
        valueSource.setRate(1.05e6);
        accountant.rebalance();
        assertEq(accountant.effectivePool(), 210e6);

        uint256 aliceShares = senior.balanceOf(alice);
        vm.prank(alice);
        senior.requestRedeem(aliceShares, alice, alice);
        vm.prank(keeper);
        accountant.fulfillRedeem(true, alice);

        // The 105 USDC redeemed by alice is locked to her, not junior's claim.
        assertEq(accountant.poolValue(), 210e6);
        assertApproxEqAbs(accountant.juniorClaim(), 105e6, 1e4);
        assertApproxEqAbs(accountant.effectivePool(), 105e6, 1e4);
    }

    function test_setters_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        accountant.setEscrowBps(100);
        vm.prank(alice);
        vm.expectRevert();
        accountant.setKeeper(alice);
    }

    function test_hookRiskBudget_readsAccountant() public {
        assertEq(accountant.juniorClaim(), 95e6);
        valueSource.setRate(1.05e6);
        assertEq(accountant.juniorClaim(), 105e6);
    }
}
