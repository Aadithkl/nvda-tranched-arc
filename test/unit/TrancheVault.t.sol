// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {
    IERC7540Deposit,
    IERC7540Redeem,
    IERC7540Operator
} from "openzeppelin-community-contracts/interfaces/IERC7540.sol";
import { IHookSharePipe } from "../../src/interfaces/IHookSharePipe.sol";
import { JuniorVault } from "../../src/vaults/JuniorVault.sol";
import { SeniorVault } from "../../src/vaults/SeniorVault.sol";
import { TrancheVault } from "../../src/vaults/TrancheVault.sol";
import { MockHookShare } from "../../src/test-only/MockHookShare.sol";
import { MockRiskAccountant } from "../../src/test-only/MockRiskAccountant.sol";
import { MockToken } from "../../src/test-only/MockToken.sol";

contract TrancheVaultTest is Test {
    MockToken internal usdc;
    MockToken internal nvda;
    MockHookShare internal hs;
    SeniorVault internal senior;
    JuniorVault internal junior;

    address internal accountant;
    address internal alice;
    address internal bob;

    function setUp() public {
        accountant = address(new MockRiskAccountant());
        alice = makeAddr("alice");
        bob = makeAddr("bob");

        usdc = new MockToken("USD Coin", "mUSDC", 6);
        nvda = new MockToken("NVIDIA", "mNVDA", 18);
        hs = new MockHookShare(IERC20(address(usdc)), makeAddr("hook"));
        senior = new SeniorVault(
            IERC20(address(hs)), IERC20(address(usdc)), IHookSharePipe(address(hs)), address(this), accountant
        );
        junior = new JuniorVault(
            IERC20(address(hs)), IERC20(address(usdc)), IHookSharePipe(address(hs)), address(this), accountant
        );

        usdc.mint(address(hs), 1_000_000e6);
        nvda.mint(address(hs), 1_000_000e18);
        hs.setEquity(IERC20(address(nvda)));
        usdc.mint(alice, 1_000e6);
        usdc.mint(bob, 1_000e6);
        hs.mint(alice, 1_000e18);
        hs.mint(bob, 1_000e18);

        vm.prank(alice);
        usdc.approve(address(senior), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(junior), type(uint256).max);
        vm.prank(alice);
        hs.approve(address(senior), type(uint256).max);
        vm.prank(bob);
        hs.approve(address(junior), type(uint256).max);
    }

    function _depositSeniorShares(uint256 amount) internal returns (uint256 shares) {
        vm.prank(alice);
        shares = senior.deposit(amount, alice);
    }

    function test_constructor_metadataAndRoles() public view {
        assertEq(senior.name(), "Senior NVDA Tranche");
        assertEq(senior.symbol(), "srNVDA");
        assertEq(junior.name(), "Junior NVDA Tranche");
        assertEq(junior.symbol(), "jrNVDA");
        assertEq(senior.asset(), address(hs));
        assertEq(address(senior.usdc()), address(usdc));
        assertEq(senior.owner(), address(this));
        assertEq(senior.guardian(), address(this));
        assertEq(senior.accountant(), accountant);
        assertEq(senior.decimals(), 21);
    }

    function test_supportsInterface_7540() public view {
        assertTrue(senior.supportsInterface(type(IERC7540Operator).interfaceId));
        assertTrue(senior.supportsInterface(type(IERC7540Redeem).interfaceId));
        assertFalse(senior.supportsInterface(type(IERC7540Deposit).interfaceId));
        assertTrue(senior.supportsInterface(type(IERC165).interfaceId));
        assertTrue(junior.supportsInterface(type(IERC7540Redeem).interfaceId));
    }

    function test_depositHookShares_mintsShares() public {
        uint256 shares = _depositSeniorShares(100e18);
        assertEq(shares, senior.previewDeposit(100e18));
        assertEq(senior.balanceOf(alice), shares);
        assertEq(senior.totalAssets(), 100e18);
        assertEq(hs.balanceOf(address(senior)), 100e18);
        assertApproxEqAbs(senior.convertToAssets(shares), 100e18, 1e15);
    }

    function test_depositHookShares_withoutAllowance_reverts() public {
        vm.prank(bob);
        vm.expectRevert();
        senior.deposit(100e18, bob);
    }

    function test_depositUSDC_wrapsAndMints() public {
        uint256 expectedShares = senior.previewDeposit(100e18);
        vm.prank(alice);
        uint256 shares = senior.depositUSDC(100e6, alice);
        assertEq(shares, expectedShares);
        assertEq(senior.totalAssets(), 100e18);
        assertEq(hs.balanceOf(address(senior)), 100e18);
        assertEq(usdc.balanceOf(address(senior)), 0);
        assertEq(usdc.balanceOf(alice), 900e6);
    }

    function test_depositUSDC_zero_reverts() public {
        vm.prank(alice);
        vm.expectRevert(TrancheVault.ZeroAmount.selector);
        senior.depositUSDC(0, alice);
    }

    function test_depositUSDC_cap_reverts() public {
        senior.setMaxTotalAssets(50e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TrancheVault.DepositCapExceeded.selector, 100e18, 50e18));
        senior.depositUSDC(100e6, alice);
    }

    function test_deposit_paused_reverts() public {
        senior.setDepositsPaused(true);
        assertEq(senior.maxDeposit(alice), 0);
        vm.prank(alice);
        vm.expectRevert();
        senior.depositUSDC(100e6, alice);
    }

    function test_setDepositsPaused_unauthorized_reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TrancheVault.NotOwnerOrGuardian.selector, alice));
        senior.setDepositsPaused(true);
    }

    function test_setMaxTotalAssets_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TrancheVault.NotOwner.selector, alice));
        senior.setMaxTotalAssets(1e18);
    }

    function test_redeemFlow_requestFulfillClaim() public {
        uint256 shares = _depositSeniorShares(100e18);

        vm.prank(alice);
        senior.requestRedeem(shares, alice, alice);
        assertEq(senior.pendingRedeemRequest(0, alice), shares);
        assertEq(senior.balanceOf(alice), 0);

        uint256 assets = senior.convertToAssets(shares);
        vm.prank(accountant);
        senior.fulfillRedeem(shares, assets, alice);
        assertEq(senior.pendingRedeemRequest(0, alice), 0);
        assertEq(senior.claimableRedeemRequest(0, alice), shares);
        assertEq(senior.maxRedeem(alice), shares);
        assertEq(senior.maxWithdraw(alice), assets);

        uint256 before = hs.balanceOf(alice);
        vm.prank(alice);
        uint256 got = senior.redeem(shares, alice, alice);
        assertEq(got, assets);
        assertEq(hs.balanceOf(alice), before + assets);
        assertEq(senior.maxRedeem(alice), 0);
    }

    function test_fulfillRedeem_onlyAccountant() public {
        uint256 shares = _depositSeniorShares(100e18);
        vm.prank(alice);
        senior.requestRedeem(shares, alice, alice);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TrancheVault.NotAccountant.selector, alice));
        senior.fulfillRedeem(shares, shares, alice);
    }

    function test_rateLockedAtFulfillment() public {
        uint256 shares = _depositSeniorShares(100e18);
        vm.prank(alice);
        senior.requestRedeem(shares, alice, alice);

        uint256 assets = senior.convertToAssets(shares);
        vm.prank(accountant);
        senior.fulfillRedeem(shares, assets, alice);

        hs.mint(address(senior), 50e18);

        assertEq(senior.maxWithdraw(alice), assets);
        vm.prank(alice);
        uint256 got = senior.redeem(shares, alice, alice);
        assertEq(got, assets);
    }

    function test_claimAndUnwrapUSDC() public {
        vm.prank(alice);
        uint256 shares = senior.depositUSDC(100e6, alice);
        vm.prank(alice);
        senior.requestRedeem(shares, alice, alice);
        uint256 assets = senior.convertToAssets(shares);
        vm.prank(accountant);
        senior.fulfillRedeem(shares, assets, alice);

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        uint256 usdcOut = senior.claimAndUnwrapUSDC(shares, alice, alice);
        assertApproxEqRel(usdcOut, 100e6, 1e15);
        assertEq(usdc.balanceOf(alice), before + usdcOut);
        assertApproxEqAbs(senior.totalAssets(), 0, 2e15);
    }

    function test_partialRedeemClaim() public {
        uint256 shares = _depositSeniorShares(100e18);
        vm.prank(alice);
        senior.requestRedeem(shares, alice, alice);

        uint256 assets = senior.convertToAssets(shares);
        uint256 halfShares = shares / 2;
        uint256 halfAssets = assets / 2;
        vm.prank(accountant);
        senior.fulfillRedeem(halfShares, halfAssets, alice);

        assertEq(senior.claimableRedeemRequest(0, alice), halfShares);
        assertEq(senior.pendingRedeemRequest(0, alice), shares - halfShares);

        vm.prank(alice);
        uint256 got = senior.redeem(halfShares, alice, alice);
        assertEq(got, halfAssets);
    }

    function test_moveShares_onlyAccountant() public {
        _depositSeniorShares(100e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TrancheVault.NotAccountant.selector, alice));
        senior.moveShares(address(junior), 40e18);
    }

    function test_moveShares_movesBalance() public {
        _depositSeniorShares(100e18);
        vm.prank(accountant);
        senior.moveShares(address(junior), 40e18);
        assertEq(hs.balanceOf(address(senior)), 60e18);
        assertEq(hs.balanceOf(address(junior)), 40e18);
    }

    function test_operator_canRequestRedeem() public {
        uint256 shares = _depositSeniorShares(100e18);
        vm.prank(alice);
        senior.setOperator(bob, true);
        assertTrue(senior.isOperator(alice, bob));

        vm.prank(bob);
        senior.requestRedeem(shares, alice, alice);
        assertEq(senior.pendingRedeemRequest(0, alice), shares);
    }

    function test_operator_notApproved_reverts() public {
        uint256 shares = _depositSeniorShares(100e18);
        vm.prank(bob);
        vm.expectRevert();
        senior.requestRedeem(shares, alice, alice);
    }

    function test_setAccountant_onlyOwner() public {
        assertEq(senior.accountant(), accountant);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TrancheVault.NotOwner.selector, alice));
        senior.setAccountant(bob);

        senior.setAccountant(bob);
        assertEq(senior.accountant(), bob);
    }

    function test_transferOwnership_updatesGuardianSeparately() public {
        senior.transferOwnership(alice);
        assertEq(senior.owner(), address(this));
        assertEq(senior.pendingOwner(), alice);
        vm.prank(alice);
        senior.acceptOwnership();
        assertEq(senior.owner(), alice);
        assertEq(senior.guardian(), address(this));
    }

    function test_maxMint_reflectsCap() public {
        senior.setMaxTotalAssets(100e18);
        assertEq(senior.maxMint(alice), senior.convertToShares(100e18));
        _depositSeniorShares(40e18);
        assertEq(senior.maxMint(alice), senior.convertToShares(60e18));
    }

    function _juniorRedeemFlow(uint256 amountUsdc) internal returns (uint256 shares, uint256 assets) {
        vm.prank(bob);
        shares = junior.depositUSDC(amountUsdc, bob);
        vm.prank(bob);
        junior.requestRedeem(shares, bob, bob);
        assets = junior.convertToAssets(shares);
        vm.prank(accountant);
        junior.fulfillRedeem(shares, assets, bob);
    }

    function test_claimAndUnwrapEquity_junior() public {
        (uint256 shares,) = _juniorRedeemFlow(100e6);

        uint256 before = nvda.balanceOf(bob);
        vm.prank(bob);
        uint256 nvdaOut = junior.claimAndUnwrapEquity(shares, bob, bob);
        assertGt(nvdaOut, 0);
        assertEq(nvda.balanceOf(bob), before + nvdaOut);
        assertEq(junior.maxRedeem(bob), 0);
    }

    function test_claimAndUnwrapEquity_minOut_reverts() public {
        (uint256 shares, uint256 assets) = _juniorRedeemFlow(100e6);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(MockHookShare.SlippageExceeded.selector, assets, assets + 1));
        junior.claimAndUnwrapEquity(shares, bob, bob, assets + 1);
    }

    function test_claimAndUnwrapEquity_senior_reverts() public {
        vm.prank(alice);
        vm.expectRevert(TrancheVault.SeniorUsdcOnly.selector);
        senior.claimAndUnwrapEquity(1e18, alice, alice);
    }

    function test_claimAndUnwrapProportional_junior() public {
        (uint256 shares,) = _juniorRedeemFlow(100e6);

        uint256 usdcBefore = usdc.balanceOf(bob);
        uint256 nvdaBefore = nvda.balanceOf(bob);
        vm.prank(bob);
        (uint256 usdcOut, uint256 nvdaOut) = junior.claimAndUnwrapProportional(shares, bob, bob);
        assertGt(usdcOut, 0);
        assertGt(nvdaOut, 0);
        assertEq(usdc.balanceOf(bob), usdcBefore + usdcOut);
        assertEq(nvda.balanceOf(bob), nvdaBefore + nvdaOut);
    }

    function test_claimAndUnwrapProportional_senior_reverts() public {
        vm.prank(alice);
        vm.expectRevert(TrancheVault.SeniorUsdcOnly.selector);
        senior.claimAndUnwrapProportional(1e18, alice, alice);
    }
}
