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
import { MockRiskAccountant } from "../../src/test-only/MockRiskAccountant.sol";
import { MockToken } from "../../src/test-only/MockToken.sol";

contract TrancheJITHookTest is Test {
    using PoolIdLibrary for PoolKey;

    uint256 internal constant YEAR = 365 days;
    uint256 internal constant LIQUIDITY = 1e12;
    uint256 internal constant ORACLE_PRICE = 200e8;

    PoolManager internal manager;
    DemoRouter internal router;
    MockToken internal usdc;
    MockToken internal nvda;

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
    HookShareToken internal shareToken;
    MockRiskAccountant internal risk;

    PoolKey internal key;
    PoolId internal poolId;
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
        usdc = new MockToken("USD Coin", "mUSDC", 6);
        nvda = new MockToken("NVIDIA", "mNVDA", 18);
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

    function _defaultParams() internal pure returns (HookParams.Params memory) {
        return HookParams.Params({
            quotingEnabled: true,
            baseFee: 3000,
            maxSurgeFee: 30_000,
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

    function test_quote_surgeCappedAtMaxSurgeFee() public {
        _setOraclePrice(201e8);
        bool equityIsToken1 = usdcIsToken0;
        (uint24 buyFee,,,) = hook.previewQuote(equityIsToken1);
        assertEq(buyFee, 30_000);
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

    function test_unsetAccountant_blocksRiskBudget() public {
        hook.setAccountant(address(0));
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
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(StrategyController.BaseFeeTooHigh.selector, 20_000, 10_000));
        agent.submitBaseFee(20_000);

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
}
