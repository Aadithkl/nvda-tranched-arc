// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { PoolManager } from "v4-core/src/PoolManager.sol";
import { IPoolManager } from "v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "v4-core/src/types/PoolId.sol";
import { Currency } from "v4-core/src/types/Currency.sol";
import { IHooks } from "v4-core/src/interfaces/IHooks.sol";
import { Hooks } from "v4-core/src/libraries/Hooks.sol";
import { TickMath } from "v4-core/src/libraries/TickMath.sol";
import { HookMiner } from "v4-periphery/test/shared/HookMiner.sol";
import { DemoRouter } from "../../src/router/DemoRouter.sol";
import { NVDAPriceOracle } from "../../src/oracle/NVDAPriceOracle.sol";
import { HookShareToken } from "../../src/core/HookShareToken.sol";
import { TrancheJITHook } from "../../src/hook/TrancheJITHook.sol";
import { TranchePipeModule } from "../../src/periphery/TranchePipeModule.sol";
import { INVDAPriceOracle } from "../../src/interfaces/INVDAPriceOracle.sol";
import { HookParams } from "../../src/hook/libraries/HookParams.sol";
import { StrategyController } from "../../src/strategy/StrategyController.sol";
import { StrategyAgent } from "../../src/strategy/StrategyAgent.sol";
import { LendingPool } from "../../src/lending/LendingPool.sol";
import { LendingPoolAddressesProvider } from "../../src/lending/LendingPoolAddressesProvider.sol";
import { LendingPoolConfigurator } from "../../src/lending/LendingPoolConfigurator.sol";
import { PeggedPriceOracle } from "../../src/lending/PeggedPriceOracle.sol";
import { DefaultReserveInterestRateStrategy } from "../../src/lending/DefaultReserveInterestRateStrategy.sol";
import { AToken } from "../../src/lending/AToken.sol";
import { ITrancheAccountant } from "../../src/interfaces/ITrancheAccountant.sol";
import { MockRiskAccountant } from "../../src/test-only/MockRiskAccountant.sol";
import { TestToken } from "../../src/test-only/TestToken.sol";

contract TrancheJITHookTest is Test {
    using PoolIdLibrary for PoolKey;

    uint256 internal constant YEAR = 365 days;
    uint256 internal constant LIQUIDITY = 1e12;
    uint256 internal constant ORACLE_PRICE = 200e8;

    PoolManager internal manager;
    DemoRouter internal router;
    TestToken internal usdc;
    TestToken internal nvda;

    NVDAPriceOracle internal nvdaOracle;
    LendingPoolAddressesProvider internal provider;
    PeggedPriceOracle internal pegged;
    LendingPool internal lendingPool;
    LendingPoolConfigurator internal configurator;
    DefaultReserveInterestRateStrategy internal strategy;
    AToken internal aUsdc;

    StrategyController internal controller;
    StrategyAgent internal agent;
    TrancheJITHook internal hook;
    TranchePipeModule internal pipe;
    HookShareToken internal shareToken;
    MockRiskAccountant internal risk;

    PoolKey internal key;
    PoolId internal poolId;
    PoolKey internal venueKey;
    bool internal usdcIsToken0;
    int24 internal tickLower;
    int24 internal tickUpper;

    address internal operator;
    address internal alice;

    function setUp() public {
        operator = makeAddr("operator");
        alice = makeAddr("alice");

        manager = new PoolManager(address(this));
        router = new DemoRouter(IPoolManager(address(manager)));
        usdc = new TestToken("USD Coin", "mUSDC", 6);
        nvda = new TestToken("NVIDIA", "mNVDA", 18);
        usdcIsToken0 = address(usdc) < address(nvda);

        _deployLending();

        nvdaOracle = new NVDAPriceOracle(8, address(this));
        nvdaOracle.setWriter(address(this), true);
        nvdaOracle.setMaxStaleness(300);
        nvdaOracle.updatePrice(int192(int256(ORACLE_PRICE)), 2, uint32(block.timestamp), bytes32(0));

        controller = new StrategyController(address(this));
        hook = _deployHook();
        controller.setHook(address(hook));
        agent = new StrategyAgent(address(this), operator, address(controller));
        controller.setAgent(address(agent), true);

        pipe = new TranchePipeModule(address(hook), address(this));
        hook.setModule(address(pipe));
        pipe.setController(address(controller));
        controller.setRebalanceTarget(address(pipe));

        hook.setLendingPool(address(lendingPool));
        risk = new MockRiskAccountant();
        risk.setClaims(105e6, 95e6);
        risk.setEscrowFunded(true);
        hook.setAccountant(address(risk));
        shareToken = hook.shareToken();

        _initializePool(ORACLE_PRICE);
        _submitDefaultParams();
    }

    function _deployLending() internal {
        provider = new LendingPoolAddressesProvider("hook-test");
        pegged = new PeggedPriceOracle(address(this));
        lendingPool = new LendingPool(address(provider));
        configurator = new LendingPoolConfigurator(address(provider));
        provider.setAddress(provider.PRICE_ORACLE(), address(pegged));
        provider.setAddress(provider.LENDING_POOL(), address(lendingPool));
        provider.setAddress(provider.LENDING_POOL_CONFIGURATOR(), address(configurator));

        pegged.setAssetPrice(address(usdc), 1e8);
        strategy = new DefaultReserveInterestRateStrategy(0, 0.04e27, 0.6e27, 0.8e27);
        configurator.initReserve(address(usdc), 6, "Aave Arc USDC", "aUSDC", address(strategy));
        configurator.configureReserveAsCollateral(address(usdc), 7500, 8000, 10500);
        configurator.enableBorrowingOnReserve(address(usdc), true);
        configurator.setReserveFactor(address(usdc), 1000);
        aUsdc = AToken(lendingPool.getReserveData(address(usdc)).aTokenAddress);

        usdc.mint(address(this), 500_000e6);
        usdc.approve(address(lendingPool), type(uint256).max);
        lendingPool.deposit(address(usdc), 100_000e6, address(this), 0);
        lendingPool.borrow(address(usdc), 50_000e6, 2, 0, address(this));
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
            address(nvdaOracle),
            address(this),
            address(controller)
        );
        (address hookAddress, bytes32 salt) =
            HookMiner.find(address(this), flags, type(TrancheJITHook).creationCode, args);
        deployed = new TrancheJITHook{ salt: salt }(
            IPoolManager(address(manager)),
            IERC20(address(usdc)),
            IERC20(address(nvda)),
            address(nvdaOracle),
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

    function _align(int24 tick, int24 spacing) internal pure returns (int24) {
        int24 q = tick / spacing;
        if (tick < 0 && tick % spacing != 0) q -= 1;
        return q * spacing;
    }

    function _initializePool(uint256 usdPerEquity) internal {
        address token0 = usdcIsToken0 ? address(usdc) : address(nvda);
        address token1 = usdcIsToken0 ? address(nvda) : address(usdc);
        key = PoolKey({
            currency0: Currency.wrap(token0),
            currency1: Currency.wrap(token1),
            fee: 0x800000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        poolId = key.toId();

        uint160 sqrtPriceX96 = _sqrtPriceX96For(usdPerEquity);
        hook.initializePool(key, sqrtPriceX96);

        int24 tick = _align(TickMath.getTickAtSqrtPrice(sqrtPriceX96), 60);
        tickLower = tick - 6000;
        tickUpper = tick + 6000;

        usdc.mint(address(this), 10_000_000e6);
        nvda.mint(address(this), 100e18);
        usdc.approve(address(router), type(uint256).max);
        nvda.approve(address(router), type(uint256).max);
        router.addLiquidity(
            key, tickLower, tickUpper, int256(LIQUIDITY), type(uint256).max, type(uint256).max, address(this), bytes("")
        );
    }

    function _initVenuePool() internal {
        venueKey = PoolKey({
            currency0: key.currency0, currency1: key.currency1, fee: 3000, tickSpacing: 60, hooks: IHooks(address(0))
        });
        manager.initialize(venueKey, _sqrtPriceX96For(ORACLE_PRICE));
        usdc.mint(address(this), 1_000_000e6);
        nvda.mint(address(this), 10_000e18);
        usdc.approve(address(router), type(uint256).max);
        nvda.approve(address(router), type(uint256).max);
        router.addLiquidity(
            venueKey,
            tickLower,
            tickUpper,
            int256(LIQUIDITY * 1000),
            type(uint256).max,
            type(uint256).max,
            address(this),
            bytes("")
        );
        pipe.setRebalanceVenue(venueKey, address(router));
    }

    function _oracleNvdaOut(uint256 usdcAmount) internal pure returns (uint256) {
        return Math.mulDiv(usdcAmount, 1e20, ORACLE_PRICE);
    }

    function _oracleUsdcOut(uint256 nvdaAmount) internal pure returns (uint256) {
        return Math.mulDiv(nvdaAmount, ORACLE_PRICE, 1e20);
    }

    function _oracleFloor(uint256 oracleOut) internal pure returns (uint256) {
        return oracleOut * (10_000 - 100) / 10_000;
    }

    function _defaultParams() internal pure returns (HookParams.Params memory) {
        return HookParams.Params({
            quotingEnabled: true,
            baseFee: 3000,
            maxDeviationBps: 300,
            toxicityMultiplierBps: 1000,
            minEvBps: 0,
            cooldownSeconds: 0,
            ttl: 3600,
            gracePeriod: 3600,
            maxDeployPerSwap: 50_000e6,
            bucketTicks: 60
        });
    }

    function _submitDefaultParams() internal {
        vm.prank(operator);
        agent.submitParams(_defaultParams());
    }

    function _setOraclePrice(uint256 price8) internal {
        nvdaOracle.updatePrice(int192(int256(price8)), 2, uint32(block.timestamp), bytes32(0));
    }

    function test_permissions() public view {
        Hooks.Permissions memory permissions = hook.getHookPermissions();
        assertTrue(permissions.beforeInitialize);
        assertTrue(permissions.beforeAddLiquidity);
        assertTrue(permissions.beforeRemoveLiquidity);
        assertTrue(permissions.beforeSwap);
        assertTrue(permissions.afterSwap);
        assertFalse(permissions.beforeSwapReturnDelta);
        assertFalse(permissions.afterSwapReturnDelta);
    }

    function test_constructor_wiring() public view {
        assertEq(address(shareToken.hook()), address(hook));
        assertEq(shareToken.asset(), address(usdc));
        assertEq(address(shareToken).code.length > 0, true);
        assertEq(hook.owner(), address(this));
        assertEq(hook.guardian(), address(this));
        assertEq(hook.controller(), address(controller));
        assertEq(address(hook.aToken()), address(aUsdc));
    }

    function test_shareToken_7575Lookup() public view {
        assertEq(shareToken.vault(address(usdc)), address(hook));
        assertEq(shareToken.vault(address(nvda)), address(0));
    }

    function test_initializePool_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TrancheJITHook.NotOwner.selector, alice));
        hook.initializePool(key, _sqrtPriceX96For(ORACLE_PRICE));
    }

    function test_initializePool_requiresDynamicFee() public {
        PoolKey memory staticKey = key;
        staticKey.fee = 3000;
        vm.expectRevert(TrancheJITHook.NotDynamicFee.selector);
        hook.initializePool(staticKey, _sqrtPriceX96For(ORACLE_PRICE));
    }

    function test_externalInitialize_reverts() public {
        PoolKey memory otherKey = key;
        otherKey.tickSpacing = 120;
        vm.expectRevert();
        manager.initialize(otherKey, _sqrtPriceX96For(ORACLE_PRICE));
    }

    function test_quote_atOracle_baseFeeNonToxic() public view {
        (uint24 feeBuy, bool toxicBuy,, TrancheJITHook.QuoteState stateBuy) = hook.previewQuote(true);
        (uint24 feeSell, bool toxicSell,, TrancheJITHook.QuoteState stateSell) = hook.previewQuote(false);
        assertEq(uint8(stateBuy), uint8(TrancheJITHook.QuoteState.Active));
        assertEq(uint8(stateSell), uint8(TrancheJITHook.QuoteState.Active));
        if (!toxicBuy) assertEq(feeBuy, 3000);
        if (!toxicSell) assertEq(feeSell, 3000);
        assertFalse(toxicBuy && toxicSell);
    }

    function test_quote_oracleMove_makesOneDirectionToxic() public {
        _setOraclePrice(201e8);

        bool equityIsToken1 = usdcIsToken0;
        bool buyingDirection = equityIsToken1;
        (uint24 buyFee, bool buyToxic,,) = hook.previewQuote(buyingDirection);
        (uint24 sellFee, bool sellToxic,,) = hook.previewQuote(!buyingDirection);

        assertTrue(buyToxic);
        assertFalse(sellToxic);
        assertGt(buyFee, 3000);
        assertEq(sellFee, 3000);
    }

    function test_quote_surgeUncappedByFeeCeiling() public {
        // The surge premium is only capped by the 100% protocol maximum, so toxic flow
        // pays baseFee + deviation × multiplier above the old 30k ceiling.
        _setOraclePrice(201e8);
        bool equityIsToken1 = usdcIsToken0;
        (uint24 buyFee, bool toxic, uint16 devBps,) = hook.previewQuote(equityIsToken1);
        assertTrue(toxic);
        assertEq(buyFee, uint24(3000 + uint256(devBps) * 1000));
        assertGt(buyFee, 30_000);
    }

    function test_quote_hardBand_reverts() public {
        _setOraclePrice(207e8);
        vm.expectRevert(abi.encodeWithSelector(TrancheJITHook.DeviationTooHigh.selector, 338));
        hook.previewQuote(true);
    }

    function test_quote_invalidOracle_reverts() public {
        nvdaOracle.setMaxStaleness(1);
        vm.warp(block.timestamp + 2);
        vm.expectRevert(TrancheJITHook.OracleInvalid.selector);
        hook.previewQuote(true);
    }

    function test_swap_endToEnd_updatesLastQuotedAt() public {
        (bool zeroForOne,,) = _safeDirection();
        uint256 amountIn = zeroForOne == usdcIsToken0 ? 1e6 : 0.001e18;
        assertEq(hook.lastQuotedAt(), 0);
        router.swapExactIn(key, zeroForOne, amountIn, 0, address(this), bytes(""));
        assertEq(hook.lastQuotedAt(), block.timestamp);
    }

    function test_ttl_stateMachine_degradedThenRest() public {
        uint256 t0 = block.timestamp;
        risk.setJuniorClaim(1_000_000e6);
        assertEq(uint8(hook.quoteState()), uint8(TrancheJITHook.QuoteState.Active));
        assertEq(hook.effectiveMaxDeploy(), 50_000e6);

        vm.warp(t0 + 3600 + 1);
        assertEq(uint8(hook.quoteState()), uint8(TrancheJITHook.QuoteState.Degraded));
        assertEq(hook.effectiveMaxDeploy(), 50_000e6 / 4);

        vm.warp(t0 + 3600 + 3600 + 1);
        assertEq(uint8(hook.quoteState()), uint8(TrancheJITHook.QuoteState.Rest));
        assertEq(hook.effectiveMaxDeploy(), 0);

        vm.expectRevert(TrancheJITHook.QuotingOff.selector);
        hook.previewQuote(true);
        vm.expectRevert();
        router.swapExactIn(key, true, 1e6, 0, address(this), bytes(""));
    }

    function test_riskBudget_escrowAndJuniorCap() public {
        assertEq(hook.riskBudget(), 95e6);
        assertEq(hook.effectiveMaxDeploy(), 95e6);

        risk.setJuniorClaim(10e6);
        assertEq(hook.effectiveMaxDeploy(), 10e6);

        risk.setEscrowFunded(false);
        assertEq(hook.riskBudget(), 0);
        assertEq(hook.effectiveMaxDeploy(), 0);
    }

    function test_setAccountant_zero_reverts() public {
        vm.expectRevert(TrancheJITHook.ZeroAddress.selector);
        hook.setAccountant(address(0));
    }

    function test_unfundedAccountant_blocksRiskBudget() public {
        risk.setEscrowFunded(false);
        assertEq(hook.riskBudget(), 0);
        assertEq(hook.effectiveMaxDeploy(), 0);
    }

    function test_hookParams_onlyController() public {
        vm.expectRevert(abi.encodeWithSelector(TrancheJITHook.NotController.selector, address(this)));
        hook.setParams(_defaultParams());
        vm.expectRevert(abi.encodeWithSelector(TrancheJITHook.NotController.selector, address(this)));
        hook.setBaseFee(4000);
        vm.expectRevert(abi.encodeWithSelector(TrancheJITHook.NotController.selector, address(this)));
        hook.setQuotingEnabled(false);
    }

    function test_controller_rejectsNonWhitelistedAgent() public {
        vm.expectRevert(abi.encodeWithSelector(StrategyController.NotAgent.selector, address(this)));
        controller.setHookParams(_defaultParams());
    }

    function test_controller_bounds() public {
        HookParams.Params memory p = _defaultParams();
        p.ttl = 7200;
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(StrategyController.TtlTooLong.selector, 7200, 3600));
        agent.submitParams(p);
    }

    function test_agent_onlyOperator() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyAgent.NotOperator.selector, alice));
        agent.submitParams(_defaultParams());

        vm.prank(operator);
        agent.submitBaseFee(5000);
        HookParams.Params memory stored = hook.params();
        assertEq(stored.baseFee, 5000);
    }

    function test_setBaseFee_updatesDynamicFeeOnPool() public {
        vm.prank(operator);
        agent.submitBaseFee(7000);
        (,,, uint24 poolFee) = _readSlot0();
        assertEq(poolFee, 7000);
        assertEq(uint8(hook.quoteState()), uint8(TrancheJITHook.QuoteState.Active));
    }

    function _readSlot0() internal view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee) {
        bytes32 stateSlot = keccak256(abi.encodePacked(PoolId.unwrap(poolId), bytes32(uint256(6))));
        uint256 slot0 = uint256(manager.extsload(stateSlot));
        sqrtPriceX96 = uint160(slot0);
        tick = int24(uint24(slot0 >> 160));
        protocolFee = uint24(uint32(slot0 >> 184));
        lpFee = uint24(uint32(slot0 >> 208));
    }

    function _safeDirection() internal view returns (bool zeroForOne, uint24 fee, uint16 devBps) {
        (, bool toxic,,) = hook.previewQuote(true);
        zeroForOne = !toxic;
        (fee,, devBps,) = hook.previewQuote(zeroForOne);
    }

    function test_minEvPositive_blocksLowFeeQuotes() public {
        (bool zeroForOne,,) = _safeDirection();

        HookParams.Params memory p = _defaultParams();
        p.minEvBps = 100;
        vm.prank(operator);
        agent.submitParams(p);

        vm.expectRevert(abi.encodeWithSelector(TrancheJITHook.NotEvPositive.selector, 3000));
        hook.previewQuote(zeroForOne);
        uint256 amountIn = zeroForOne == usdcIsToken0 ? 1e6 : 0.001e18;
        vm.expectRevert();
        router.swapExactIn(key, zeroForOne, amountIn, 0, address(this), bytes(""));
    }

    function test_quotingDisabled_restState() public {
        vm.prank(operator);
        agent.submitQuotingEnabled(false);
        assertEq(uint8(hook.quoteState()), uint8(TrancheJITHook.QuoteState.Rest));
        vm.expectRevert(TrancheJITHook.QuotingOff.selector);
        hook.previewQuote(true);
        vm.expectRevert();
        router.swapExactIn(key, true, 1e6, 0, address(this), bytes(""));
    }

    function test_pause_restState() public {
        hook.setPaused(true);
        assertEq(uint8(hook.quoteState()), uint8(TrancheJITHook.QuoteState.Rest));
        hook.setPaused(false);
        assertEq(uint8(hook.quoteState()), uint8(TrancheJITHook.QuoteState.Active));
    }

    function test_cooldown_blocksConsecutiveSwaps() public {
        HookParams.Params memory p = _defaultParams();
        p.cooldownSeconds = 60;
        vm.prank(operator);
        agent.submitParams(p);
        vm.warp(block.timestamp + 100);

        (bool zeroForOne,,) = _safeDirection();
        uint256 amountIn = zeroForOne == usdcIsToken0 ? 1e6 : 0.001e18;
        router.swapExactIn(key, zeroForOne, amountIn, 0, address(this), bytes(""));

        vm.expectRevert(TrancheJITHook.CooldownActive.selector);
        hook.previewQuote(zeroForOne);
        vm.expectRevert();
        router.swapExactIn(key, !zeroForOne, amountIn, 0, address(this), bytes(""));
    }

    function test_liquidityGuard_blocksExternalLiquidity() public {
        hook.setLiquidityGuard(true);
        vm.expectRevert();
        router.addLiquidity(
            key, tickLower, tickUpper, 1e12, type(uint256).max, type(uint256).max, address(this), bytes("")
        );
    }

    function test_wrapUnwrap_aaveRestState_andYield() public {
        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(hook), type(uint256).max);

        uint256 expectedShares = hook.convertToShares(100e6);
        vm.prank(alice);
        uint256 shares = hook.wrapUSDC(100e6, alice);
        assertEq(shares, expectedShares);
        assertEq(shareToken.balanceOf(alice), shares);
        assertEq(aUsdc.balanceOf(address(hook)), 100e6);
        assertEq(usdc.balanceOf(address(hook)), 0);
        assertEq(hook.totalManagedAssets(), 100e6);
        assertEq(hook.convertToUsdc(shares), 100e6);

        uint256 t0 = block.timestamp;
        vm.warp(t0 + YEAR);
        lendingPool.updateState(address(usdc));

        assertGt(hook.totalManagedAssets(), 100e6);
        uint256 expectedOut = hook.convertToUsdc(shares);
        assertGt(expectedOut, 100e6);

        vm.prank(alice);
        uint256 usdcOut = hook.unwrapUSDC(shares, alice);
        assertEq(usdcOut, expectedOut);
        assertEq(usdc.balanceOf(alice), 900e6 + usdcOut);
        assertEq(shareToken.totalSupply(), 0);
    }

    function test_slippageProtection_onUnwrap() public {
        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(hook), type(uint256).max);
        vm.prank(alice);
        uint256 shares = hook.wrapUSDC(100e6, alice);

        uint256 expectedOut = hook.convertToUsdc(shares);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TrancheJITHook.SlippageExceeded.selector, expectedOut, expectedOut + 1));
        hook.unwrapUSDC(shares, alice, expectedOut + 1);

        vm.prank(alice);
        uint256 usdcOut = hook.unwrapUSDC(shares, alice, expectedOut);
        assertEq(usdcOut, expectedOut);
    }

    function test_donation_doesNotDiluteExistingHolders() public {
        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(hook), type(uint256).max);
        vm.prank(alice);
        uint256 aliceShares = hook.wrapUSDC(100e6, alice);

        // Attacker donates USDC directly to the hook (no shares minted).
        usdc.mint(address(this), 1_000e6);
        usdc.transfer(address(hook), 1_000e6);
        assertEq(hook.totalManagedAssets(), 1_100e6);

        // A later depositor must not be able to zero out or materially dilute alice.
        usdc.mint(alice, 100e6);
        vm.prank(alice);
        uint256 newShares = hook.wrapUSDC(100e6, alice);
        assertGt(newShares, 0);
        assertGe(hook.convertToUsdc(aliceShares + newShares), 1_100e6 - 2);
    }

    function test_oracle_staleHookWindow_reverts() public {
        nvdaOracle.setMaxStaleness(3_600);
        hook.setMaxPriceAge(60);
        vm.warp(block.timestamp + 61);
        uint256 updatedAt = nvdaOracle.getPrice().updatedAt;
        vm.expectRevert(abi.encodeWithSelector(TrancheJITHook.OracleStale.selector, updatedAt));
        hook.previewQuote(true);
    }

    function test_oracle_negativeMid_reverts() public {
        INVDAPriceOracle.PriceData memory bad = INVDAPriceOracle.PriceData({
            mid: -1,
            bid: -1,
            ask: -1,
            marketStatus: 2,
            session: 2,
            sourceTimestamp: uint32(block.timestamp),
            updatedAt: block.timestamp,
            paymentRef: bytes32(0),
            valid: true
        });
        vm.mockCall(address(nvdaOracle), abi.encodeWithSelector(INVDAPriceOracle.getPrice.selector), abi.encode(bad));
        vm.expectRevert(TrancheJITHook.OracleInvalid.selector);
        hook.previewQuote(true);
    }

    function test_extremePoolPrice_noPanic() public {
        bytes32 slot = keccak256(abi.encodePacked(PoolId.unwrap(poolId), bytes32(uint256(6))));
        uint160 extreme = TickMath.MAX_SQRT_PRICE - 1;
        vm.mockCall(
            address(manager),
            abi.encodeWithSelector(bytes4(keccak256("extsload(bytes32)")), slot),
            abi.encode(bytes32(uint256(extreme)))
        );
        vm.expectRevert();
        hook.previewQuote(true);
    }

    function test_wrap_yieldSplitsFairly() public {
        usdc.mint(alice, 1_000e6);
        usdc.mint(address(this), 1_000e6);
        vm.prank(alice);
        usdc.approve(address(hook), type(uint256).max);
        usdc.approve(address(hook), type(uint256).max);

        vm.prank(alice);
        hook.wrapUSDC(100e6, alice);
        hook.wrapUSDC(100e6, address(this));

        uint256 t0 = block.timestamp;
        vm.warp(t0 + YEAR);
        lendingPool.updateState(address(usdc));

        uint256 aliceValue = hook.convertToUsdc(shareToken.balanceOf(alice));
        uint256 totalValue = hook.convertToUsdc(shareToken.totalSupply());
        assertGt(aliceValue, 100e6);
        assertApproxEqAbs(totalValue, hook.totalManagedAssets(), 1);
        assertApproxEqRel(aliceValue, totalValue / 2, 1e12);
    }

    function test_wrap_zeroAmount_reverts() public {
        vm.expectRevert(TrancheJITHook.ZeroAmount.selector);
        hook.wrapUSDC(0, alice);
    }

    function test_modulePrimitives_onlyModule() public {
        vm.expectRevert(abi.encodeWithSelector(TrancheJITHook.NotModule.selector, address(this)));
        hook.moduleBurn(alice, 1e18);
        vm.expectRevert(abi.encodeWithSelector(TrancheJITHook.NotModule.selector, address(this)));
        hook.modulePull(usdc, alice, 1);
        vm.expectRevert(abi.encodeWithSelector(TrancheJITHook.NotModule.selector, address(this)));
        hook.moduleSupplyIdle();
    }

    function test_setModule_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TrancheJITHook.NotOwner.selector, alice));
        hook.setModule(alice);

        address next = makeAddr("module2");
        hook.setModule(next);
        assertEq(hook.module(), next);
    }

    function test_unwrapEquity_paysNvdaAtOracle() public {
        nvda.mint(address(hook), 100e18);
        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(hook), type(uint256).max);
        vm.prank(alice);
        uint256 shares = hook.wrapUSDC(100e6, alice);

        uint256 expected = _oracleNvdaOut(hook.convertToUsdc(shares));
        uint256 before = nvda.balanceOf(alice);
        vm.prank(alice);
        uint256 out = pipe.unwrapEquity(shares, alice, expected);
        assertEq(out, expected);
        assertEq(nvda.balanceOf(alice), before + expected);
        assertEq(shareToken.balanceOf(alice), 0);
    }

    function test_unwrapEquity_staleOracle_reverts() public {
        nvda.mint(address(hook), 100e18);
        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(hook), type(uint256).max);
        vm.prank(alice);
        uint256 shares = hook.wrapUSDC(100e6, alice);

        nvdaOracle.setMaxStaleness(1);
        vm.warp(block.timestamp + 2);
        vm.prank(alice);
        vm.expectRevert(TranchePipeModule.OracleInvalid.selector);
        pipe.unwrapEquity(shares, alice, 0);
    }

    function test_unwrapProportional_paysBoth() public {
        nvda.mint(address(hook), 100e18);
        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(hook), type(uint256).max);
        vm.prank(alice);
        uint256 shares = hook.wrapUSDC(100e6, alice);

        uint256 half = shares / 2;
        uint256 usdcBefore = usdc.balanceOf(alice);
        uint256 nvdaBefore = nvda.balanceOf(alice);
        vm.prank(alice);
        (uint256 usdcOut, uint256 nvdaOut) = pipe.unwrapProportional(half, alice, 0, 0);
        assertGt(usdcOut, 0);
        assertGt(nvdaOut, 0);
        assertEq(usdc.balanceOf(alice), usdcBefore + usdcOut);
        assertEq(nvda.balanceOf(alice), nvdaBefore + nvdaOut);
    }

    function test_unwrapProportional_oracleFree() public {
        nvda.mint(address(hook), 100e18);
        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(hook), type(uint256).max);
        vm.prank(alice);
        uint256 shares = hook.wrapUSDC(100e6, alice);

        nvdaOracle.setMaxStaleness(1);
        vm.warp(block.timestamp + 2);
        vm.prank(alice);
        (uint256 usdcOut, uint256 nvdaOut) = pipe.unwrapProportional(shares, alice, 0, 0);
        assertGt(usdcOut, 0);
        assertGt(nvdaOut, 0);
    }

    function test_unwrapProportional_minOut_reverts() public {
        nvda.mint(address(hook), 100e18);
        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(hook), type(uint256).max);
        vm.prank(alice);
        uint256 shares = hook.wrapUSDC(100e6, alice);

        uint256 half = shares / 2;
        uint256 expectedUsdc = Math.mulDiv(100e6, half, shareToken.totalSupply());
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(TranchePipeModule.SlippageExceeded.selector, expectedUsdc, expectedUsdc + 1)
        );
        pipe.unwrapProportional(half, alice, expectedUsdc + 1, 0);
    }

    function test_assetComposition_bps() public {
        usdc.mint(address(hook), 800e6);
        nvda.mint(address(hook), 1e18);
        (uint256 usdcValue, uint256 equityValue, uint256 equityBps) = pipe.assetComposition();
        assertEq(usdcValue, 800e6);
        assertEq(equityValue, 200e6);
        assertEq(equityBps, 2_000);
    }

    function test_rebalanceSwap_venueUnset_reverts() public {
        usdc.mint(address(hook), 100e6);
        vm.prank(operator);
        vm.expectRevert(TranchePipeModule.RebalanceVenueUnset.selector);
        agent.submitRebalance(false, 1e6, 0, block.timestamp);
    }

    function test_rebalanceSwap_onlyController() public {
        _initVenuePool();
        vm.expectRevert(abi.encodeWithSelector(TranchePipeModule.NotController.selector, address(this)));
        pipe.rebalanceSwap(false, 1e6, 0, block.timestamp);
    }

    function test_rebalanceSwap_buyNvda() public {
        _initVenuePool();
        usdc.mint(address(hook), 1_000e6);
        uint256 amountIn = 10e6;
        uint256 minOut = _oracleFloor(_oracleNvdaOut(amountIn));
        uint256 nvdaBefore = nvda.balanceOf(address(hook));

        vm.prank(operator);
        agent.submitRebalance(false, amountIn, minOut, block.timestamp);

        uint256 gained = nvda.balanceOf(address(hook)) - nvdaBefore;
        assertGe(gained, minOut);
        (, uint256 equityValue, uint256 equityBps) = pipe.assetComposition();
        assertGt(equityValue, 0);
        assertLe(equityBps, pipe.hardMaxEquityBps());
    }

    function test_rebalanceSwap_sellNvda() public {
        _initVenuePool();
        nvda.mint(address(hook), 10e18);
        uint256 amountIn = 0.1e18;
        uint256 minOut = _oracleFloor(_oracleUsdcOut(amountIn));
        uint256 usdcBefore = usdc.balanceOf(address(hook)) + aUsdc.balanceOf(address(hook));

        vm.prank(operator);
        agent.submitRebalance(true, amountIn, minOut, block.timestamp);

        uint256 gained = usdc.balanceOf(address(hook)) + aUsdc.balanceOf(address(hook)) - usdcBefore;
        assertGe(gained, minOut);
    }

    function test_rebalanceSwap_slippageFloor() public {
        _initVenuePool();
        usdc.mint(address(hook), 1_000e6);
        uint256 floor = _oracleFloor(_oracleNvdaOut(1e6));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TranchePipeModule.SlippageBoundUnmet.selector, 0, floor));
        agent.submitRebalance(false, 1e6, 0, block.timestamp);
    }

    function test_rebalanceSwap_cap_reverts() public {
        _initVenuePool();
        pipe.setHardMaxEquityBps(1);
        usdc.mint(address(hook), 1_000e6);
        uint256 minOut = _oracleFloor(_oracleNvdaOut(10e6));
        vm.prank(operator);
        vm.expectRevert();
        agent.submitRebalance(false, 10e6, minOut, block.timestamp);
    }

    function test_rebalanceSwap_unfunded_reverts() public {
        _initVenuePool();
        risk.setEscrowFunded(false);
        usdc.mint(address(hook), 1_000e6);
        vm.prank(operator);
        vm.expectRevert(TranchePipeModule.RebalanceNotFunded.selector);
        agent.submitRebalance(false, 1e6, _oracleNvdaOut(1e6), block.timestamp);
    }

    function test_rebalance_cooldown() public {
        _initVenuePool();
        usdc.mint(address(hook), 1_000e6);
        controller.setBounds(
            StrategyController.Bounds({
                maxDeviationBps: 500,
                maxToxicityMultiplierBps: 2_500,
                maxTtl: 3_600,
                maxGracePeriod: 3_600,
                maxDeployPerSwap: 100_000e6,
                maxRebalanceSwapUsdc: 10_000e6,
                rebalanceCooldown: 60
            })
        );

        uint256 minOut = _oracleFloor(_oracleNvdaOut(1e6));
        vm.prank(operator);
        agent.submitRebalance(false, 1e6, minOut, block.timestamp);

        uint256 readyAt = block.timestamp + 60;
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(StrategyController.RebalanceCooldownActive.selector, readyAt));
        agent.submitRebalance(false, 1e6, minOut, block.timestamp);
    }

    function test_rebalance_amountTooLarge() public {
        _initVenuePool();
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(StrategyController.RebalanceTooLarge.selector, 20_000e6, 10_000e6));
        agent.submitRebalance(false, 20_000e6, 0, block.timestamp);
    }

    function test_setRebalanceVenue_mismatch() public {
        PoolKey memory bad = key;
        bad.hooks = IHooks(address(0));
        bad.currency0 = Currency.wrap(address(0xdead));
        vm.expectRevert(TranchePipeModule.RebalanceKeyMismatch.selector);
        pipe.setRebalanceVenue(bad, address(router));
    }

    function test_submitRebalance_deadlineExpired_reverts() public {
        vm.warp(100);
        uint256 deadline = block.timestamp - 1;
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(StrategyController.DeadlineExpired.selector, deadline));
        agent.submitRebalance(false, 1e6, 0, deadline);
    }

    function test_controller_pause_blocksParamsAndAllowsRiskReduction() public {
        controller.setPaused(true);

        vm.prank(operator);
        vm.expectRevert(StrategyController.IsPaused.selector);
        agent.submitParams(_defaultParams());

        vm.prank(operator);
        vm.expectRevert(StrategyController.IsPaused.selector);
        agent.submitBaseFee(4000);

        // Reducing risk (disabling quoting) stays available while paused.
        vm.prank(operator);
        agent.submitQuotingEnabled(false);
        assertEq(uint8(hook.quoteState()), uint8(TrancheJITHook.QuoteState.Rest));

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(StrategyController.NotGuardianOrOwner.selector, operator));
        controller.setPaused(false);
    }

    function test_controller_guardianCanPause() public {
        controller.setGuardian(alice);
        vm.prank(alice);
        controller.setPaused(true);
        assertTrue(controller.paused());

        vm.prank(operator);
        vm.expectRevert(StrategyController.IsPaused.selector);
        agent.submitParams(_defaultParams());

        vm.prank(alice);
        controller.setPaused(false);
        vm.prank(operator);
        agent.submitParams(_defaultParams());
    }

    function test_setBounds_invalid_reverts() public {
        StrategyController.Bounds memory b = StrategyController.Bounds({
            maxDeviationBps: 500,
            maxToxicityMultiplierBps: 2_500,
            maxTtl: 3_600,
            maxGracePeriod: 3_600,
            maxDeployPerSwap: 100_000e6,
            maxRebalanceSwapUsdc: 10_000e6,
            rebalanceCooldown: 0
        });

        b.maxDeviationBps = 5_001;
        vm.expectRevert(StrategyController.InvalidBounds.selector);
        controller.setBounds(b);

        b.maxDeviationBps = 500;
        b.maxTtl = 0;
        vm.expectRevert(StrategyController.InvalidBounds.selector);
        controller.setBounds(b);

        b.maxTtl = 3_600;
        b.maxDeployPerSwap = 0;
        vm.expectRevert(StrategyController.InvalidBounds.selector);
        controller.setBounds(b);

        b.maxDeployPerSwap = 100_000e6;
        controller.setBounds(b);
    }

    function test_baseFee_highFeeAllowed() public {
        // No fee ceiling beyond the 100% protocol maximum: extreme markets may justify ~70%.
        vm.prank(operator);
        agent.submitBaseFee(700_000);
        assertEq(hook.params().baseFee, 700_000);

        HookParams.Params memory p = _defaultParams();
        p.baseFee = 900_000;
        vm.prank(operator);
        agent.submitParams(p);
        assertEq(hook.params().baseFee, 900_000);
    }

    // ---------------------------------------------------------------- expiry / settlement

    function test_expiry_setExpiry_rules() public {
        vm.expectRevert(TrancheJITHook.ExpiryInPast.selector);
        hook.setExpiry(uint64(block.timestamp));

        uint64 ts = uint64(block.timestamp + 1 days);
        hook.setExpiry(ts);
        assertEq(hook.expiry(), ts);
        assertFalse(hook.expired());

        vm.expectRevert(TrancheJITHook.ExpiryAlreadySet.selector);
        hook.setExpiry(uint64(block.timestamp + 2 days));
    }

    function test_expiry_stopsTradingAndJit() public {
        uint64 ts = uint64(block.timestamp + 1 days);
        hook.setExpiry(ts);
        vm.warp(ts + 1);

        assertTrue(hook.expired());
        assertEq(uint8(hook.quoteState()), uint8(TrancheJITHook.QuoteState.Rest));
        assertEq(hook.effectiveMaxDeploy(), 0);
        vm.expectRevert(TrancheJITHook.QuotingOff.selector);
        hook.previewQuote(true);

        vm.expectRevert();
        router.swapExactIn(key, true, 1e6, 0, address(this), bytes(""));
    }

    function test_expiry_rebalanceBlocked() public {
        _initVenuePool();
        hook.setExpiry(uint64(block.timestamp + 1 days));
        vm.warp(block.timestamp + 2 days);

        vm.prank(address(controller));
        vm.expectRevert(TranchePipeModule.TradingClosed.selector);
        pipe.rebalanceSwap(true, 1e18, 0, block.timestamp);
    }

    function test_finalizeSettlement_notExpired_reverts() public {
        vm.expectRevert(TranchePipeModule.NotExpired.selector);
        pipe.finalizeSettlement();
    }

    function test_settlement_waterfall_pipe() public {
        MockSettlementAccountant acct = new MockSettlementAccountant();
        MockMaturedVault seniorMock = new MockMaturedVault();
        MockMaturedVault juniorMock = new MockMaturedVault();
        acct.setVaults(address(seniorMock), address(juniorMock));
        acct.setGuarantee(105e6);
        hook.setAccountant(address(acct));

        usdc.mint(address(this), 150e6);
        usdc.approve(address(pipe), type(uint256).max);
        pipe.wrapUSDC(100e6, address(seniorMock));
        pipe.wrapUSDC(50e6, address(juniorMock));
        nvda.mint(address(hook), 10e18);

        hook.setExpiry(uint64(block.timestamp + 1 days));
        vm.warp(block.timestamp + 2 days);
        pipe.finalizeSettlement();

        assertEq(seniorMock.usdcReceived(), 105e6);
        assertEq(juniorMock.usdcReceived(), 45e6);
        assertEq(juniorMock.equityReceived(), 10e18);
        assertEq(shareToken.balanceOf(address(seniorMock)), 0);
        assertEq(shareToken.balanceOf(address(juniorMock)), 0);
        assertEq(usdc.balanceOf(address(hook)), 0);
        assertEq(nvda.balanceOf(address(hook)), 0);
        assertEq(usdc.balanceOf(address(seniorMock)), 105e6);
        assertEq(usdc.balanceOf(address(juniorMock)), 45e6);
        assertEq(nvda.balanceOf(address(juniorMock)), 10e18);

        vm.expectRevert(TranchePipeModule.AlreadySettled.selector);
        pipe.finalizeSettlement();
    }

    function test_settlement_unfunded_requiresHaircut() public {
        MockSettlementAccountant acct = new MockSettlementAccountant();
        MockMaturedVault seniorMock = new MockMaturedVault();
        MockMaturedVault juniorMock = new MockMaturedVault();
        acct.setVaults(address(seniorMock), address(juniorMock));
        acct.setGuarantee(105e6);
        hook.setAccountant(address(acct));

        usdc.mint(address(this), 100e6);
        usdc.approve(address(pipe), type(uint256).max);
        pipe.wrapUSDC(100e6, address(seniorMock));
        nvda.mint(address(hook), 5e18);

        hook.setExpiry(uint64(block.timestamp + 1 days));
        vm.warp(block.timestamp + 2 days);

        vm.expectRevert(TranchePipeModule.SettlementNotReady.selector);
        pipe.finalizeSettlement();

        pipe.finalizeSettlementHaircut();
        assertEq(seniorMock.usdcReceived(), 100e6);
        assertEq(juniorMock.usdcReceived(), 0);
        assertEq(juniorMock.equityReceived(), 5e18);
    }

    function test_settleSwap_convertsEquityToUsdc() public {
        _initVenuePool();
        uint256 amountIn = 0.01e18;
        nvda.mint(address(hook), amountIn);

        vm.expectRevert(TranchePipeModule.NotExpired.selector);
        pipe.settleSwap(amountIn, 0, block.timestamp);

        hook.setExpiry(uint64(block.timestamp + 1 days));
        vm.warp(block.timestamp + 2 days);
        _setOraclePrice(ORACLE_PRICE);

        uint256 minOut = _oracleFloor(_oracleUsdcOut(amountIn));
        pipe.settleSwap(amountIn, minOut, block.timestamp);

        assertEq(nvda.balanceOf(address(hook)), 0);
        assertGe(hook.aToken().balanceOf(address(hook)), minOut);
    }
}

/// @dev Minimal `ITrancheAccountant` for pipe settlement tests (no vault code needed here; the
///      real vault maternity flows are covered in `TrancheExpiry.t.sol`).
contract MockSettlementAccountant {
    address internal _seniorVault;
    address internal _juniorVault;
    uint256 internal _guarantee;

    function setVaults(address senior_, address junior_) external {
        _seniorVault = senior_;
        _juniorVault = junior_;
    }

    function setGuarantee(uint256 guarantee_) external {
        _guarantee = guarantee_;
    }

    function seniorVault() external view returns (address) {
        return _seniorVault;
    }

    function juniorVault() external view returns (address) {
        return _juniorVault;
    }

    function seniorGuaranteeUsdc() external view returns (uint256) {
        return _guarantee;
    }

    function seniorClaim() external pure returns (uint256) {
        return 0;
    }

    function juniorClaim() external pure returns (uint256) {
        return 0;
    }

    function poolValue() external pure returns (uint256) {
        return 0;
    }

    function escrowFunded() external pure returns (bool) {
        return false;
    }

    function onTrancheDeposit(bool, uint256) external { }

    function onTrancheRedeem(bool, uint256) external { }

    function onTrancheClaim(bool, uint256) external { }

    function rebalance() external pure returns (uint256, uint256) {
        return (0, 0);
    }
}

contract MockMaturedVault {
    uint256 public usdcReceived;
    uint256 public equityReceived;

    function creditSettlement(uint256 usdcAmount, uint256 equityAmount) external {
        usdcReceived = usdcAmount;
        equityReceived = equityAmount;
    }
}
