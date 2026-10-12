// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";
import { IPoolManager } from "v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "v4-core/src/types/PoolKey.sol";
import { PoolIdLibrary } from "v4-core/src/types/PoolId.sol";
import { Currency } from "v4-core/src/types/Currency.sol";
import { IHooks } from "v4-core/src/interfaces/IHooks.sol";
import { Hooks } from "v4-core/src/libraries/Hooks.sol";
import { TickMath } from "v4-core/src/libraries/TickMath.sol";
import { HookMiner } from "v4-periphery/test/shared/HookMiner.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { TestToken } from "../../src/test-only/TestToken.sol";
import { NVDAPriceOracle } from "../../src/oracle/NVDAPriceOracle.sol";
import { PoolGuardHook } from "../../src/hook/PoolGuardHook.sol";
import { PoolGuardSimulator } from "../../src/hook/PoolGuardSimulator.sol";
import { GuardParams } from "../../src/hook/libraries/GuardParams.sol";
import { LedgerVault } from "../../src/vaults/LedgerVault.sol";
import { LedgerEntry7575 } from "../../src/vaults/LedgerEntry7575.sol";
import { HookShareToken } from "../../src/core/HookShareToken.sol";
import { MockAccountant } from "../../src/test-only/MockAccountant.sol";

/// @notice ERC-7575 entry point (`LedgerEntry7575`) + share-token lookup/ERC-165 surface:
///         interface ids, deposit/mint/withdraw/redeem equivalence with the vault pipe, rounding,
///         owner-allowance flows, max* gating and max* honesty (redeem(maxRedeem) must succeed).
contract ERC7575EntryTest is Test {
    using PoolIdLibrary for PoolKey;

    IPoolManager internal manager;
    PoolGuardSimulator internal simulator;
    PoolGuardHook internal hook;
    LedgerVault internal vault;
    LedgerEntry7575 internal entry;
    HookShareToken internal shareToken;
    NVDAPriceOracle internal oracle;
    TestToken internal quote;
    TestToken internal nvda;

    PoolKey internal key;
    bool internal quoteIsToken0;
    uint64 internal expiry;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        manager = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        simulator = new PoolGuardSimulator();
        quote = new TestToken("USD Coin", "mUSDC", 6);
        nvda = new TestToken("NVIDIA", "mNVDA", 18);

        oracle = new NVDAPriceOracle(8, address(this));
        oracle.setWriter(address(this), true);
        oracle.setMaxStaleness(1 hours);
        oracle.updatePrice(200e8, 2, uint32(block.timestamp), bytes32(0));

        address token0 = address(quote) < address(nvda) ? address(quote) : address(nvda);
        address token1 = token0 == address(quote) ? address(nvda) : address(quote);
        quoteIsToken0 = token0 == address(quote);
        int24 initialTick = quoteIsToken0 ? int24(196260) : int24(-196260);
        expiry = uint64(block.timestamp + 30 days);

        uint160 flags = uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG);
        bytes memory args = abi.encode(manager, simulator, address(oracle), address(nvda), address(0), address(this));
        (address expectedHook, bytes32 salt) =
            HookMiner.find(address(this), flags, type(PoolGuardHook).creationCode, args);
        hook = new PoolGuardHook{ salt: salt }(
            manager, simulator, address(oracle), address(nvda), address(0), address(this)
        );
        assertEq(address(hook), expectedHook);

        key = PoolKey({
            currency0: Currency.wrap(token0),
            currency1: Currency.wrap(token1),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });

        vault = new LedgerVault(
            manager, hook, key, IERC20(address(quote)), IERC20(address(nvda)), address(oracle), expiry, address(this)
        );
        hook.setVault(address(vault));
        hook.transferOwnership(address(vault));
        vault.acceptHookOwnership();
        vault.setGuardParams(
            GuardParams.Params({
                guardTickWidth: 600,
                baseTickWidth: 6000,
                guardLiquidity: 5e11,
                baseLiquidity: 1e11,
                minEvBps: 0,
                recheckMaxDeviationBps: 50,
                recheckInterval: 300,
                maxPriceAge: 300,
                allowedSessionsMask: 0
            })
        );

        // Zero-NAV bootstrap, then fund and initialize the hook. Wrap doors admit
        // registered tranches only (D2) — gate at this test contract for seeding.
        vault.setAccountant(address(new MockAccountant(address(this), address(this))));
        quote.mint(address(this), 200e6);
        quote.approve(address(vault), type(uint256).max);
        vault.wrapQuote(100e6, address(this));
        quote.mint(address(vault), 100e6);
        nvda.mint(address(vault), 1e18);
        vault.fundHook(40e6, 1e18);
        vault.initializeHook(key, TickMath.getSqrtPriceAtTick(initialTick));
        oracle.updatePrice(int192(int256(hook.poolPrice1e18() / 1e10)), 2, uint32(block.timestamp), bytes32(0));

        shareToken = vault.shareToken();
        entry = new LedgerEntry7575(address(vault));
        vault.setShareVault(address(entry));

        quote.mint(alice, 100_000e6);
        quote.mint(bob, 100_000e6);
        vm.prank(alice);
        quote.approve(address(entry), type(uint256).max);
        vm.prank(bob);
        quote.approve(address(entry), type(uint256).max);
    }

    /// @notice Seeds hook shares straight to a user through the gated wrap door
    ///         (caller == registered tranche). Entry deposits themselves are closed (D2).
    function _seedShares(address user, uint256 amount) internal returns (uint256 shares) {
        vault.setAccountant(address(new MockAccountant(user, user)));
        quote.mint(user, amount);
        vm.startPrank(user);
        quote.approve(address(vault), amount);
        shares = vault.wrapQuote(amount, user);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // Wiring, interface ids, lookup
    // ------------------------------------------------------------------

    function test_interfaceIds_and_wiring() public view {
        assertTrue(entry.supportsInterface(0x2f0a18c5), "EIP-7575 vault id");
        assertTrue(entry.supportsInterface(0x01ffc9a7), "ERC-165 id");
        assertFalse(entry.supportsInterface(0xdeadbeef));

        assertTrue(shareToken.supportsInterface(0xf815c03d), "EIP-7575 share id");
        assertTrue(shareToken.supportsInterface(0x01ffc9a7));
        assertFalse(shareToken.supportsInterface(0xdeadbeef));

        assertEq(entry.share(), address(shareToken));
        assertEq(entry.asset(), address(quote));
        assertEq(entry.totalAssets(), vault.totalManagedAssets());
        assertEq(shareToken.vault(address(quote)), address(entry), "lookup points at the entry");
        assertEq(shareToken.vault(address(nvda)), address(0), "no equity entry registered");
    }

    function test_setShareVault_emitsUpdate() public {
        LedgerEntry7575 second = new LedgerEntry7575(address(vault));
        vm.expectEmit(true, false, false, true, address(shareToken));
        emit HookShareToken.VaultUpdate(address(quote), address(second));
        vault.setShareVault(address(second));
        assertEq(shareToken.vault(address(quote)), address(second));
    }

    // ------------------------------------------------------------------
    // Flows vs the pipe
    // ------------------------------------------------------------------

    function test_deposit_matchesPreview_andPipe() public {
        uint256 assets = 1_000e6;
        uint256 expected = entry.previewDeposit(assets);

        uint256 pipeExpected = vault.convertToShares(assets);
        assertEq(expected, pipeExpected, "preview matches the vault pipe math");

        // D2: entry deposits are closed — only registered tranches may wrap.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LedgerVault.NotTranche.selector, address(entry)));
        entry.deposit(assets, alice);
    }

    function test_mint_exactShares() public {
        uint256 shares = 1e18; // ~$32k at the bootstrap price, within alice's budget
        uint256 assets = entry.previewMint(shares);
        assertGt(assets, 0, "preview still quotes");

        // D2: entry mints are closed — only registered tranches may wrap.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LedgerVault.NotTranche.selector, address(entry)));
        entry.mint(shares, alice);
    }

    function test_redeem_matchesPreview() public {
        uint256 shares = _seedShares(alice, 1_000e6);
        uint256 half = shares / 2;
        uint256 expected = entry.previewRedeem(half);

        vm.startPrank(alice);
        shareToken.approve(address(entry), type(uint256).max);
        uint256 assets = entry.redeem(half, alice, alice);
        vm.stopPrank();

        assertEq(assets, expected, "redeem pays exactly the preview");
        assertEq(shareToken.balanceOf(alice), shares - half);
        // Seed mints fresh quote on top of the 100k (old entry-deposit flow spent it).
        assertEq(quote.balanceOf(alice), 100_000e6 + assets);
    }

    function test_withdraw_exactAssets_roundsSharesUp() public {
        uint256 shares = _seedShares(alice, 1_000e6);

        uint256 assets = 100e6;
        uint256 sharesNeeded = entry.previewWithdraw(assets);
        assertGe(sharesNeeded, vault.convertToShares(assets), "withdraw rounds shares up");

        vm.startPrank(alice);
        shareToken.approve(address(entry), type(uint256).max);
        uint256 burned = entry.withdraw(assets, alice, alice);
        vm.stopPrank();

        assertEq(burned, sharesNeeded);
        assertEq(quote.balanceOf(alice), 100_000e6 + assets, "exactly assets out");
        assertEq(shareToken.balanceOf(alice), shares - sharesNeeded);
    }

    // ------------------------------------------------------------------
    // Owner allowances (shares hop through the entry)
    // ------------------------------------------------------------------

    function test_redeemForOwner_withAllowance() public {
        uint256 shares = _seedShares(bob, 500e6);
        uint256 half = shares / 2;
        uint256 expected = entry.previewRedeem(half);

        vm.prank(bob);
        shareToken.approve(address(entry), half);

        uint256 aliceBefore = quote.balanceOf(alice);
        uint256 bobBefore = quote.balanceOf(bob);
        vm.prank(alice); // operator executes for bob; assets go to alice (receiver)
        uint256 assets = entry.redeem(half, alice, bob);

        assertEq(assets, expected);
        assertEq(quote.balanceOf(alice) - aliceBefore, assets);
        assertEq(quote.balanceOf(bob), bobBefore, "owner paid nothing");
        assertEq(shareToken.balanceOf(bob), shares - half);
        assertEq(shareToken.allowance(bob, address(entry)), 0, "allowance spent");
    }

    function test_redeemForOwner_withoutAllowance_reverts() public {
        uint256 shares = _seedShares(bob, 500e6);

        vm.prank(alice);
        vm.expectRevert();
        entry.redeem(shares / 2, alice, bob);
    }

    // ------------------------------------------------------------------
    // max* gating and honesty
    // ------------------------------------------------------------------

    function test_max_gating_expiry() public {
        assertEq(entry.maxDeposit(alice), type(uint256).max);

        vm.warp(expiry + 1);
        assertEq(entry.maxDeposit(alice), 0);
        assertEq(entry.maxMint(alice), 0);

        // D2 gate fires before the expiry gate for non-tranche callers.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LedgerVault.NotTranche.selector, address(entry)));
        entry.deposit(100e6, alice);
    }

    function test_max_gating_oracle() public {
        oracle.setMaxStaleness(1);
        vm.warp(block.timestamp + 2);

        assertEq(entry.maxDeposit(alice), 0);
        // D2 gate fires before the oracle gate for non-tranche callers.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LedgerVault.NotTranche.selector, address(entry)));
        entry.deposit(100e6, alice);
    }

    function test_maxWithdraw_honesty() public {
        uint256 shares = _seedShares(alice, 1_000e6);

        // Push the vault's idle quote into the hook so exits must use the ladder.
        uint256 idle = quote.balanceOf(address(vault));
        vault.fundHook(idle, 0);

        uint256 maxShares = entry.maxRedeem(alice);
        assertGt(maxShares, 0);
        assertLe(maxShares, shares);

        vm.startPrank(alice);
        shareToken.approve(address(entry), type(uint256).max);
        uint256 assets = entry.redeem(maxShares, alice, alice);
        vm.stopPrank();
        assertGt(assets, 0, "redeem(maxRedeem) succeeded through the ladder");

        // And withdraw(maxWithdraw) must also succeed.
        uint256 maxAssets = entry.maxWithdraw(alice);
        if (maxAssets > 0) {
            vm.startPrank(alice);
            entry.withdraw(maxAssets, alice, alice);
            vm.stopPrank();
        }
    }

    function test_maxWithdraw_cappedByBalance() public view {
        // With no balance, max* are zero regardless of book liquidity.
        assertEq(entry.maxWithdraw(alice), 0);
        assertEq(entry.maxRedeem(alice), 0);
    }
}
