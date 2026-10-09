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
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { HookMiner } from "v4-periphery/test/shared/HookMiner.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { DemoRouter } from "../../src/router/DemoRouter.sol";
import { NVDAPriceOracle } from "../../src/oracle/NVDAPriceOracle.sol";
import {
    ChainlinkSessionOracle,
    IChainlinkAggregator,
    ISessionStatus
} from "../../src/oracle/ChainlinkSessionOracle.sol";
import { INVDAPriceOracle } from "../../src/interfaces/INVDAPriceOracle.sol";
import { PoolGuardHook } from "../../src/hook/PoolGuardHook.sol";
import { PoolGuardSimulator } from "../../src/hook/PoolGuardSimulator.sol";
import { GuardParams } from "../../src/hook/libraries/GuardParams.sol";
import { RegimeVault } from "../../src/vaults/RegimeVault.sol";
import { StrategyModule } from "../../src/adapters/StrategyModule.sol";
import { MorphoBlueLendAdapter } from "../../src/adapters/MorphoBlueLendAdapter.sol";
import { IMorpho, IMorphoOracle } from "../../src/adapters/IMorpho.sol";
import { MockVaultBase } from "../../src/test-only/MockStrategyFakes.sol";

/// @notice Fork rehearsal against live Robinhood Chain (4663): the static book is deployed on the
///         canonical v4 PoolManager with the real USDG/NVDA tokens and the real Chainlink feed,
///         and the Morpho lending sleeve is exercised on the real NVDA/USDG market.
///
///   terminal 1:  npm run robinhood:proxy
///   terminal 2:  $env:ROBINHOOD_RPC_URL = "http://127.0.0.1:8546"
///                forge test --match-path test/fork/RobinhoodFork.t.sol -vv
///
///         (or point ROBINHOOD_RPC_URL straight at a provider RPC — no proxy needed then.)
///         Without ROBINHOOD_RPC_URL every test in this file is skipped.
contract RobinhoodForkTest is Test {
    using PoolIdLibrary for PoolKey;

    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address internal constant FEED = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
    address internal constant MORPHO = 0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    bytes32 internal constant MARKET_ID = 0xf5ff7d546af5e72f3912d2aa723088fd0bf66fddc158714995637714d9db6e4c;

    uint128 internal constant GUARD_L = 5e11;
    uint128 internal constant BASE_L = 1e11;

    IPoolManager internal manager;
    DemoRouter internal router;
    PoolGuardSimulator internal simulator;

    // Stack A: real Chainlink feed behind the session oracle.
    ChainlinkSessionOracle internal feedOracle;
    FixedSession internal session;
    PoolGuardHook internal hookA;
    RegimeVault internal vaultA;
    PoolKey internal keyA;

    // Stack B: local oracle, mispriced on purpose, to force the toxic-pull path.
    NVDAPriceOracle internal mockOracle;
    PoolGuardHook internal hookB;
    RegimeVault internal vaultB;
    PoolKey internal keyB;

    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        forked = true;

        manager = IPoolManager(POOL_MANAGER);
        router = new DemoRouter(manager);
        simulator = new PoolGuardSimulator();

        session = new FixedSession(2); // regular session
        feedOracle = new ChainlinkSessionOracle(FEED, address(session), 7 days);
        (hookA, vaultA, keyA) = _deployStack(address(feedOracle));

        mockOracle = new NVDAPriceOracle(8, address(this));
        mockOracle.setWriter(address(this), true);
        mockOracle.setMaxStaleness(7 days);
        (hookB, vaultB, keyB) = _deployStack(address(mockOracle));

        // The feed only ticks while the US market is open; a weekend/holiday fork carries an old
        // updatedAt. Production uses a tight maxPriceAge plus the session gate; the rehearsal
        // widens it so the plumbing can be tested off-hours.
        (uint160 sqrtPrice,) = _feedTick();
        mockOracle.updatePrice(int192(_feedAnswer() * 3), 2, uint32(block.timestamp), bytes32(0));

        vaultA.setGuardParams(_params());
        vaultB.setGuardParams(_params());

        deal(USDG, address(vaultA), 40e6);
        deal(NVDA, address(vaultA), 1e18);
        deal(USDG, address(vaultB), 40e6);
        deal(NVDA, address(vaultB), 1e18);
        vaultA.fundHook(40e6, 1e18);
        vaultB.fundHook(40e6, 1e18);
        vaultA.initializeHook(keyA, sqrtPrice);
        vaultB.initializeHook(keyB, sqrtPrice);

        deal(USDG, address(this), 100e6);
        IERC20(USDG).approve(address(router), type(uint256).max);
    }

    function _deployStack(address oracle_)
        internal
        returns (PoolGuardHook hook, RegimeVault vault, PoolKey memory key)
    {
        uint160 flags = uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG);
        bytes memory args = abi.encode(manager, simulator, oracle_, NVDA, address(0), address(this));
        (, bytes32 salt) = HookMiner.find(address(this), flags, type(PoolGuardHook).creationCode, args);
        hook = new PoolGuardHook{ salt: salt }(manager, simulator, oracle_, NVDA, address(0), address(this));

        key = PoolKey({
            currency0: Currency.wrap(USDG), // 0x5fc5... < 0xd060...
            currency1: Currency.wrap(NVDA),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });

        vault = new RegimeVault(manager, hook, key, IERC20(USDG), IERC20(NVDA), oracle_, 0, address(this));
        hook.setVault(address(vault));
        hook.transferOwnership(address(vault));
        vault.acceptHookOwnership();
        vault.setKeeper(makeAddr("keeper"));
    }

    function _params() internal pure returns (GuardParams.Params memory) {
        return GuardParams.Params({
            guardTickWidth: 600,
            baseTickWidth: 6000,
            guardLiquidity: GUARD_L,
            baseLiquidity: BASE_L,
            minEvBps: 0,
            recheckMaxDeviationBps: 100,
            recheckInterval: 300,
            maxPriceAge: 7 days,
            allowedSessionsMask: 0
        });
    }

    // ------------------------------------------------------------------
    // Live addresses
    // ------------------------------------------------------------------

    function test_fork_liveAddresses() public view {
        if (!forked) return;
        assertGt(USDG.code.length, 0);
        assertGt(NVDA.code.length, 0);
        assertGt(FEED.code.length, 0);
        assertGt(MORPHO.code.length, 0);
        assertGt(POOL_MANAGER.code.length, 0);

        (uint80 roundId, int256 answer,, uint256 updatedAt,) = IChainlinkAggregator(FEED).latestRoundData();
        assertGt(roundId, 0);
        assertGt(answer, 0);
        assertGt(updatedAt, 0);

        IMorpho.MarketParams memory mp = _marketParams();
        // The RH deployment has no id() view; the canonical id scheme is keccak(abi.encode(params)).
        assertEq(keccak256(abi.encode(mp)), MARKET_ID, "recorded market id matches live params");
        try IMorphoOracle(mp.oracle).price() returns (uint256 price) {
            assertGt(price, 0, "morpho oracle answers");
        } catch {
            // Morpho oracles may revert on a stale feed while the market is closed; not fatal.
        }
    }

    function test_fork_sessionOracle_validity() public {
        if (!forked) return;
        INVDAPriceOracle.PriceData memory data = INVDAPriceOracle(address(feedOracle)).getPrice();
        assertGt(data.mid, 0, "mid from the real feed");
        assertTrue(data.valid, "valid while the session is regular");

        session.setStatus(5); // unknown -> Session.None
        data = INVDAPriceOracle(address(feedOracle)).getPrice();
        assertFalse(data.valid, "invalid outside a trading session");
    }

    // ------------------------------------------------------------------
    // Static book on the canonical PoolManager with real tokens
    // ------------------------------------------------------------------

    function test_fork_fairSwapKeepsGuard_toxicPullOnDislocation() public {
        if (!forked) return;

        // The rehearsal bands carry unit-test-scale liquidity (~$2/side at $230 NVDA), so the
        // swaps are scaled to them: 1e4 raw USDG ($0.01) moves the price only a few ticks.
        // Production sizing scales both bands and swap sizes by NAV.

        // Fair flow: the pool is initialized at (a hair below) the feed price, so buying equity
        // is EV+ and the guard stays.
        router.swapExactIn(keyA, true, 1e4, 0, address(this));
        assertTrue(hookA.guardPresent(), "guard stays on fair flow");
        assertEq(hookA.effectiveLiquidity(), uint128(GUARD_L + BASE_L));

        // Dislocated flow: the local oracle is 3x the feed, so a buy is EV- and the guard is
        // pulled mid-swap; the pool thins to the base position and the swap still goes through.
        router.swapExactIn(keyB, true, 1e4, 0, address(this));
        assertFalse(hookB.guardPresent(), "guard pulled on toxic flow");
        assertEq(hookB.effectiveLiquidity(), uint128(BASE_L), "swap priced against base only");
    }

    // ------------------------------------------------------------------
    // Morpho lending sleeve on the real market
    // ------------------------------------------------------------------

    function test_fork_morphoLendAdapter_realMarket() public {
        if (!forked) return;

        StrategyModule module = new StrategyModule(address(this), USDG);
        MockVaultBase mockVault = new MockVaultBase(USDG, address(module));
        module.setVault(address(mockVault));
        module.setAllocator(address(this));
        module.setTimelock(0);

        MorphoBlueLendAdapter adapter = new MorphoBlueLendAdapter(address(module), MORPHO, _marketParams(), USDG);
        assertEq(adapter.marketId(), MARKET_ID, "adapter targets the recorded market");

        module.submitAdapter(address(adapter), true, false, 1_000_000e6, 10_000);
        module.executeAdapter(address(adapter));

        deal(USDG, address(mockVault), 100_000e6);
        assertEq(IERC20(USDG).balanceOf(address(mockVault)), 100_000e6, "deal funded the mock vault");
        mockVault.setBaseAssets(100_000e6);

        IMorpho.Market memory beforeM = IMorpho(MORPHO).market(MARKET_ID);
        module.allocate(address(adapter), 20_000e6);
        IMorpho.Market memory afterM = IMorpho(MORPHO).market(MARKET_ID);

        assertEq(afterM.totalSupplyAssets - beforeM.totalSupplyAssets, uint128(20_000e6), "USDG supplied to Morpho");
        assertApproxEqRel(adapter.realAssets(), 20_000e6, 0.001e18);

        uint256 vaultBefore = IERC20(USDG).balanceOf(address(mockVault));
        uint256 got = module.deallocate(address(adapter), 10_000e6);
        assertApproxEqAbs(got, 10_000e6, 10, "withdrew from the real market");
        assertEq(IERC20(USDG).balanceOf(address(mockVault)) - vaultBefore, got);
        assertApproxEqRel(adapter.realAssets(), 10_000e6, 0.001e18);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _marketParams() internal pure returns (IMorpho.MarketParams memory) {
        return IMorpho.MarketParams({
            loanToken: USDG,
            collateralToken: NVDA,
            oracle: 0x37CF511fA79B8446f1C23D6a81Df117F28240bE0,
            irm: 0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1,
            lltv: 625000000000000000
        });
    }

    function _feedAnswer() internal view returns (int256 answer) {
        (, answer,,,) = IChainlinkAggregator(FEED).latestRoundData();
    }

    /// @dev Pool tick whose USDG-per-NVDA price sits at (a hair below) the feed mid: the tick is
    ///      floor-aligned to the 60 spacing so the pool never prices equity above the oracle.
    function _feedTick() internal view returns (uint160 sqrtPriceX96, int24 tick) {
        int256 answer = _feedAnswer();
        uint256 mid1e18 = uint256(answer) * 1e10; // 8 -> 18 decimals
        // Raw token1/token0 ratio: NVDA-raw per USDG-raw = 10^(18-6)/price.
        uint256 rawRatio = 1e30 / mid1e18;
        uint160 target = uint160(Math.sqrt(rawRatio * (1 << 192))); // sqrt(ratio) * 2^96

        int24 lo = TickMath.MIN_TICK;
        int24 hi = TickMath.MAX_TICK;
        while (lo < hi) {
            int24 mid = int24((int256(lo) + int256(hi) + 1) >> 1);
            if (TickMath.getSqrtPriceAtTick(mid) <= target) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        tick = (lo / 60) * 60;
        sqrtPriceX96 = TickMath.getSqrtPriceAtTick(tick);
    }
}

contract FixedSession is ISessionStatus {
    uint32 internal status;

    constructor(uint32 status_) {
        status = status_;
    }

    function setStatus(uint32 status_) external {
        status = status_;
    }

    function marketStatus() external view returns (uint32) {
        return status;
    }
}
