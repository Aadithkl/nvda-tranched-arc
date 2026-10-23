// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";
import { IPoolManager } from "v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "v4-core/src/types/PoolKey.sol";
import { Currency } from "v4-core/src/types/Currency.sol";
import { IHooks } from "v4-core/src/interfaces/IHooks.sol";
import { Hooks } from "v4-core/src/libraries/Hooks.sol";
import { TickMath } from "v4-core/src/libraries/TickMath.sol";
import { HookMiner } from "v4-periphery/test/shared/HookMiner.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { TestToken } from "../../src/test-only/TestToken.sol";
import { MockDeepOracle } from "../../src/test-only/MockDeepOracle.sol";
import { NVDAPriceOracle } from "../../src/oracle/NVDAPriceOracle.sol";
import { INVDAPriceOracle } from "../../src/interfaces/INVDAPriceOracle.sol";
import { PoolGuardHook } from "../../src/hook/PoolGuardHook.sol";
import { PoolGuardSimulator } from "../../src/hook/PoolGuardSimulator.sol";
import { GuardParams } from "../../src/hook/libraries/GuardParams.sol";
import { LedgerVault } from "../../src/vaults/LedgerVault.sol";
import { DepegHeartbeat } from "../../src/keeper/DepegHeartbeat.sol";
import { DemoRouter } from "../../src/router/DemoRouter.sol";

/// @notice TWAP-based, keeper-only depeg latch.
///
///         Latch = |deep-pool TWAP − stock reference| > threshold for `minDuration`.
///         Our own book price is NOT an input, so the reported flash-swap griefing vector
///         (move our small pool -> trip the latch -> deployment disabled) is inert.
contract DepegTwapTest is Test {
    IPoolManager internal manager;
    PoolGuardSimulator internal simulator;
    PoolGuardHook internal hook;
    LedgerVault internal vault;
    NVDAPriceOracle internal oracle;
    TestToken internal quote;
    TestToken internal nvda;
    MockDeepOracle internal deep;
    DemoRouter internal router;
    PoolKey internal key;

    address internal keeper = makeAddr("keeper");
    address internal other = makeAddr("other");
    bool internal quoteIsToken0;
    int24 internal initialTick;

    function setUp() public {
        manager = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        simulator = new PoolGuardSimulator();
        router = new DemoRouter(manager);
        quote = new TestToken("USD Coin", "mUSDC", 6);
        nvda = new TestToken("NVIDIA", "mNVDA", 18);

        oracle = new NVDAPriceOracle(8, address(this));
        oracle.setWriter(address(this), true);
        oracle.setMaxStaleness(1 hours);
        oracle.updatePrice(200e8, 2, uint32(block.timestamp), bytes32(0));

        address token0 = address(quote) < address(nvda) ? address(quote) : address(nvda);
        address token1 = token0 == address(quote) ? address(nvda) : address(quote);
        quoteIsToken0 = token0 == address(quote);
        initialTick = quoteIsToken0 ? int24(196260) : int24(-196260);

        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
                | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
        );
        bytes memory args = abi.encode(manager, simulator, address(oracle), address(nvda), address(0), address(this));
        (, bytes32 salt) = HookMiner.find(address(this), flags, type(PoolGuardHook).creationCode, args);
        hook = new PoolGuardHook{ salt: salt }(
            manager, simulator, address(oracle), address(nvda), address(0), address(this)
        );

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

        deep = new MockDeepOracle();
        vault.setDeepOracle(address(deep));
        vault.setDepegKeeper(address(this));
        vault.setDepegParams(200, 1800, 600, 0);
        deep.setPrice(_mid());

        quote.approve(address(router), type(uint256).max);
        nvda.approve(address(router), type(uint256).max);
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

    /// @dev Stock reference (Chainlink mid) in 1e18 quote units.
    function _mid() internal view returns (uint256) {
        INVDAPriceOracle.PriceData memory d = INVDAPriceOracle(address(oracle)).getPrice();
        return uint256(uint192(d.mid)) * (10 ** (18 - oracle.decimals()));
    }

    function _setDeepOffPeg() internal {
        deep.setPrice(_mid() * 11 / 10); // +10% => ~1000 bps, over the 200 bps gate
    }

    /// @dev Drive the check past the confirmation duration and latch.
    function _latch() internal {
        _setDeepOffPeg();
        vault.checkDepeg();
        vm.warp(block.timestamp + 601);
        vault.checkDepeg();
        assertTrue(vault.depegPaused(), "latched");
    }

    // ------------------------------------------------------------------
    // Peg / depeg
    // ------------------------------------------------------------------

    function test_peggedStaysClean() public {
        assertFalse(vault.checkDepeg());
        vm.warp(block.timestamp + 601);
        assertFalse(vault.checkDepeg());
        assertFalse(vault.depegPaused());
    }

    function test_divergenceBeforeMinDuration_doesNotLatch() public {
        _setDeepOffPeg();
        assertFalse(vault.checkDepeg());
        vm.warp(block.timestamp + 599);
        assertFalse(vault.checkDepeg());
        assertFalse(vault.depegPaused(), "duration gate holds");
    }

    function test_divergenceAfterMinDuration_latches() public {
        _latch();
        assertFalse(hook.deployEnabled(), "deployments disabled by the latch");
        assertTrue(vault.disabledByDepeg(), "latched by the check");
    }

    function test_clearRestoresDeployEnabled() public {
        _latch();
        assertFalse(hook.deployEnabled());

        deep.setPrice(_mid());
        assertFalse(vault.checkDepeg());
        assertFalse(vault.depegPaused());
        assertTrue(hook.deployEnabled(), "symmetric clear restores deployment");
        assertFalse(vault.disabledByDepeg());
    }

    function test_forceDepeg_isImmediate() public {
        vault.forceDepeg();
        assertTrue(vault.depegPaused(), "forced latch");
        assertFalse(hook.deployEnabled());
    }

    function test_deepOracleUnavailable_leavesStateUntouched() public {
        _setDeepOffPeg();
        deep.setOk(false);
        vault.checkDepeg();
        vm.warp(block.timestamp + 601);
        vault.checkDepeg();
        assertFalse(vault.depegPaused(), "no opinion is not a depeg");
    }

    function test_staleStockFeed_leavesStateUntouched() public {
        _setDeepOffPeg();
        vm.warp(block.timestamp + 2 hours); // feed maxStaleness is 1h
        vault.checkDepeg();
        assertFalse(vault.depegPaused());
    }

    function test_corporateActionGraceSuppressesLatch() public {
        vault.setCorporateActionGrace(1 days);
        _setDeepOffPeg();
        vault.checkDepeg();
        vm.warp(block.timestamp + 601);
        vault.checkDepeg();
        assertFalse(vault.depegPaused(), "grace suppresses the latch");
    }

    // ------------------------------------------------------------------
    // Access control / freshness
    // ------------------------------------------------------------------

    function test_nonKeeper_cannotCheck() public {
        vault.setKeeper(keeper);
        vault.setDepegKeeper(other);
        vm.prank(makeAddr("anon"));
        vm.expectRevert(abi.encodeWithSelector(LedgerVault.NotKeeper.selector, makeAddr("anon")));
        vault.checkDepeg();
    }

    function test_controllerKeeper_canCheck() public {
        vault.setKeeper(keeper);
        vm.prank(keeper);
        assertFalse(vault.checkDepeg());
    }

    function test_staleCheckBlocksReEnable() public {
        vault.setDepegParams(200, 1800, 600, 100); // maxCheckAge = 100s
        vm.warp(block.timestamp + 200);
        vm.expectRevert(LedgerVault.DepegCheckStale.selector);
        vault.setHookDeployEnabled(true);

        // A fresh check opens the gate.
        vault.checkDepeg();
        vault.setHookDeployEnabled(true);
    }

    function test_standingDownAlwaysAllowed() public {
        vault.setDepegParams(200, 1800, 600, 100);
        vm.warp(block.timestamp + 200);
        vault.setHookDeployEnabled(false); // no freshness requirement to de-risk
    }

    // ------------------------------------------------------------------
    // Regression: the reported griefing vector
    // ------------------------------------------------------------------

    /// @notice Moving OUR pool no longer latches anything: the check reads the deep TWAP.
    function test_ourPoolManipulation_doesNotLatch() public {
        // Manipulate the local v4 book hard.
        quote.mint(address(this), 2e6);
        router.swapExactIn(key, quoteIsToken0, 2e6, 0, address(this));
        (bool ok, uint256 dev) = hook.oracleDeviationBps();
        assertTrue(ok);
        assertGt(dev, 200, "our pool is far off the oracle");

        // The latch is unmoved: deep TWAP is still pegged to the stock reference.
        assertFalse(vault.checkDepeg());
        vm.warp(block.timestamp + 601);
        assertFalse(vault.checkDepeg());
        assertFalse(vault.depegPaused(), "own-pool manipulation cannot trip the latch");
    }

    // ------------------------------------------------------------------
    // Heartbeat adapter
    // ------------------------------------------------------------------

    function test_heartbeatCadenceAndSession() public {
        DepegHeartbeat hb = new DepegHeartbeat(address(vault), address(hook), 1800, 3600);
        vault.setDepegKeeper(address(hb));

        (bool due,) = hb.checkUpkeep("");
        assertTrue(due, "first heartbeat due");

        hb.performUpkeep("");
        uint256 last = vault.lastDepegCheck();

        (due,) = hb.checkUpkeep("");
        assertFalse(due, "fresh heartbeat");

        // Open session with a live feed: 30-min interval.
        vm.warp(last + 1801);
        oracle.updatePrice(int192(int256(hook.poolPrice1e18() / 1e10)), 2, uint32(block.timestamp), bytes32(0));
        (due,) = hb.checkUpkeep("");
        assertTrue(due, "open interval elapsed");

        hb.performUpkeep("");
        last = vault.lastDepegCheck();

        // Feed goes stale (> hook maxPriceAge): the hook reports closed -> 60-min interval.
        vm.warp(last + 301);
        (due,) = hb.checkUpkeep("");
        assertFalse(due, "closed-session uses the longer interval");

        vm.warp(last + 3601);
        (due,) = hb.checkUpkeep("");
        assertTrue(due, "closed interval elapsed");
    }
}
