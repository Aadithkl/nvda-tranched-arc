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
import { DemoRouter } from "../../src/router/DemoRouter.sol";

/// @notice Regression for the reported depeg griefing vector.
///
///         Old behavior: `checkDepeg()` was permissionless and compared OUR pool spot with the
///         oracle. An attacker could flash-swap the small book past `depegThresholdBps`,
///         call the check, and leave deployments disabled (the clear path did not re-enable).
///
///         Fixed behavior:
///           1. The check is keeper-only, so an attacker can never call it.
///           2. The latch compares the DEEP external pool TWAP with the stock reference, so
///              moving our own book is not even an input.
///           3. A latch requires the divergence to persist for `minDuration`.
///           4. Clearing restores `deployEnabled` if the latch disabled it (symmetric).
contract AuditDepegGriefTest is Test {
    IPoolManager internal manager;
    DemoRouter internal router;
    PoolGuardSimulator internal simulator;
    PoolGuardHook internal hook;
    LedgerVault internal vault;
    NVDAPriceOracle internal oracle;
    TestToken internal quote;
    TestToken internal nvda;
    MockDeepOracle internal deep;

    PoolKey internal key;
    address internal keeper = makeAddr("keeper");
    bool internal quoteIsToken0;
    int24 internal initialTick;

    function setUp() public {
        manager = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        router = new DemoRouter(manager);
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
        vault.setKeeper(keeper);

        quote.mint(address(vault), 1_000_000e6);
        nvda.mint(address(vault), 100e18);
        vm.prank(keeper);
        vault.fundHook(40e6, 1e18);
        vault.initializeHook(key, TickMath.getSqrtPriceAtTick(initialTick));
        oracle.updatePrice(int192(int256(hook.poolPrice1e18() / 1e10)), 2, uint32(block.timestamp), bytes32(0));
        vm.prank(keeper);
        vault.setGuardParams(_params());

        deep = new MockDeepOracle();
        vault.setDeepOracle(address(deep));
        vault.setDepegKeeper(keeper);
        vault.setDepegParams(200, 1800, 600, 0);
        deep.setPrice(_mid());

        quote.approve(address(router), type(uint256).max);
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

    function _mid() internal view returns (uint256) {
        INVDAPriceOracle.PriceData memory d = INVDAPriceOracle(address(oracle)).getPrice();
        return uint256(uint192(d.mid)) * (10 ** (18 - oracle.decimals()));
    }

    /// @notice The exact reported attack: an attacker who can move our pool can no longer
    ///         call the latch at all.
    function test_reportedAttack_attackerCannotTripLatch() public {
        address attacker = makeAddr("attacker");
        quote.mint(attacker, 1_000e6);
        vm.startPrank(attacker);
        quote.approve(address(router), type(uint256).max);
        router.swapExactIn(key, quoteIsToken0, 2e6, 0, attacker);
        vm.expectRevert(abi.encodeWithSelector(LedgerVault.NotKeeper.selector, attacker));
        vault.checkDepeg();
        vm.stopPrank();
        assertFalse(vault.depegPaused());
    }

    /// @notice Even a legitimate keeper check ignores our own book: the deep TWAP is the
    ///         checked side, so moving our pool cannot latch (or disable deployments).
    function test_reportedAttack_keeperCheckIgnoresOwnPool() public {
        quote.mint(address(this), 2e6);
        router.swapExactIn(key, quoteIsToken0, 2e6, 0, address(this));
        (bool ok, uint256 dev) = hook.oracleDeviationBps();
        assertTrue(ok);
        assertGt(dev, 200, "our pool is off the oracle");

        vm.prank(keeper);
        assertFalse(vault.checkDepeg());
        vm.warp(block.timestamp + 601);
        vm.prank(keeper);
        assertFalse(vault.checkDepeg());

        assertFalse(vault.depegPaused(), "own-pool move cannot latch");
        assertTrue(hook.deployEnabled(), "deployments untouched");
    }
}
