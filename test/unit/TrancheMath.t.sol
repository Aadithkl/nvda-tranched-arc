// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IHookSharePipe } from "../../src/interfaces/IHookSharePipe.sol";
import { JuniorVault } from "../../src/vaults/JuniorVault.sol";
import { SeniorVault } from "../../src/vaults/SeniorVault.sol";
import { MockAccountant } from "../../src/test-only/MockAccountant.sol";
import { MockHookShare } from "../../src/test-only/MockHookShare.sol";
import { TestToken } from "../../src/test-only/TestToken.sol";

contract TrancheMathTest is Test {
    uint256 internal constant DEPOSIT = 100e18;

    TestToken internal usdc;
    TestToken internal nvda;
    MockHookShare internal hs;
    SeniorVault internal senior;
    JuniorVault internal junior;
    MockAccountant internal accountant;

    address internal alice;
    address internal bob;
    uint256 internal aliceShares;
    uint256 internal bobShares;

    function setUp() public {
        alice = makeAddr("alice");
        bob = makeAddr("bob");

        usdc = new TestToken("USD Coin", "mUSDC", 6);
        nvda = new TestToken("NVIDIA", "mNVDA", 18);
        hs = new MockHookShare(IERC20(address(usdc)), makeAddr("hook"));
        senior = new SeniorVault(
            IERC20(address(hs)),
            IERC20(address(usdc)),
            IERC20(address(nvda)),
            IHookSharePipe(address(hs)),
            address(this),
            address(0),
            0
        );
        junior = new JuniorVault(
            IERC20(address(hs)),
            IERC20(address(usdc)),
            IERC20(address(nvda)),
            IHookSharePipe(address(hs)),
            address(this),
            address(0),
            0
        );

        accountant = new MockAccountant(address(senior), address(junior));
        senior.setAccountant(address(accountant));
        junior.setAccountant(address(accountant));

        hs.mint(alice, 1_000e18);
        hs.mint(bob, 1_000e18);
        vm.prank(alice);
        hs.approve(address(senior), type(uint256).max);
        vm.prank(bob);
        hs.approve(address(junior), type(uint256).max);

        vm.prank(alice);
        aliceShares = senior.deposit(DEPOSIT, alice);
        vm.prank(bob);
        bobShares = junior.deposit(DEPOSIT, bob);
    }

    function test_baseline_escrowMovePegsClaims() public {
        accountant.setClaims(105e18, 95e18);
        accountant.moveShares(junior, address(senior), 5e18);

        assertEq(senior.totalAssets(), 105e18);
        assertEq(junior.totalAssets(), 95e18);
        assertApproxEqAbs(senior.convertToAssets(aliceShares), 105e18, 2);
        assertApproxEqAbs(junior.convertToAssets(bobShares), 95e18, 2);
    }

    function test_poolUp20_seniorCapped_juniorLevered() public {
        accountant.setClaims(105e18, 135e18);
        accountant.moveShares(junior, address(senior), 5e18);
        hs.mint(address(junior), 40e18);

        assertEq(senior.totalAssets(), 105e18);
        assertEq(junior.totalAssets(), 135e18);
        assertApproxEqAbs(senior.convertToAssets(aliceShares), 105e18, 2);
        assertApproxEqAbs(junior.convertToAssets(bobShares), 135e18, 2);
    }

    function test_poolDown20_seniorProtected_juniorLeveredLoss() public {
        accountant.setClaims(105e18, 55e18);
        accountant.moveShares(junior, address(senior), 5e18);
        hs.burn(address(junior), 40e18);

        assertEq(senior.totalAssets(), 105e18);
        assertEq(junior.totalAssets(), 55e18);
        assertApproxEqAbs(senior.convertToAssets(aliceShares), 105e18, 2);
        assertApproxEqAbs(junior.convertToAssets(bobShares), 55e18, 2);
    }

    function test_seniorHaircut_juniorWiped() public {
        accountant.setClaims(100e18, 0);
        accountant.moveShares(junior, address(senior), 100e18);
        hs.burn(address(senior), 100e18);

        assertEq(senior.totalAssets(), 100e18);
        assertEq(junior.totalAssets(), 0);
        assertApproxEqAbs(senior.convertToAssets(aliceShares), 100e18, 2);
        assertEq(junior.convertToAssets(bobShares), 0);
    }

    function test_shareConservation() public {
        accountant.setClaims(105e18, 95e18);
        accountant.moveShares(junior, address(senior), 5e18);

        assertEq(hs.balanceOf(address(senior)) + hs.balanceOf(address(junior)), 2 * DEPOSIT);
        assertEq(senior.totalAssets() + junior.totalAssets(), 2 * DEPOSIT);
    }

    function test_poolValue_isClaimSum() public {
        accountant.setClaims(105e18, 95e18);
        assertEq(accountant.poolValue(), 200e18);
    }
}
