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
import { RegimeVault } from "../../src/vaults/RegimeVault.sol";
import { VaultStrategyController } from "../../src/strategy/VaultStrategyController.sol";
import { VaultStrategyAgent } from "../../src/strategy/VaultStrategyAgent.sol";

contract VaultStrategyTest is Test {
    using PoolIdLibrary for PoolKey;

    IPoolManager internal manager;
    PoolGuardSimulator internal simulator;
    PoolGuardHook internal hook;
    RegimeVault internal vault;
    NVDAPriceOracle internal oracle;
    TestToken internal usdc;
    TestToken internal nvda;

    VaultStrategyController internal controller;
    VaultStrategyAgent internal agentContract;

    PoolKey internal key;
    address internal agent = makeAddr("agent");
    address internal operator = makeAddr("operator");
    int24 internal initialTick;

    function setUp() public {
        manager = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        simulator = new PoolGuardSimulator();
        usdc = new TestToken("USD Coin", "mUSDC", 6);
        nvda = new TestToken("NVIDIA", "mNVDA", 18);

        oracle = new NVDAPriceOracle(8, address(this));
        oracle.setWriter(address(this), true);
        oracle.setMaxStaleness(1 hours);
        oracle.updatePrice(200e8, 2, uint32(block.timestamp), bytes32(0));

        address token0 = address(usdc) < address(nvda) ? address(usdc) : address(nvda);
        address token1 = token0 == address(usdc) ? address(nvda) : address(usdc);
        initialTick = token0 == address(usdc) ? int24(196260) : int24(-196260);

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

        vault = new RegimeVault(
            manager, hook, key, IERC20(address(usdc)), IERC20(address(nvda)), address(oracle), 0, address(this)
        );
        hook.setVault(address(vault));
        hook.transferOwnership(address(vault));
        vault.acceptHookOwnership();
        vault.setGuardParams(_defaultParams());

        usdc.mint(address(vault), 1_000_000e6);
        nvda.mint(address(vault), 100e18);
        vault.fundHook(40e6, 1e18);
        vault.initializeHook(key, TickMath.getSqrtPriceAtTick(initialTick));
        oracle.updatePrice(int192(int256(hook.poolPrice1e18() / 1e10)), 2, uint32(block.timestamp), bytes32(0));

        controller = new VaultStrategyController(address(this));
        controller.setVault(address(vault));
        controller.setAgent(agent, true);
        vault.setKeeper(address(controller));

        agentContract = new VaultStrategyAgent(address(this), operator, address(controller));
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

    // ------------------------------------------------------------------
    // Guard params
    // ------------------------------------------------------------------

    function test_submitGuardParams_withinBounds() public {
        GuardParams.Params memory p = _defaultParams();
        p.minEvBps = 1;
        p.guardTickWidth = 900;

        vm.prank(agent);
        controller.submitGuardParams(p);

        GuardParams.Params memory onchain = hook.guardParams();
        assertEq(onchain.minEvBps, 1);
        assertEq(onchain.guardTickWidth, 900);
    }

    function test_submitGuardParams_outOfBounds_reverts() public {
        GuardParams.Params memory p = _defaultParams();

        p.guardTickWidth = 3_001;
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(VaultStrategyController.GuardWidthTooLarge.selector, int24(3_001), int24(3_000))
        );
        controller.submitGuardParams(p);

        p = _defaultParams();
        p.baseTickWidth = 30_001;
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(VaultStrategyController.BaseWidthTooLarge.selector, int24(30_001), int24(30_000))
        );
        controller.submitGuardParams(p);

        p = _defaultParams();
        p.guardLiquidity = 5_000e12 + 1;
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(
                VaultStrategyController.GuardLiquidityTooLarge.selector, uint128(5_000e12 + 1), uint128(5_000e12)
            )
        );
        controller.submitGuardParams(p);

        p = _defaultParams();
        p.minEvBps = 101;
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(VaultStrategyController.MinEvTooHigh.selector, uint16(101), uint16(100)));
        controller.submitGuardParams(p);

        p = _defaultParams();
        p.recheckInterval = 59;
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(
                VaultStrategyController.RecheckIntervalOutOfRange.selector, uint32(59), uint32(60), uint32(3_600)
            )
        );
        controller.submitGuardParams(p);
    }

    function test_submitGuardParams_nonAgent_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(VaultStrategyController.NotAgent.selector, address(this)));
        controller.submitGuardParams(_defaultParams());
    }

    // ------------------------------------------------------------------
    // Recenter / deploy enable / recall / fund
    // ------------------------------------------------------------------

    function test_submitRecenter_cooldown() public {
        vm.prank(agent);
        controller.submitRecenter();
        assertTrue(hook.guardPresent());

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(VaultStrategyController.RecenterCooldownActive.selector, block.timestamp + 60)
        );
        controller.submitRecenter();

        vm.warp(block.timestamp + 60);
        vm.prank(agent);
        controller.submitRecenter();
        assertTrue(hook.guardPresent());
    }

    function test_paused_semantics() public {
        controller.setPaused(true);

        vm.prank(agent);
        vm.expectRevert(VaultStrategyController.IsPaused.selector);
        controller.submitDeployEnabled(true);

        vm.prank(agent);
        controller.submitDeployEnabled(false);
        assertFalse(hook.deployEnabled());

        vm.prank(agent);
        controller.submitRecall();
        assertFalse(hook.guardPresent());

        vm.prank(agent);
        vm.expectRevert(VaultStrategyController.IsPaused.selector);
        controller.submitRecenter();

        vm.prank(agent);
        vm.expectRevert(VaultStrategyController.IsPaused.selector);
        controller.submitFund(1e6, 0);
    }

    function test_submitFund_bounds() public {
        uint256 hookBefore = usdc.balanceOf(address(hook));

        vm.prank(agent);
        controller.submitFund(200e6, 0);
        assertEq(usdc.balanceOf(address(hook)), hookBefore + 200e6);

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(
                VaultStrategyController.FundTooLarge.selector, uint256(100_000e6 + 1), uint256(100_000e6)
            )
        );
        controller.submitFund(100_000e6 + 1, 0);
    }

    function test_submitRecall_pullsGuardToVault() public {
        assertTrue(hook.guardPresent());
        uint256 vaultBefore = usdc.balanceOf(address(vault));

        vm.prank(agent);
        controller.submitRecall();

        assertFalse(hook.guardPresent());
        assertGt(usdc.balanceOf(address(vault)), vaultBefore);
        assertFalse(hook.exited());
    }

    // ------------------------------------------------------------------
    // Rebalance bounds
    // ------------------------------------------------------------------

    function test_submitRebalance_cap() public {
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(
                VaultStrategyController.RebalanceTooLarge.selector, uint256(10_000e6 + 1), uint256(10_000e6)
            )
        );
        controller.submitRebalance(false, 10_000e6 + 1, 0, block.timestamp + 60);

        vm.prank(agent);
        vm.expectRevert();
        controller.submitRebalance(false, 1e6, 0, block.timestamp + 60);
    }

    // ------------------------------------------------------------------
    // Agent contract (operator key)
    // ------------------------------------------------------------------

    function test_agentContract_operatorGated() public {
        controller.setAgent(address(agentContract), true);
        controller.setPaused(true);

        vm.prank(operator);
        agentContract.submitRecall();
        assertFalse(hook.guardPresent());

        vm.expectRevert(abi.encodeWithSelector(VaultStrategyAgent.NotOperator.selector, address(this)));
        agentContract.submitRecall();
    }

    function test_agentContract_paramsRoundTrip() public {
        controller.setAgent(address(agentContract), true);

        vm.prank(operator);
        agentContract.submitRecenter();
        assertTrue(hook.guardPresent());
    }
}
