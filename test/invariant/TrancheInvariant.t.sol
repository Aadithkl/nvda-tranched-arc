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

contract InvariantHookValue is ITrancheHookValue {
    uint256 public rate = 1e6;

    function setRate(uint256 rate_) external {
        rate = rate_;
    }

    function convertToUsdc(uint256 shares) external view returns (uint256) {
        return Math.mulDiv(shares, rate, 1e18);
    }

    function expired() external pure returns (bool) {
        return false;
    }
}

/// @notice Randomised operation surface for the tranche stack: deposits, redeem requests,
///         keeper fulfillment, user claims, accountant rebalances and NAV moves. Every
///         successful mutation ends with `accountant.rebalance()` so the peg invariants hold
///         exactly between calls.
contract TrancheHandler is Test {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant MIN_RATE = 0.05e6;
    uint256 internal constant MAX_RATE = 2e6;

    TestToken public usdc;
    MockHookShare public hs;
    InvariantHookValue public valueSource;
    TrancheAccountant public accountant;
    SeniorVault public senior;
    JuniorVault public junior;
    address public keeper;
    address[] public users;

    constructor(
        TestToken usdc_,
        MockHookShare hs_,
        InvariantHookValue valueSource_,
        TrancheAccountant accountant_,
        SeniorVault senior_,
        JuniorVault junior_,
        address keeper_,
        address[] memory users_
    ) {
        usdc = usdc_;
        hs = hs_;
        valueSource = valueSource_;
        accountant = accountant_;
        senior = senior_;
        junior = junior_;
        keeper = keeper_;
        users = users_;
        hs.approve(address(senior), type(uint256).max);
        hs.approve(address(junior), type(uint256).max);
    }

    function _user(uint256 seed) internal view returns (address) {
        return users[bound(seed, 0, users.length - 1)];
    }

    function _vault(bool isSenior) internal view returns (TrancheVault) {
        return isSenior ? TrancheVault(address(senior)) : TrancheVault(address(junior));
    }

    function deposit(bool isSenior, uint256 userSeed, uint256 amount) external {
        address user = _user(userSeed);
        TrancheVault vault = _vault(isSenior);
        uint256 available = hs.balanceOf(user);
        if (available == 0) return;
        amount = bound(amount, 1, available);

        vm.startPrank(user);
        hs.approve(address(vault), amount);
        vault.deposit(amount, user);
        vm.stopPrank();
        _settle();
    }

    function requestRedeem(bool isSenior, uint256 userSeed, uint256 amount) external {
        address user = _user(userSeed);
        TrancheVault vault = _vault(isSenior);
        uint256 available = vault.balanceOf(user);
        if (available == 0) return;
        amount = bound(amount, 1, available);

        vm.prank(user);
        vault.requestRedeem(amount, user, user);
        _settle();
    }

    function fulfill(bool isSenior, uint256 userSeed) external {
        address user = _user(userSeed);
        TrancheVault vault = _vault(isSenior);
        if (vault.pendingRedeemRequest(0, user) == 0) return;

        vm.prank(keeper);
        accountant.fulfillRedeem(isSenior, user);
        _settle();
    }

    function claim(bool isSenior, uint256 userSeed) external {
        address user = _user(userSeed);
        TrancheVault vault = _vault(isSenior);
        uint256 claimable = vault.maxRedeem(user);
        if (claimable == 0) return;

        vm.prank(user);
        vault.redeem(claimable, user, user);
        _settle();
    }

    function rebalance() external {
        accountant.rebalance();
    }

    function moveValue(uint256 rateSeed) external {
        valueSource.setRate(bound(rateSeed, MIN_RATE, MAX_RATE));
        _settle();
    }

    function _settle() internal {
        accountant.rebalance();
    }
}

contract TrancheInvariantTest is Test {
    TestToken internal usdc;
    TestToken internal nvda;
    MockHookShare internal hs;
    InvariantHookValue internal valueSource;
    TrancheAccountant internal accountant;
    SeniorVault internal senior;
    JuniorVault internal junior;
    TrancheHandler internal handler;

    address internal keeper;
    address[] internal users;

    function setUp() public {
        keeper = makeAddr("keeper");
        users.push(makeAddr("alice"));
        users.push(makeAddr("bob"));
        users.push(makeAddr("carol"));

        usdc = new TestToken("USD Coin", "mUSDC", 6);
        nvda = new TestToken("NVIDIA", "mNVDA", 18);
        hs = new MockHookShare(usdc, address(this));
        valueSource = new InvariantHookValue();

        accountant = new TrancheAccountant(address(this));
        accountant.setHook(address(valueSource));
        accountant.setKeeper(keeper);

        senior = new SeniorVault(hs, usdc, nvda, IHookSharePipe(address(hs)), address(this), address(0), 0);
        junior = new JuniorVault(hs, usdc, nvda, IHookSharePipe(address(hs)), address(this), address(0), 0);
        accountant.setVaults(address(senior), address(junior));
        senior.setAccountant(address(accountant));
        junior.setAccountant(address(accountant));

        for (uint256 i = 0; i < users.length; ++i) {
            hs.mint(users[i], 1_000e18);
        }

        handler = new TrancheHandler(usdc, hs, valueSource, accountant, senior, junior, keeper, users);
        targetContract(address(handler));
    }

    function invariant_seniorClaimNeverExceedsPool() public view {
        assertLe(accountant.seniorClaim(), accountant.poolValue());
    }

    function invariant_claimsSumToEffectivePool() public view {
        assertEq(accountant.seniorClaim() + accountant.juniorClaim(), accountant.effectivePool());
    }

    function invariant_escrowFundedMatchesFormula() public view {
        uint256 target =
            accountant.seniorPrincipal() + Math.mulDiv(accountant.seniorPrincipal(), accountant.escrowBps(), 10_000);
        assertEq(accountant.escrowFunded(), accountant.effectivePool() >= target);
        if (!accountant.escrowFunded()) {
            assertEq(accountant.juniorClaim(), 0);
        }
    }

    /// @dev After every mutation the accountant rebalances, so each vault's hook-share balance
    ///      must equal its entitlement (claim + locked assets) share of the pool up to integer dust.
    function invariant_vaultSharesPegToClaims() public view {
        uint256 pool = accountant.poolValue();
        uint256 total = hs.balanceOf(address(senior)) + hs.balanceOf(address(junior));
        if (pool == 0 || total == 0) return;
        uint256 seniorEntitlement = accountant.seniorClaim() + valueSource.convertToUsdc(accountant.claimableSenior());
        uint256 expectedSenior = Math.mulDiv(total, seniorEntitlement, pool);
        assertApproxEqAbs(hs.balanceOf(address(senior)), expectedSenior, 1e15);
    }

    /// @dev Locked fulfilled-claim assets must always remain inside their vault.
    function invariant_lockedClaimsStayBacked() public view {
        assertLe(accountant.claimableSenior(), hs.balanceOf(address(senior)));
        assertLe(accountant.claimableJunior(), hs.balanceOf(address(junior)));
    }

    /// @dev `moveShares` and claims only transfer; no path may mint tranche-held shares.
    function invariant_noTrancheSharesMinted() public view {
        uint256 vaultShares = hs.balanceOf(address(senior)) + hs.balanceOf(address(junior));
        assertLe(vaultShares, hs.totalSupply());
    }

    /// @dev Fulfilled, unclaimed redemption assets must stay backed by hook shares in the vaults.
    function invariant_claimableRedeemsBacked() public view {
        uint256 claimable;
        for (uint256 i = 0; i < users.length; ++i) {
            claimable += senior.maxWithdraw(users[i]);
            claimable += junior.maxWithdraw(users[i]);
        }
        uint256 vaultShares = hs.balanceOf(address(senior)) + hs.balanceOf(address(junior));
        assertLe(claimable, vaultShares);
    }
}
