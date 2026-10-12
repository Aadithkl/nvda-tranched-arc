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
import { StrategyModule } from "../../src/adapters/StrategyModule.sol";
import { ERC4626Adapter } from "../../src/adapters/ERC4626Adapter.sol";
import { MorphoLoopAdapter } from "../../src/adapters/MorphoLoopAdapter.sol";
import { IMorpho } from "../../src/adapters/IMorpho.sol";
import { MockERC4626 } from "../../src/test-only/MockERC4626.sol";
import { MockMorpho } from "../../src/test-only/MockMorpho.sol";
import { MockMorphoOracle } from "../../src/test-only/MockStrategyFakes.sol";

contract VaultStrategyTest is Test {
    using PoolIdLibrary for PoolKey;

    IPoolManager internal manager;
    PoolGuardSimulator internal simulator;
    PoolGuardHook internal hook;
    LedgerVault internal vault;
    NVDAPriceOracle internal oracle;
    TestToken internal quote;
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
        vault.setGuardParams(_defaultParams());

        quote.mint(address(vault), 1_000_000e6);
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

    /// @notice Runs a knob through the 24h timelock queue: proposes, proves early
    ///         execution reverts, warps, executes.
    function _executeKnob(bytes32 key) internal {
        (, uint64 at) = controller.pendingKnobs(key);
        vm.expectRevert(abi.encodeWithSelector(VaultStrategyController.TimelockActive.selector, at));
        controller.executeKnob(key);
        vm.warp(at);
        controller.executeKnob(key);
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
        uint256 hookBefore = quote.balanceOf(address(hook));

        vm.prank(agent);
        controller.submitFund(200e6, 0);
        assertEq(quote.balanceOf(address(hook)), hookBefore + 200e6);

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
        uint256 vaultBefore = quote.balanceOf(address(vault));

        vm.prank(agent);
        controller.submitRecall();

        assertFalse(hook.guardPresent());
        assertGt(quote.balanceOf(address(vault)), vaultBefore);
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
    // Bottom-layer strategy (Morpho module, both sleeves via quote module)
    // ------------------------------------------------------------------

    function _wireModule() internal returns (StrategyModule module, ERC4626Adapter adapter) {
        module = new StrategyModule(address(this), address(quote));
        MockERC4626 venue = new MockERC4626(address(quote));
        adapter = new ERC4626Adapter(address(module), address(venue), address(quote));
        module.setVault(address(vault));
        module.setAllocator(address(controller));
        module.setTimelock(0);
        vault.setStrategyModule(address(module));
        module.submitAdapter(address(adapter), true, false, 1_000_000e6, 10_000);
        module.executeAdapter(address(adapter));
        controller.setStrategyModule(address(module));
    }

    function test_controllerAllocate_movesToModule() public {
        (, ERC4626Adapter adapter) = _wireModule();
        vm.prank(agent);
        controller.submitAllocate(address(adapter), 500e6);
        assertEq(adapter.realAssets(), 500e6);
    }

    function test_controllerAllocate_overCap_reverts() public {
        (, ERC4626Adapter adapter) = _wireModule();
        _executeKnob(
            controller.proposeBounds(
                VaultStrategyController.Bounds({
                    maxGuardTickWidth: 3_000,
                    maxBaseTickWidth: 30_000,
                    maxGuardLiquidity: 5_000e12,
                    maxBaseLiquidity: 500e12,
                    maxMinEvBps: 100,
                    minRecheckInterval: 60,
                    maxRecheckInterval: 3_600,
                    maxRecheckMaxDeviationBps: 500,
                    maxMaxPriceAge: 900,
                    maxFundQuotePerCall: 100_000e6,
                    maxFundEquityPerCall: 1_000e18,
                    maxRebalanceSwapQuote: 10_000e6,
                    maxAllocatePerCall: 100e6,
                    maxCollateralPerCall: 1_000e18,
                    maxBorrowPerCall: 10_000e6,
                    recenterCooldown: 60,
                    rebalanceCooldown: 0
                })
            )
        );

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(VaultStrategyController.AllocateTooLarge.selector, uint256(500e6), uint256(100e6))
        );
        controller.submitAllocate(address(adapter), 500e6);
    }

    function test_controllerAllocate_unsetModule_reverts() public {
        vm.prank(agent);
        vm.expectRevert(VaultStrategyController.ModuleUnset.selector);
        controller.submitAllocate(address(0x1234), 1e6);
    }

    function test_controllerDeallocate_pausedAllowed() public {
        (, ERC4626Adapter adapter) = _wireModule();
        vm.prank(agent);
        controller.submitAllocate(address(adapter), 500e6);

        controller.setPaused(true);
        uint256 vaultBefore = quote.balanceOf(address(vault));
        vm.prank(agent);
        uint256 got = controller.submitDeallocate(address(adapter), 200e6);
        assertEq(got, 200e6);
        assertEq(quote.balanceOf(address(vault)) - vaultBefore, 200e6);
    }

    // ------------------------------------------------------------------
    // Loop sleeve via controller (NVDA collateral + borrow, bounded)
    // ------------------------------------------------------------------

    function _wireLoop() internal returns (StrategyModule module, MorphoLoopAdapter loop) {
        module = new StrategyModule(address(this), address(quote));
        MockMorpho morpho = new MockMorpho();
        MockMorphoOracle oracle = new MockMorphoOracle(2e27); // $2000 NVDA, loan 6-dec, coll 18-dec
        IMorpho.MarketParams memory params = IMorpho.MarketParams({
            loanToken: address(quote),
            collateralToken: address(nvda),
            oracle: address(oracle),
            irm: address(0),
            lltv: 0.86e18
        });
        loop = new MorphoLoopAdapter(address(module), address(morpho), params, address(quote), 6_000, 1.2e18);
        module.setVault(address(vault));
        module.setAllocator(address(controller));
        module.setSentinel(address(controller));
        module.setTimelock(0);
        vault.setStrategyModule(address(module));
        module.submitAdapter(address(loop), false, true, 1_000_000e6, 9_000);
        module.executeAdapter(address(loop));
        controller.setStrategyModule(address(module));

        // Seed the market with loan-side liquidity so the sleeve can borrow.
        quote.mint(address(this), 10_000e6);
        quote.approve(address(morpho), type(uint256).max);
        morpho.supply(params, 10_000e6, 0, address(this), "");
        nvda.mint(address(vault), 10e18);
    }

    function test_controllerLoop_openBorrowDeleverage() public {
        (, MorphoLoopAdapter loop) = _wireLoop();

        vm.prank(agent);
        controller.submitAllocateCollateral(address(loop), 1e18);
        assertGt(loop.exposure(), 0);
        assertEq(loop.debt(), 0);

        uint256 vaultBefore = quote.balanceOf(address(vault));
        vm.prank(agent);
        controller.submitBorrow(address(loop), 500e6);
        assertEq(quote.balanceOf(address(vault)) - vaultBefore, 500e6);
        assertGt(loop.debt(), 0);

        vm.prank(agent);
        controller.submitDeleverage(address(loop), 200e6, 0);
        assertLt(loop.debt(), 500e6 + 2e6);
    }

    function test_controllerLoop_caps() public {
        (, MorphoLoopAdapter loop) = _wireLoop();
        _executeKnob(controller.proposeAllocateCaps(100e18, 0.5e18, 100e6));

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(VaultStrategyController.CollateralTooLarge.selector, uint256(1e18), uint256(0.5e18))
        );
        controller.submitAllocateCollateral(address(loop), 1e18);

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(VaultStrategyController.BorrowTooLarge.selector, uint256(500e6), uint256(100e6))
        );
        controller.submitBorrow(address(loop), 500e6);
    }

    // ------------------------------------------------------------------
    // Sentinel de-risk via controller (works while paused)
    // ------------------------------------------------------------------

    function test_controllerSentinel_pausedAllowed() public {
        (StrategyModule module, ERC4626Adapter adapter) = _wireModule();
        module.setSentinel(address(controller));
        vm.prank(agent);
        controller.submitAllocate(address(adapter), 500e6);

        controller.setPaused(true);

        vm.prank(agent);
        controller.submitLowerCaps(address(adapter), 100e6, 1_000);
        (,,, uint256 abs,) = module.adapters(address(adapter));
        assertEq(abs, 100e6);

        vm.prank(agent);
        controller.submitDisableAdapter(address(adapter));
        (bool enabled,,,,) = module.adapters(address(adapter));
        assertFalse(enabled);
    }

    function test_controllerCancelPending() public {
        (StrategyModule module,) = _wireModule();
        module.setSentinel(address(controller));
        MockERC4626 venueB = new MockERC4626(address(quote));
        ERC4626Adapter adapterB = new ERC4626Adapter(address(module), address(venueB), address(quote));
        module.submitAdapter(address(adapterB), true, false, 5_000e6, 4_000);

        vm.prank(agent);
        controller.submitCancelPending(address(adapterB));
        (bool isPending,,,,,) = module.pending(address(adapterB));
        assertFalse(isPending);
    }

    // ------------------------------------------------------------------
    // Two-book switch policy
    // ------------------------------------------------------------------

    function test_switchBook_happyPath_recallsAndFlips() public {
        address bookB = makeAddr("bookB");
        controller.setBooks(address(hook), bookB);
        assertTrue(hook.guardPresent());

        vm.prank(agent);
        controller.submitSwitchBook(1);
        assertEq(controller.activeBook(), 1);
        assertFalse(hook.guardPresent());

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(VaultStrategyController.SwitchDwellActive.selector, block.timestamp + 1 hours)
        );
        controller.submitSwitchBook(0);
    }

    function test_switchBook_guards() public {
        controller.setBooks(address(hook), makeAddr("bookB"));

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(VaultStrategyController.SameBook.selector, uint8(0)));
        controller.submitSwitchBook(0);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(VaultStrategyController.UnknownBook.selector, uint8(2)));
        controller.submitSwitchBook(2);

        controller.setSwitchFrozen(true);
        vm.prank(agent);
        vm.expectRevert(VaultStrategyController.SwitchFrozen.selector);
        controller.submitSwitchBook(1);
    }

    function test_freeze_blocksRiskUp_onlyExits() public {
        (StrategyModule module, ERC4626Adapter adapter) = _wireModule();
        module.setSentinel(address(controller));
        controller.setBooks(address(hook), makeAddr("bookB"));
        controller.setSwitchFrozen(true);

        vm.prank(agent);
        vm.expectRevert(VaultStrategyController.SwitchFrozen.selector);
        controller.submitSwitchBook(1);

        vm.prank(agent);
        vm.expectRevert(VaultStrategyController.SwitchFrozen.selector);
        controller.submitAllocate(address(adapter), 1e6);

        vm.prank(agent);
        vm.expectRevert(VaultStrategyController.SwitchFrozen.selector);
        controller.submitFund(1e6, 0);

        vm.prank(agent);
        vm.expectRevert(VaultStrategyController.SwitchFrozen.selector);
        controller.submitRebalance(false, 1e6, 0, block.timestamp + 60);

        // De-risk stays open while frozen: recall + deallocate + disable.
        vm.prank(agent);
        controller.submitRecall();
        assertFalse(hook.guardPresent());

        vm.prank(agent);
        controller.submitDisableAdapter(address(adapter));
        (bool enabled,,,,) = module.adapters(address(adapter));
        assertFalse(enabled);
    }

    // ------------------------------------------------------------------
    // Strategy targets
    // ------------------------------------------------------------------

    function test_setTargets_validation() public {
        // Invalid mix proposes fine (no validation at propose time) but the queued
        // execution bubbles the setter revert as KnobExecutionFailed.
        bytes32 badKey = controller.proposeTargets(5_000, 2_000, 0, 1_000);
        (, uint64 at) = controller.pendingKnobs(badKey);
        vm.warp(at);
        vm.expectRevert(VaultStrategyController.KnobExecutionFailed.selector);
        controller.executeKnob(badKey);

        _executeKnob(controller.proposeTargets(7_000, 2_000, 0, 1_000));
        (uint16 hookBps, uint16 quoteBps, uint16 equityBps, uint16 idleBps) = controller.targets();
        assertEq(hookBps, 7_000);
        assertEq(quoteBps, 2_000);
        assertEq(equityBps, 0);
        assertEq(idleBps, 1_000);
    }

    function test_knobQueue_timelockCancelAndGuardians() public {
        address guardian = makeAddr("guardian");
        controller.setGuardian(guardian);

        // Non-owner cannot propose.
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(VaultStrategyController.NotOwner.selector, agent));
        controller.proposeTargets(7_000, 2_000, 0, 1_000);

        // Guardian cancels a pending knob; executing it afterwards finds nothing.
        bytes32 key = controller.proposeTargets(7_000, 2_000, 0, 1_000);
        vm.prank(guardian);
        controller.cancelKnob(key);
        vm.expectRevert(abi.encodeWithSelector(VaultStrategyController.NothingPending.selector, key));
        controller.executeKnob(key);

        // Random callers cannot cancel.
        bytes32 key2 = controller.proposeTargets(7_000, 2_000, 0, 1_000);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(VaultStrategyController.NotGuardianOrOwner.selector, agent));
        controller.cancelKnob(key2);
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
