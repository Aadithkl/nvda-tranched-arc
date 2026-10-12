// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";
import { IPoolManager } from "v4-core/src/interfaces/IPoolManager.sol";
import { IHooks } from "v4-core/src/interfaces/IHooks.sol";
import { PoolKey } from "v4-core/src/types/PoolKey.sol";
import { PoolIdLibrary } from "v4-core/src/types/PoolId.sol";
import { Currency } from "v4-core/src/types/Currency.sol";
import { Hooks } from "v4-core/src/libraries/Hooks.sol";
import { TickMath } from "v4-core/src/libraries/TickMath.sol";
import { HookMiner } from "v4-periphery/test/shared/HookMiner.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { TestToken } from "../../src/test-only/TestToken.sol";
import { NVDAPriceOracle } from "../../src/oracle/NVDAPriceOracle.sol";
import { PoolGuardHook } from "../../src/hook/PoolGuardHook.sol";
import { DualBookHub } from "../../src/hook/DualBookHub.sol";
import { PoolGuardSimulator } from "../../src/hook/PoolGuardSimulator.sol";
import { IPoolGuardSimulator } from "../../src/interfaces/IPoolGuardSimulator.sol";
import { GuardParams } from "../../src/hook/libraries/GuardParams.sol";
import { LedgerVault } from "../../src/vaults/LedgerVault.sol";
import { IBookHook } from "../../src/interfaces/IBookHook.sol";
import { VaultStrategyController } from "../../src/strategy/VaultStrategyController.sol";

/// @notice Deploys a hook from a non-test address so HookMiner finds a second valid slot.
contract DualBookHookDeployer {
    function deploy(
        bytes32 salt,
        IPoolManager manager,
        IPoolGuardSimulator simulator,
        address oracle,
        address equity,
        address vault,
        address owner
    ) external returns (PoolGuardHook) {
        return new PoolGuardHook{ salt: salt }(manager, simulator, oracle, equity, vault, owner);
    }
}

contract DualBookTest is Test {
    using PoolIdLibrary for PoolKey;

    IPoolManager internal manager;
    PoolGuardSimulator internal simulator;
    PoolGuardHook internal bookA;
    PoolGuardHook internal bookB;
    DualBookHub internal hub;
    LedgerVault internal vault;
    NVDAPriceOracle internal oracle;
    TestToken internal quote;
    TestToken internal nvda;

    VaultStrategyController internal controller;
    DualBookHookDeployer internal deployer;

    PoolKey internal keyA;
    PoolKey internal keyB;
    address internal agent = makeAddr("agent");
    int24 internal initialTick;

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
        initialTick = token0 == address(quote) ? int24(196260) : int24(-196260);

        uint160 flags = uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG);
        bytes memory args = abi.encode(manager, simulator, address(oracle), address(nvda), address(0), address(this));
        (address expectedA, bytes32 saltA) =
            HookMiner.find(address(this), flags, type(PoolGuardHook).creationCode, args);
        bookA = new PoolGuardHook{ salt: saltA }(
            manager, simulator, address(oracle), address(nvda), address(0), address(this)
        );
        assertEq(address(bookA), expectedA);

        deployer = new DualBookHookDeployer();
        (address expectedB, bytes32 saltB) =
            HookMiner.find(address(deployer), flags, type(PoolGuardHook).creationCode, args);
        bookB = deployer.deploy(
            saltB,
            manager,
            IPoolGuardSimulator(address(simulator)),
            address(oracle),
            address(nvda),
            address(0),
            address(this)
        );
        assertEq(address(bookB), expectedB);
        assertTrue(address(bookA) != address(bookB));

        keyA = PoolKey({
            currency0: Currency.wrap(token0),
            currency1: Currency.wrap(token1),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(bookA))
        });
        keyB = PoolKey({
            currency0: Currency.wrap(token0),
            currency1: Currency.wrap(token1),
            fee: 10000,
            tickSpacing: 200,
            hooks: IHooks(address(bookB))
        });

        // Stage guard params on EACH book before handing ownership to the hub (deploy flow).
        bookA.setGuardParams(_defaultParams());
        bookB.setGuardParams(_defaultParams());

        hub = new DualBookHub(
            manager,
            bookA,
            bookB,
            keyA,
            keyB,
            IERC20(address(quote)),
            IERC20(address(nvda)),
            address(this),
            address(this)
        );
        bookA.setVault(address(hub));
        bookB.setVault(address(hub));
        bookA.transferOwnership(address(hub));
        bookB.transferOwnership(address(hub));
        hub.acceptHookOwnership();

        controller = new VaultStrategyController(address(this));
        vault = new LedgerVault(
            manager,
            IBookHook(address(hub)),
            keyA,
            IERC20(address(quote)),
            IERC20(address(nvda)),
            address(oracle),
            0,
            address(this)
        );
        controller.setVault(address(vault));
        controller.setAgent(agent, true);
        controller.setBooks(address(bookA), address(bookB));
        controller.setHub(address(hub));

        hub.setKeeper(address(controller));
        hub.setVault(address(vault));
        hub.transferOwnership(address(vault));

        // Both books are initialized armed (base + guard) at deploy: the active book
        // from vault funding via the hub, the inactive book from direct staging funds
        // (mirrors the deploy script). Switching never touches deploy flags.
        quote.mint(address(vault), 1_000_000e6);
        nvda.mint(address(vault), 100e18);
        quote.mint(address(bookB), 40e6);
        nvda.mint(address(bookB), 1e18);
        vault.fundHook(40e6, 1e18);
        vm.prank(address(controller));
        hub.pushToActive();
        vault.initializeHook(keyA, TickMath.getSqrtPriceAtTick(initialTick));
        vault.initializeHook(keyB, TickMath.getSqrtPriceAtTick(initialTick));
        oracle.updatePrice(int192(int256(bookA.poolPrice1e18() / 1e10)), 2, uint32(block.timestamp), bytes32(0));

        vault.setKeeper(address(controller));
    }

    function _defaultParams() internal pure returns (GuardParams.Params memory) {
        return GuardParams.Params({
            guardTickWidth: 600,
            baseTickWidth: 6000,
            guardLiquidity: 5e11,
            baseLiquidity: 1e11,
            minEvBps: 0,
            recheckMaxDeviationBps: 50,
            recheckInterval: 300,
            maxPriceAge: 300,
            allowedSessionsMask: 0
        });
    }

    function _refreshOracle() internal {
        oracle.updatePrice(int192(int256(bookA.poolPrice1e18() / 1e10)), 2, uint32(block.timestamp), bytes32(0));
    }

    // ------------------------------------------------------------------
    // Migration
    // ------------------------------------------------------------------

    function test_switchAtoB_atomicMigration() public {
        assertTrue(bookA.guardPresent());
        (,, uint128 liqBefore) = bookA.guardPosition();
        assertTrue(liqBefore > 0);

        vm.prank(agent);
        controller.submitSwitchBook(1);

        assertEq(controller.activeBook(), 1);
        assertEq(hub.activeBook(), 1);
        assertTrue(bookA.exited());
        assertFalse(bookB.exited());
        assertTrue(bookB.guardPresent());
        (,, uint128 liqAfter) = bookB.guardPosition();
        assertTrue(liqAfter > 0);
        // Nothing stranded mid-custody: vault fully pushed, hub holds nothing between txs.
        assertEq(quote.balanceOf(address(vault)), 0);
        assertEq(nvda.balanceOf(address(vault)), 0);
        assertEq(quote.balanceOf(address(hub)), 0);
        assertEq(nvda.balanceOf(address(hub)), 0);
    }

    function test_switchRoundTrip_rearmsPulledBook() public {
        vm.prank(agent);
        controller.submitSwitchBook(1);

        vm.warp(block.timestamp + 1 hours + 1);
        _refreshOracle();
        vm.prank(agent);
        controller.submitSwitchBook(0);

        assertEq(controller.activeBook(), 0);
        assertEq(hub.activeBook(), 0);
        assertTrue(bookB.exited());
        assertFalse(bookA.exited());
        assertTrue(bookA.guardPresent());
        (,, uint128 liq) = bookA.guardPosition();
        assertTrue(liq > 0);
        assertEq(quote.balanceOf(address(hub)), 0);
        assertEq(nvda.balanceOf(address(hub)), 0);
    }

    function test_switchGuards_sameBookAndDwell() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(VaultStrategyController.SameBook.selector, 0));
        controller.submitSwitchBook(0);

        vm.prank(agent);
        controller.submitSwitchBook(1);

        _refreshOracle();
        vm.prank(agent);
        vm.expectRevert();
        controller.submitSwitchBook(0);
    }

    // ------------------------------------------------------------------
    // Custody: recall / halt sweep to the real vault, never strand in hub
    // ------------------------------------------------------------------

    function test_recallSweepsBothBooksToVault() public {
        uint256 qBefore = quote.balanceOf(address(vault));
        uint256 eBefore = nvda.balanceOf(address(vault));

        vm.prank(agent);
        controller.submitRecall();

        // Guards pulled on both books, everything idle swept to the vault (bases stay
        // deployed — that is the documented recall semantic). Nothing strands in hub.
        assertFalse(bookA.guardPresent());
        assertFalse(bookB.guardPresent());
        assertTrue(quote.balanceOf(address(vault)) > qBefore);
        assertTrue(nvda.balanceOf(address(vault)) > eBefore);
        assertEq(quote.balanceOf(address(hub)), 0);
        assertEq(nvda.balanceOf(address(hub)), 0);
        assertEq(hub.quoteIdle(), 0);
        assertEq(hub.equityIdle(), 0);
    }

    function test_haltAfterMigration_isIdempotent() public {
        vm.prank(agent);
        controller.submitSwitchBook(1);

        vault.exitHook();
        assertTrue(hub.exited());
        uint256 qBal = quote.balanceOf(address(vault));
        uint256 eBal = nvda.balanceOf(address(vault));
        assertTrue(qBal > 0 && eBal > 0);
        assertEq(quote.balanceOf(address(hub)), 0);

        // Second halt is a no-op, not a revert (from-book already exited is skipped).
        vault.exitHook();
        assertEq(quote.balanceOf(address(vault)), qBal);
        assertEq(nvda.balanceOf(address(vault)), eBal);
    }

    // ------------------------------------------------------------------
    // Active routing
    // ------------------------------------------------------------------

    function test_guardParams_routeToActiveBook() public {
        GuardParams.Params memory p = _defaultParams();
        p.minEvBps = 7;

        vm.prank(agent);
        controller.submitGuardParams(p);
        assertEq(bookA.guardParams().minEvBps, 7);
        assertEq(bookB.guardParams().minEvBps, 0);

        vm.prank(agent);
        controller.submitSwitchBook(1);

        p.minEvBps = 9;
        vm.prank(agent);
        controller.submitGuardParams(p);
        assertEq(bookB.guardParams().minEvBps, 9);
        assertEq(bookA.guardParams().minEvBps, 7);
    }

    function test_views_aggregateBothBooks() public {
        assertEq(hub.quoteIdle(), bookA.quoteIdle() + bookB.quoteIdle());
        assertEq(hub.equityIdle(), bookA.equityIdle() + bookB.equityIdle());
        assertEq(hub.claims(address(quote)), bookA.claims(address(quote)) + bookB.claims(address(quote)));
    }
}
