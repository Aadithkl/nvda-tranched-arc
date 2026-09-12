// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { PoolManager } from "v4-core/src/PoolManager.sol";
import { IPoolManager } from "v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "v4-core/src/types/PoolId.sol";
import { Currency, CurrencyLibrary } from "v4-core/src/types/Currency.sol";
import { IHooks } from "v4-core/src/interfaces/IHooks.sol";
import { Hooks } from "v4-core/src/libraries/Hooks.sol";
import { TickMath } from "v4-core/src/libraries/TickMath.sol";
import { StateLibrary } from "v4-core/src/libraries/StateLibrary.sol";
import { HookMiner } from "v4-periphery/test/shared/HookMiner.sol";
import { DemoRouter } from "../../src/router/DemoRouter.sol";
import { NVDAPriceOracle } from "../../src/oracle/NVDAPriceOracle.sol";
import { HookShareToken } from "../../src/core/HookShareToken.sol";
import { TrancheJITHook } from "../../src/hook/TrancheJITHook.sol";
import { HookParams } from "../../src/hook/libraries/HookParams.sol";
import { StrategyController } from "../../src/strategy/StrategyController.sol";
import { StrategyAgent } from "../../src/strategy/StrategyAgent.sol";
import { LendingPool } from "../../src/lending/LendingPool.sol";
import { LendingPoolAddressesProvider } from "../../src/lending/LendingPoolAddressesProvider.sol";
import { LendingPoolConfigurator } from "../../src/lending/LendingPoolConfigurator.sol";
import { PeggedPriceOracle } from "../../src/lending/PeggedPriceOracle.sol";
import { DefaultReserveInterestRateStrategy } from "../../src/lending/DefaultReserveInterestRateStrategy.sol";
import { MockRiskAccountant } from "../../src/test-only/MockRiskAccountant.sol";
import { MockToken } from "../../src/test-only/MockToken.sol";

contract TrancheJITTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using CurrencyLibrary for Currency;

    uint256 internal constant NVDA_MID = 200e8;
    int24 internal constant BUCKET_TICKS = 1;
    uint256 internal constant SEED_USDC = 5_000_000;
    uint256 internal constant SEED_NVDA = 25_000_000_000_000_000;
    uint256 internal constant SWAP_IN = 100_000;

    PoolManager internal manager;
    DemoRouter internal router;
    MockToken internal usdc;
    MockToken internal nvda;
    bool internal usdcIsToken0;

    NVDAPriceOracle internal priceOracle;
    LendingPoolAddressesProvider internal provider;
    PeggedPriceOracle internal pegged;
    LendingPool internal lendingPool;
    LendingPoolConfigurator internal configurator;
    DefaultReserveInterestRateStrategy internal strategy;

    StrategyController internal controller;
    StrategyAgent internal agent;
    TrancheJITHook internal hook;
    HookShareToken internal shareToken;
    MockRiskAccountant internal risk;

    PoolKey internal key;
    PoolId internal poolId;
    int24 internal initialTick;

    address internal operator;
    address internal alice;

    function setUp() public {
        operator = makeAddr("operator");
        alice = makeAddr("alice");

        manager = new PoolManager(address(this));
        router = new DemoRouter(IPoolManager(address(manager)));
        usdc = new MockToken("USD Coin", "mUSDC", 6);
        nvda = new MockToken("NVIDIA", "mNVDA", 18);
        usdcIsToken0 = address(usdc) < address(nvda);

        _deployLending();

        priceOracle = new NVDAPriceOracle(8, address(this));
        priceOracle.setWriter(address(this), true);
        priceOracle.setMaxStaleness(300);
        priceOracle.updatePrice(int192(int256(NVDA_MID)), 2, uint32(block.timestamp), bytes32(0));

        controller = new StrategyController(address(this));
        hook = _deployHook();
        controller.setHook(address(hook));
        agent = new StrategyAgent(address(this), operator, address(controller));
        controller.setAgent(address(agent), true);

        hook.setLendingPool(address(lendingPool));
        risk = new MockRiskAccountant();
        risk.setClaims(105_000_000, 100_000_000);
        risk.setEscrowFunded(true);
        hook.setAccountant(address(risk));
        hook.setJitEnabled(true);
        hook.setLiquidityGuard(true);
        shareToken = hook.shareToken();

        _initializePool();
        _submitParams();

        usdc.mint(address(this), 100_000_000);
        nvda.mint(address(this), 1_000e18);
        usdc.approve(address(hook), type(uint256).max);
        nvda.approve(address(hook), type(uint256).max);
        usdc.approve(address(router), type(uint256).max);
        nvda.approve(address(router), type(uint256).max);
        hook.seedInventory(IERC20(address(usdc)), SEED_USDC);
        hook.seedInventory(IERC20(address(nvda)), SEED_NVDA);
    }

    function _deployLending() internal {
        provider = new LendingPoolAddressesProvider("jit-test");
        pegged = new PeggedPriceOracle(address(this));
        lendingPool = new LendingPool(address(provider));
        configurator = new LendingPoolConfigurator(address(provider));
        provider.setAddress(provider.PRICE_ORACLE(), address(pegged));
        provider.setAddress(provider.LENDING_POOL(), address(lendingPool));
        provider.setAddress(provider.LENDING_POOL_CONFIGURATOR(), address(configurator));

        pegged.setAssetPrice(address(usdc), 1e8);
        pegged.setAssetPrice(address(nvda), NVDA_MID);
        strategy = new DefaultReserveInterestRateStrategy(0, 0.04e27, 0.6e27, 0.8e27);
        configurator.initReserve(address(usdc), 6, "Aave Arc USDC", "aUSDC", address(strategy));
        configurator.initReserve(address(nvda), 18, "Aave Arc NVDA", "aNVDA", address(strategy));
        configurator.configureReserveAsCollateral(address(usdc), 7500, 8000, 10500);
        configurator.configureReserveAsCollateral(address(nvda), 7500, 8000, 10500);
        configurator.enableBorrowingOnReserve(address(usdc), true);
        configurator.enableBorrowingOnReserve(address(nvda), true);
        configurator.setReserveFactor(address(usdc), 1000);
        configurator.setReserveFactor(address(nvda), 1000);
    }

    function _deployHook() internal returns (TrancheJITHook deployed) {
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
                | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
        );
        bytes memory args = abi.encode(
            IPoolManager(address(manager)),
            IERC20(address(usdc)),
            IERC20(address(nvda)),
            address(priceOracle),
            address(this),
            address(controller)
        );
        (address hookAddress, bytes32 salt) =
            HookMiner.find(address(this), flags, type(TrancheJITHook).creationCode, args);
        deployed = new TrancheJITHook{ salt: salt }(
            IPoolManager(address(manager)),
            IERC20(address(usdc)),
            IERC20(address(nvda)),
            address(priceOracle),
            address(this),
            address(controller)
        );
        assertEq(address(deployed), hookAddress);
    }

    function _sqrtPriceX96For(uint256 usdPerEquity) internal view returns (uint160) {
        uint256 p1e18 = usdcIsToken0 ? (1e18 * 1e8) / usdPerEquity : usdPerEquity * 1e10;
        uint256 dec0 = usdcIsToken0 ? 6 : 18;
        uint256 dec1 = usdcIsToken0 ? 18 : 6;
        uint256 raw1e18 = (p1e18 * (10 ** dec1)) / (10 ** dec0);
        return uint160(Math.sqrt(Math.mulDiv(raw1e18, uint256(1) << 192, 1e18)));
    }

    function _initializePool() internal {
        address token0 = usdcIsToken0 ? address(usdc) : address(nvda);
        address token1 = usdcIsToken0 ? address(nvda) : address(usdc);
        key = PoolKey({
            currency0: Currency.wrap(token0),
            currency1: Currency.wrap(token1),
            fee: 0x800000,
            tickSpacing: 1,
            hooks: IHooks(address(hook))
        });
        poolId = key.toId();
        uint160 sqrtPriceX96 = _sqrtPriceX96For(NVDA_MID);
        initialTick = TickMath.getTickAtSqrtPrice(sqrtPriceX96);
        hook.initializePool(key, TickMath.getSqrtPriceAtTick(initialTick));
    }

    function _submitParams() internal {
        HookParams.Params memory params = HookParams.Params({
            quotingEnabled: true,
            baseFee: 3000,
            maxSurgeFee: 30_000,
            maxDeviationBps: 300,
            toxicityMultiplierBps: 1000,
            minEvBps: 0,
            cooldownSeconds: 0,
            ttl: 3600,
            gracePeriod: 3600,
            maxDeployPerSwap: 5_000_000,
            bucketTicks: BUCKET_TICKS
        });
        vm.prank(operator);
        agent.submitParams(params);
    }

    function _jitActive() internal view returns (bool active) {
        (active,,,,) = hook.jitState();
    }

    function _swap(bool zeroForOne, uint256 amountIn) internal {
        router.swapExactIn(key, zeroForOne, amountIn, 0, address(this), bytes(""));
    }

    function test_jit_swap_worksWithZeroStandingLiquidity() public {
        assertEq(IPoolManager(address(manager)).getLiquidity(poolId), 0);
        assertFalse(_jitActive());

        _swap(true, SWAP_IN);

        assertEq(IPoolManager(address(manager)).getLiquidity(poolId), 0, "JIT must leave zero residual liquidity");
        assertFalse(_jitActive());
        assertEq(hook.lastQuotedAt(), block.timestamp);

        (, int24 tickAfter,,) = IPoolManager(address(manager)).getSlot0(poolId);
        assertGe(tickAfter, initialTick - int24(BUCKET_TICKS));
        assertLe(tickAfter, initialTick);
    }

    function test_jit_bothDirections() public {
        _swap(true, SWAP_IN);
        assertEq(IPoolManager(address(manager)).getLiquidity(poolId), 0);

        _swap(false, SWAP_IN);
        assertEq(IPoolManager(address(manager)).getLiquidity(poolId), 0);
        assertFalse(_jitActive());
    }

    function test_jit_feeAccruesToHook() public {
        uint256 before = hook.totalManagedAssets();
        _swap(true, SWAP_IN);
        uint256 afterSwap = hook.totalManagedAssets();
        assertGt(afterSwap, before, "JIT fee should accrue to the hook");
    }

    function test_jit_aaveRoundTrip() public {
        uint256 suppliedBefore = hook.aToken().balanceOf(address(hook)) + hook.aTokenEquity().balanceOf(address(hook));
        assertEq(suppliedBefore, SEED_USDC + SEED_NVDA);

        _swap(true, SWAP_IN);

        uint256 suppliedAfter = hook.aToken().balanceOf(address(hook)) + hook.aTokenEquity().balanceOf(address(hook));
        assertGt(suppliedAfter, 0, "inventory must return to Aave");
        assertGt(hook.totalManagedAssets(), SEED_USDC);
    }

    function test_jit_capacityExceeded_reverts() public {
        vm.expectRevert();
        _swap(true, 100_000_000);
    }

    function test_jit_budgetZero_blocksQuoting() public {
        risk.setEscrowFunded(false);
        assertEq(hook.effectiveMaxDeploy(), 0);
        vm.expectRevert();
        _swap(true, SWAP_IN);
    }

    function test_jit_disabled_skipsJitAndUsesStandingLiquidity() public {
        hook.setJitEnabled(false);
        hook.setLiquidityGuard(false);
        router.addLiquidity(
            key,
            initialTick - 600,
            initialTick + 600,
            1e8,
            type(uint256).max,
            type(uint256).max,
            address(this),
            bytes("")
        );
        _swap(true, SWAP_IN);
        assertGt(IPoolManager(address(manager)).getLiquidity(poolId), 0);
        assertFalse(_jitActive());
    }

    function test_jit_sequentialSwaps_noResidue() public {
        uint256 aumBefore = hook.totalManagedAssets();
        _swap(true, SWAP_IN);
        _swap(false, SWAP_IN);
        _swap(true, SWAP_IN);
        _swap(false, SWAP_IN);

        assertEq(IPoolManager(address(manager)).getLiquidity(poolId), 0);
        assertFalse(_jitActive());
        assertGt(hook.totalManagedAssets(), aumBefore);
    }

    function test_jit_seedInventory_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TrancheJITHook.NotOwner.selector, alice));
        hook.seedInventory(IERC20(address(usdc)), 1_000_000);
    }

    function _claims(address asset) internal view returns (uint256) {
        return IPoolManager(address(manager)).balanceOf(address(hook), Currency.wrap(asset).toId());
    }

    function test_jit_unwindClaims_redeemsOutsideSwap() public {
        _swap(true, SWAP_IN);
        assertGt(_claims(address(nvda)) + _claims(address(usdc)), 0, "swap must leave claims");

        uint256 aumBefore = hook.totalManagedAssets();
        hook.unwindClaims();

        assertEq(_claims(address(nvda)), 0, "claims must be redeemed");
        assertEq(_claims(address(usdc)), 0);
        assertApproxEqAbs(hook.totalManagedAssets(), aumBefore, 2, "value must be conserved");

        uint256 supplied = hook.aToken().balanceOf(address(hook)) + hook.aTokenEquity().balanceOf(address(hook));
        assertGt(supplied, 0, "inventory back in Aave");
    }

    function test_jit_budgetUsesUsdcValue() public {
        HookParams.Params memory params = HookParams.Params({
            quotingEnabled: true,
            baseFee: 3000,
            maxSurgeFee: 30_000,
            maxDeviationBps: 300,
            toxicityMultiplierBps: 1000,
            minEvBps: 0,
            cooldownSeconds: 0,
            ttl: 3600,
            gracePeriod: 3600,
            maxDeployPerSwap: 100_000_000,
            bucketTicks: BUCKET_TICKS
        });
        vm.prank(operator);
        agent.submitParams(params);

        // 1 USDC -> ~0.005e18 NVDA: the raw NVDA output (~5e15 wei) dwarfs the raw 100e6 budget,
        // so a naive nominal comparison would revert; oracle valuation in USDC keeps it inside.
        _swap(usdcIsToken0, 1_000_000);
    }

    function test_jit_oversizedWithinBudget_boundedPriceImpact() public {
        _swap(true, 1_000_000);
        (, int24 tickAfter,,) = IPoolManager(address(manager)).getSlot0(poolId);
        assertGe(tickAfter, initialTick - int24(BUCKET_TICKS));
        assertEq(IPoolManager(address(manager)).getLiquidity(poolId), 0);
    }
}
