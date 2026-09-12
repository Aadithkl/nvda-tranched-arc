// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IHookSharePipe } from "../../src/interfaces/IHookSharePipe.sol";
import { JuniorVault } from "../../src/vaults/JuniorVault.sol";
import { SeniorVault } from "../../src/vaults/SeniorVault.sol";
import { TrancheVault } from "../../src/vaults/TrancheVault.sol";
import { MockHookShare } from "../../src/test-only/MockHookShare.sol";
import { MockRiskAccountant } from "../../src/test-only/MockRiskAccountant.sol";
import { TestToken } from "../../src/test-only/TestToken.sol";

contract TrancheExpiryTest is Test {
    uint64 internal constant EXPIRY = 2_000_000_000;

    TestToken internal usdc;
    TestToken internal nvda;
    MockHookShare internal hs;
    MockRiskAccountant internal accountant;
    SeniorVault internal senior;
    JuniorVault internal junior;

    address internal alice;
    address internal bob;

    function setUp() public {
        vm.warp(1_900_000_000);
        alice = makeAddr("alice");
        bob = makeAddr("bob");

        usdc = new TestToken("USD Coin", "mUSDC", 6);
        nvda = new TestToken("NVIDIA", "mNVDA", 18);
        hs = new MockHookShare(IERC20(address(usdc)), makeAddr("hook"));
        accountant = new MockRiskAccountant();

        senior = new SeniorVault(
            IERC20(address(hs)),
            IERC20(address(usdc)),
            IERC20(address(nvda)),
            IHookSharePipe(address(hs)),
            address(this),
            address(accountant),
            EXPIRY
        );
        junior = new JuniorVault(
            IERC20(address(hs)),
            IERC20(address(usdc)),
            IERC20(address(nvda)),
            IHookSharePipe(address(hs)),
            address(this),
            address(accountant),
            EXPIRY
        );

        hs.mint(alice, 1_000e18);
        hs.mint(bob, 1_000e18);
        vm.prank(alice);
        hs.approve(address(senior), type(uint256).max);
        vm.prank(bob);
        hs.approve(address(junior), type(uint256).max);
        vm.prank(alice);
        senior.deposit(100e18, alice);
        vm.prank(bob);
        junior.deposit(100e18, bob);
    }

    function test_expiry_isFutureAndNotExpiredYet() public view {
        assertEq(senior.expiry(), EXPIRY);
        assertEq(junior.expiry(), EXPIRY);
        assertFalse(senior.expired());
        assertFalse(junior.expired());
    }

    function test_expiry_blocksDepositsAndRequests() public {
        vm.warp(EXPIRY);
        assertTrue(senior.expired());
        assertEq(senior.maxDeposit(alice), 0);
        assertEq(senior.maxMint(alice), 0);

        usdc.mint(alice, 10e6);
        vm.startPrank(alice);
        usdc.approve(address(senior), type(uint256).max);
        vm.expectRevert(TrancheVault.Expired.selector);
        senior.depositUSDC(10e6, alice);
        vm.expectRevert(TrancheVault.Expired.selector);
        senior.deposit(1e18, alice);
        vm.stopPrank();
    }

    function test_creditSettlement_onlyPipe() public {
        vm.expectRevert(abi.encodeWithSelector(TrancheVault.NotPipe.selector, address(this)));
        senior.creditSettlement(0, 0);
    }

    function test_creditSettlement_seniorPaysUsdcOnly() public {
        uint256 supply = senior.totalSupply();
        uint256 aliceShares = senior.balanceOf(alice);
        usdc.mint(address(senior), 100e6);

        vm.prank(address(hs));
        senior.creditSettlement(100e6, 0);

        assertTrue(senior.matured());
        assertEq(senior.usdcPerShare1e18(), 100e6 * 1e18 / supply);
        assertEq(senior.equityPerShare1e18(), 0);

        uint256 usdcBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        (uint256 usdcOut, uint256 equityOut) = senior.redeemAtExpiry(aliceShares, alice);
        assertEq(usdcOut, aliceShares * senior.usdcPerShare1e18() / 1e18);
        assertEq(equityOut, 0);
        assertEq(usdc.balanceOf(alice) - usdcBefore, usdcOut);
        assertEq(senior.balanceOf(alice), 0);
    }

    function test_creditSettlement_juniorPaysUsdcAndEquity() public {
        uint256 supply = junior.totalSupply();
        uint256 bobShares = junior.balanceOf(bob);
        usdc.mint(address(junior), 40e6);
        nvda.mint(address(junior), 10e18);

        vm.prank(address(hs));
        junior.creditSettlement(40e6, 10e18);

        assertEq(junior.usdcPerShare1e18(), 40e6 * 1e18 / supply);
        assertEq(junior.equityPerShare1e18(), 10e18 * 1e18 / supply);

        uint256 usdcBefore = usdc.balanceOf(bob);
        uint256 nvdaBefore = nvda.balanceOf(bob);
        vm.prank(bob);
        (uint256 usdcOut, uint256 equityOut) = junior.redeemAtExpiry(bobShares, bob);
        assertEq(usdcOut, bobShares * junior.usdcPerShare1e18() / 1e18);
        assertEq(equityOut, bobShares * junior.equityPerShare1e18() / 1e18);
        assertEq(usdc.balanceOf(bob) - usdcBefore, usdcOut);
        assertEq(nvda.balanceOf(bob) - nvdaBefore, equityOut);
    }

    function test_creditSettlement_seniorRejectsEquity() public {
        vm.prank(address(hs));
        vm.expectRevert(TrancheVault.SeniorUsdcOnly.selector);
        senior.creditSettlement(0, 1e18);
    }

    function test_creditSettlement_doubleCreditReverts() public {
        vm.prank(address(hs));
        senior.creditSettlement(0, 0);
        vm.prank(address(hs));
        vm.expectRevert(TrancheVault.SettlementAlreadyCredited.selector);
        senior.creditSettlement(0, 0);
    }

    function test_redeemAtExpiry_beforeSettlementReverts() public {
        vm.prank(alice);
        vm.expectRevert(TrancheVault.NotMatured.selector);
        senior.redeemAtExpiry(1e18, alice);
    }

    function test_redeemAtExpiry_zeroAndSlippageReverts() public {
        usdc.mint(address(senior), 100e6);
        vm.prank(address(hs));
        senior.creditSettlement(100e6, 0);

        vm.prank(alice);
        vm.expectRevert(TrancheVault.ZeroAmount.selector);
        senior.redeemAtExpiry(0, alice);

        vm.prank(alice);
        vm.expectRevert();
        senior.redeemAtExpiry(1e18, alice, type(uint256).max, 0);
    }

    function test_maturedBlocksRequestsAndUnwraps() public {
        vm.prank(address(hs));
        senior.creditSettlement(0, 0);

        vm.startPrank(alice);
        vm.expectRevert(TrancheVault.Matured.selector);
        senior.requestRedeem(1e18, alice, alice);
        vm.expectRevert(TrancheVault.Matured.selector);
        senior.claimAndUnwrapUSDC(1e18, alice, alice, 0);
        vm.stopPrank();
    }

    /// @dev A redemption fulfilled before maturity still claims after settlement, paid from the
    ///      frozen terminal rate for the shares consumed.
    function test_claimableClaimPaysFrozenRate() public {
        uint256 shares = 10e18;
        vm.prank(alice);
        senior.requestRedeem(shares, alice, alice);
        assertEq(senior.pendingRedeemRequest(0, alice), shares);

        vm.prank(address(accountant));
        senior.fulfillRedeem(shares, shares, alice);
        assertEq(senior.claimableRedeemRequest(0, alice), shares);

        usdc.mint(address(senior), 100e6);
        vm.warp(EXPIRY);
        vm.prank(address(hs));
        senior.creditSettlement(100e6, 0);

        uint256 rate = senior.usdcPerShare1e18();
        uint256 usdcBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        // `redeem` returns the nominal hook-share amount consumed; the actual payout is USDC at
        // the frozen terminal rate (asserted via the balance delta below).
        uint256 nominal = senior.redeem(shares, alice, alice);
        assertEq(nominal, shares);
        assertEq(usdc.balanceOf(alice) - usdcBefore, shares * rate / 1e18);
        assertEq(senior.claimableRedeemRequest(0, alice), 0);
    }

    function test_expiryUnsetMeansNoMaturity() public {
        SeniorVault plain = new SeniorVault(
            IERC20(address(hs)),
            IERC20(address(usdc)),
            IERC20(address(nvda)),
            IHookSharePipe(address(hs)),
            address(this),
            address(accountant),
            0
        );
        vm.warp(EXPIRY + 365 days);
        assertFalse(plain.expired());
        assertEq(plain.maxDeposit(alice), type(uint256).max);

        vm.prank(address(hs));
        plain.creditSettlement(0, 0);
        assertTrue(plain.matured());
    }
}
