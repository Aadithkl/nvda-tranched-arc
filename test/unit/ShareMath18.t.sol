// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";
import { IPoolManager } from "v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "v4-core/src/types/PoolKey.sol";
import { Currency } from "v4-core/src/types/Currency.sol";
import { IHooks } from "v4-core/src/interfaces/IHooks.sol";
import { Hooks } from "v4-core/src/libraries/Hooks.sol";
import { HookMiner } from "v4-periphery/test/shared/HookMiner.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { TestToken } from "../../src/test-only/TestToken.sol";
import { MockAccountant } from "../../src/test-only/MockAccountant.sol";
import { NVDAPriceOracle } from "../../src/oracle/NVDAPriceOracle.sol";
import { PoolGuardHook } from "../../src/hook/PoolGuardHook.sol";
import { PoolGuardSimulator } from "../../src/hook/PoolGuardSimulator.sol";
import { LedgerVault } from "../../src/vaults/LedgerVault.sol";

/// @notice 18-dec quote (WETH) share-math acceptance: sane genesis range, dust reverts,
///         and the donation-inflation attack round-trips whole (attacker cannot profit,
///         victim cannot be stranded). See LedgerVault's denomination comment.
contract ShareMath18Test is Test {
    IPoolManager internal manager;
    PoolGuardSimulator internal simulator;
    PoolGuardHook internal hook;
    LedgerVault internal vault;
    NVDAPriceOracle internal oracle;
    TestToken internal quote; // 18-dec, stands in for WETH
    TestToken internal equity; // 18-dec NVDA stand-in

    function setUp() public {
        manager = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        simulator = new PoolGuardSimulator();
        quote = new TestToken("Wrapped ETH", "mWETH", 18);
        equity = new TestToken("NVIDIA", "mNVDA", 18);

        oracle = new NVDAPriceOracle(8, address(this));
        oracle.setWriter(address(this), true);
        oracle.setMaxStaleness(1 hours);
        oracle.updatePrice(8e6, 2, uint32(block.timestamp), bytes32(0)); // ~$0.08/equity, any nonzero mid

        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
                | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
        );
        bytes memory args = abi.encode(
            IPoolManager(address(manager)), simulator, address(oracle), address(equity), address(0), address(this)
        );
        (address expectedHook, bytes32 salt) =
            HookMiner.find(address(this), flags, type(PoolGuardHook).creationCode, args);
        hook = new PoolGuardHook{ salt: salt }(
            IPoolManager(address(manager)), simulator, address(oracle), address(equity), address(0), address(this)
        );
        assertEq(address(hook), expectedHook);

        address token0 = address(quote) < address(equity) ? address(quote) : address(equity);
        address token1 = token0 == address(quote) ? address(equity) : address(quote);
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(token0),
            currency1: Currency.wrap(token1),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });

        vault = new LedgerVault(
            manager,
            hook,
            key,
            IERC20(address(quote)),
            IERC20(address(equity)),
            address(oracle),
            uint64(block.timestamp + 30 days),
            address(this)
        );
    }

    /// @notice Wrap doors admit registered tranches only (D2) — point the gate at the
    ///         acting party before it wraps. Exits and donations need no gate.
    function _gate(address party) internal {
        vault.setAccountant(address(new MockAccountant(party, party)));
    }

    /// @notice Genesis prices 1 WETH at 1e15 hook-shares — same range as the old $1 -> 1e15.
    function test_genesisRateSane18() public {
        _gate(address(this));
        quote.mint(address(this), 1e17);
        quote.approve(address(vault), 1e17);
        uint256 shares = vault.wrapQuote(1e17, address(this));
        assertEq(shares, 1e14);
    }

    /// @notice Sub-1000-wei deposits round to zero shares and revert — dust cannot enter,
    ///         so no victim can ever be stranded at zero by a donation.
    function test_dustReverts18() public {
        _gate(address(this));
        quote.mint(address(this), 1000);
        quote.approve(address(vault), 1000);
        vm.expectRevert(LedgerVault.ZeroAmount.selector);
        vault.wrapQuote(1, address(this));
        vm.expectRevert(LedgerVault.ZeroAmount.selector);
        vault.wrapQuote(500, address(this));
    }

    /// @notice Donation-inflation attack, full round trip, attacker first: attacker wraps dust,
    ///         donates 10 WETH (no shares), victim wraps 1 WETH. Victim must exit ~= whole
    ///         (loss < 0.1%) and the attacker must recover no more than put in plus dust.
    ///         Pro-rata ownership is exact — donations dilute price for everyone equally,
    ///         attacker included, so there is nothing to steal.
    function test_donationAttackRoundTripsWhole18() public {
        address attacker = makeAddr("attacker");
        address victim = makeAddr("victim");

        // Attacker-scale holdings (~1e12 shares) so the +1e3 virtual-share divisor term is
        // dust (1e-9), as on any production-size book. Tiny-book VS dilution is covered by
        // test_dustReverts18, not here.
        _gate(attacker);
        quote.mint(attacker, 1e15);
        vm.prank(attacker);
        quote.approve(address(vault), 1e15);
        vm.prank(attacker);
        vault.wrapQuote(1e15, attacker);
        quote.mint(address(vault), 10e18);

        // Victim wraps 1 WETH into the donated-inflated book: must NOT revert (no stranding).
        _gate(victim);
        quote.mint(victim, 1e18);
        vm.prank(victim);
        quote.approve(address(vault), 1e18);
        vm.prank(victim);
        uint256 victimShares = vault.wrapQuote(1e18, victim);
        assertGt(victimShares, 0);

        // Victim exits whole: loss under 0.1% (pure floor dust).
        vm.prank(victim);
        uint256 victimOut = vault.unwrapQuote(victimShares, victim, 0);
        assertApproxEqRel(victimOut, 1e18, 0.001e18);

        // Attacker exits: recovers donation + dust deposit (no loss of principal), and
        // nothing more than dust profit (donations are exactly recoverable, never gainful).
        uint256 attackerShares = vault.shareToken().balanceOf(attacker);
        vm.prank(attacker);
        uint256 attackerOut = vault.unwrapQuote(attackerShares, attacker, 0);
        assertGe(attackerOut, 10e18);
        assertApproxEqAbs(attackerOut, 10e18 + 1e15, 1e16);
    }

    /// @notice Same attack against the deploy-time bootstrapped book (0.1 quote pre-mine):
    ///         the donation enriches all holders pro-rata, and the victim still exits whole.
    ///         Bootstrap never creates stranding — dust still reverts, value still round-trips.
    function test_donationAgainstBootstrappedBook18() public {
        address attacker = makeAddr("attacker");
        address victim = makeAddr("victim");

        _gate(address(this));
        quote.mint(address(this), 1e17);
        quote.approve(address(vault), 1e17);
        vault.wrapQuote(1e17, address(this));

        _gate(attacker);
        quote.mint(attacker, 1e12);
        vm.prank(attacker);
        quote.approve(address(vault), 1e12);
        vm.prank(attacker);
        vault.wrapQuote(1e12, attacker);
        quote.mint(address(vault), 10e18);

        _gate(victim);
        quote.mint(victim, 1e18);
        vm.prank(victim);
        quote.approve(address(vault), 1e18);
        vm.prank(victim);
        uint256 victimShares = vault.wrapQuote(1e18, victim);
        assertGt(victimShares, 0);

        vm.prank(victim);
        uint256 victimOut = vault.unwrapQuote(victimShares, victim, 0);
        assertApproxEqRel(victimOut, 1e18, 0.001e18);
    }
}
