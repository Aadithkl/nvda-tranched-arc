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
import { VaultStrategyController } from "../../src/strategy/VaultStrategyController.sol";
import { VaultStrategyAgent } from "../../src/strategy/VaultStrategyAgent.sol";

/// @notice Depeg heartbeat latch, hook price-recheck gate, and base/liquidity
///         floor clamps introduced for the doorbell-base + regime-router plan.
contract DepegHeartbeatTest is Test {
    using PoolIdLibrary for PoolKey;

    IPoolManager internal manager;
    PoolGuardSimulator internal simulator;
    PoolGuardHook internal hook;
    LedgerVault internal vault;
    NVDAPriceOracle internal oracle;
    TestToken internal quote;
    TestToken internal nvda;
    VaultStrategyController internal controller;
    PoolKey internal key;
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

        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
                | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
        );
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
            manager, hook, key, IERC20(address(quote)), IERC20(address(nvda)), address(oracle), 0, address(this)
        );
        hook.setVault(address(vault));
        hook.transferOwnership(address(vault));
        vault.acceptHookOwnership();

        GuardParams.Params memory open = _params();
        open.recheckMaxDeviationBps = 0;
        vault.setGuardParams(open);

        quote.mint(address(vault), 1_000_000e6);
        nvda.mint(address(vault), 100e18);
        vault.fundHook(40e6, 1e18);
        vault.initializeHook(key, TickMath.getSqrtPriceAtTick(initialTick));
        oracle.updatePrice(int192(int256(hook.poolPrice1e18() / 1e10)), 2, uint32(block.timestamp), bytes32(0));
        vault.setGuardParams(_params());

        controller = new VaultStrategyController(address(this));
        controller.setVault(address(vault));
        controller.setAgent(agent, true);
        // Keeper stays unset (owner acts) until controller-relay tests set it.
    }

    function _params() internal pure returns (GuardParams.Params memory) {
        return GuardParams.Params({
            guardTickWidth: 600,
            baseTickWidth: 6000,
            guardLiquidity: 5e11,
            baseLiquidity: 1e11,
            minEvBps: 0,
            recheckMaxDeviationBps: 200,
            recheckInterval: 300,
            maxPriceAge: 300,
            allowedSessionsMask: 0
        });
    }

    function _pushOracleOffPeg() internal {
        // ~10% above pool price => ~1000bps deviation, over the 200bps gate.
        uint256 poolUsd = hook.poolPrice1e18();
        oracle.updatePrice(int192(int256(poolUsd * 11 / 10 / 1e10)), 2, uint32(block.timestamp), bytes32(0));
    }

    // ------------------------------------------------------------------
    // Depeg latch
    // ------------------------------------------------------------------

    function test_checkDepeg_tripsAndClears() public {
        assertFalse(vault.depegPaused());
        _pushOracleOffPeg();

        bool paused_ = vault.checkDepeg();
        assertTrue(paused_);
        assertTrue(vault.depegPaused());
        assertTrue(vault.lastDepegCheck() != 0);

        // Back in band => clean read clears the latch.
        oracle.updatePrice(int192(int256(hook.poolPrice1e18() / 1e10)), 2, uint32(block.timestamp), bytes32(0));
        paused_ = vault.checkDepeg();
        assertFalse(paused_);
        assertFalse(vault.depegPaused());
    }

    function test_checkDepeg_cleanStaysClean() public {
        assertFalse(vault.checkDepeg());
        assertFalse(vault.depegPaused());
    }

    function test_resumeFromDepeg_manualOverride() public {
        _pushOracleOffPeg();
        vault.checkDepeg();
        assertTrue(vault.depegPaused());

        // Owner acts as keeper while keeper is unset.
        vault.resumeFromDepeg();
        assertFalse(vault.depegPaused());

        // Next heartbeat re-trips while still off peg.
        assertTrue(vault.checkDepeg());
    }

    function test_resumeFromDepeg_nonKeeper_reverts() public {
        vault.setKeeper(address(controller));
        _pushOracleOffPeg();
        vault.checkDepeg();
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(LedgerVault.NotKeeper.selector, agent));
        vault.resumeFromDepeg();
    }

    function test_depeg_blocksRiskPaths_keepsExitsOpen() public {
        _pushOracleOffPeg();
        vault.checkDepeg();

        vm.expectRevert(LedgerVault.IsDepegPaused.selector);
        vault.fundHook(1e6, 0);
        vm.expectRevert(LedgerVault.IsDepegPaused.selector);
        vault.deployGuard();
        vm.expectRevert(LedgerVault.IsDepegPaused.selector);
        vault.recenterGuard();
        vm.expectRevert(LedgerVault.IsDepegPaused.selector);
        vault.approveStrategy(address(quote), 1e6);
        vm.expectRevert(LedgerVault.IsDepegPaused.selector);
        vault.pullForRebalance(address(quote), 1e6);

        // De-risking stays open: recall + standing down.
        vault.recallFromHook();
        vault.setHookDeployEnabled(false);
    }

    function test_controllerRelay_blocksFund_allowsRecall() public {
        vault.setKeeper(address(controller));
        _pushOracleOffPeg();

        vm.prank(agent);
        assertTrue(controller.submitCheckDepeg());

        vm.prank(agent);
        vm.expectRevert(VaultStrategyController.DepegPaused.selector);
        controller.submitFund(1e6, 0);

        // Recall + resume relay work through the controller.
        vm.prank(agent);
        controller.submitRecall();
        vm.prank(agent);
        controller.submitResumeFromDepeg();
    }

    // ------------------------------------------------------------------
    // Hook price recheck on strict deploys
    // ------------------------------------------------------------------

    function test_deployGuard_offBand_reverts() public {
        vault.recallFromHook();
        assertFalse(hook.guardPresent());
        _pushOracleOffPeg();

        (bool ok, uint256 dev) = hook.oracleDeviationBps();
        assertTrue(ok);
        assertGt(dev, 200);

        vm.expectRevert(abi.encodeWithSelector(PoolGuardHook.GuardOffBand.selector, dev, uint16(200)));
        vault.deployGuard();
    }

    // ------------------------------------------------------------------
    // Bounds floors: base width locked at 6000, liquidity floors enforced
    // ------------------------------------------------------------------

    function test_bounds_baseWidthLockedAt6000() public {
        vault.setKeeper(address(controller));
        GuardParams.Params memory p = _params();
        p.baseTickWidth = 3000;
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(VaultStrategyController.BaseWidthTooSmall.selector, int24(3000), int24(6000))
        );
        controller.submitGuardParams(p);

        p = _params();
        p.baseTickWidth = 6001;
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(VaultStrategyController.BaseWidthTooLarge.selector, int24(6001), int24(6000))
        );
        controller.submitGuardParams(p);
    }
}
