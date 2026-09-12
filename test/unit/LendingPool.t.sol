// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { DefaultReserveInterestRateStrategy } from "../../src/lending/DefaultReserveInterestRateStrategy.sol";
import { LendingPool } from "../../src/lending/LendingPool.sol";
import { LendingPoolAddressesProvider } from "../../src/lending/LendingPoolAddressesProvider.sol";
import { LendingPoolConfigurator } from "../../src/lending/LendingPoolConfigurator.sol";
import { PeggedPriceOracle } from "../../src/lending/PeggedPriceOracle.sol";
import { AToken } from "../../src/lending/AToken.sol";
import { VariableDebtToken } from "../../src/lending/VariableDebtToken.sol";
import { DataTypes } from "../../src/lending/libraries/DataTypes.sol";
import { TestToken } from "../../src/test-only/TestToken.sol";

contract LendingPoolTest is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant RAY = 1e27;
    uint256 internal constant YEAR = 365 days;

    TestToken internal usdc;
    TestToken internal nvda;

    LendingPoolAddressesProvider internal provider;
    PeggedPriceOracle internal oracle;
    LendingPool internal pool;
    LendingPoolConfigurator internal configurator;
    DefaultReserveInterestRateStrategy internal strategy;

    AToken internal aUsdc;
    AToken internal aNvda;
    VariableDebtToken internal dUsdc;
    VariableDebtToken internal dNvda;

    address internal alice;
    address internal bob;

    function setUp() public {
        alice = makeAddr("alice");
        bob = makeAddr("bob");

        usdc = new TestToken("USD Coin", "mUSDC", 6);
        nvda = new TestToken("NVIDIA", "mNVDA", 18);

        provider = new LendingPoolAddressesProvider("nvda-tranched-arc");
        oracle = new PeggedPriceOracle(address(this));
        pool = new LendingPool(address(provider));
        configurator = new LendingPoolConfigurator(address(provider));

        provider.setAddress(provider.PRICE_ORACLE(), address(oracle));
        provider.setAddress(provider.LENDING_POOL(), address(pool));
        provider.setAddress(provider.LENDING_POOL_CONFIGURATOR(), address(configurator));

        oracle.setAssetPrice(address(usdc), 1e8);
        oracle.setAssetPrice(address(nvda), 200e8);

        strategy = new DefaultReserveInterestRateStrategy(0, 0.04e27, 0.6e27, 0.8e27);

        (address aUsdcAddr, address dUsdcAddr) =
            configurator.initReserve(address(usdc), 6, "Aave Arc USDC", "aUSDC", address(strategy));
        (address aNvdaAddr, address dNvdaAddr) =
            configurator.initReserve(address(nvda), 18, "Aave Arc NVDA", "aNVDA", address(strategy));
        aUsdc = AToken(aUsdcAddr);
        aNvda = AToken(aNvdaAddr);
        dUsdc = VariableDebtToken(dUsdcAddr);
        dNvda = VariableDebtToken(dNvdaAddr);

        configurator.configureReserveAsCollateral(address(usdc), 7500, 8000, 10500);
        configurator.enableBorrowingOnReserve(address(usdc), true);
        configurator.setReserveFactor(address(usdc), 1000);
        configurator.configureReserveAsCollateral(address(nvda), 7500, 8000, 10500);
        configurator.enableBorrowingOnReserve(address(nvda), true);
        configurator.setReserveFactor(address(nvda), 1000);

        usdc.mint(alice, 1_000_000e6);
        usdc.mint(bob, 1_000_000e6);
        nvda.mint(alice, 1_000_000e18);
        nvda.mint(bob, 1_000_000e18);

        vm.prank(alice);
        usdc.approve(address(pool), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(pool), type(uint256).max);
        vm.prank(alice);
        nvda.approve(address(pool), type(uint256).max);
        vm.prank(bob);
        nvda.approve(address(pool), type(uint256).max);
    }

    function _deposit(address user, TestToken token, uint256 amount) internal {
        vm.prank(user);
        pool.deposit(address(token), amount, user, 0);
    }

    function test_initReserve_setsReserveData() public view {
        DataTypes.ReserveData memory data = pool.getReserveData(address(usdc));
        assertEq(data.aTokenAddress, address(aUsdc));
        assertEq(data.variableDebtTokenAddress, address(dUsdc));
        assertEq(data.interestRateStrategyAddress, address(strategy));
        assertEq(data.liquidityIndex, uint128(RAY));
        assertEq(data.variableBorrowIndex, uint128(RAY));
        assertEq(data.id, 0);
        assertEq(pool.getReservesList().length, 2);

        DataTypes.ReserveData memory nvdaData = pool.getReserveData(address(nvda));
        assertEq(nvdaData.id, 1);
        assertEq(nvdaData.aTokenAddress, address(aNvda));
    }

    function test_deposit_mintsAToken() public {
        _deposit(alice, usdc, 1_000e6);
        assertEq(aUsdc.balanceOf(alice), 1_000e6);
        assertEq(aUsdc.scaledBalanceOf(alice), 1_000e6);
        assertEq(usdc.balanceOf(address(aUsdc)), 1_000e6);
        assertEq(pool.getReserveNormalizedIncome(address(usdc)), RAY);
    }

    function test_deposit_zero_reverts() public {
        vm.prank(alice);
        vm.expectRevert(LendingPool.InvalidAmount.selector);
        pool.deposit(address(usdc), 0, alice, 0);
    }

    function test_deposit_unknownReserve_reverts() public {
        TestToken other = new TestToken("Other", "OTH", 18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LendingPool.ReserveNotInitialized.selector, address(other)));
        pool.deposit(address(other), 1e18, alice, 0);
    }

    function test_withdraw_partialAndFull() public {
        _deposit(alice, usdc, 1_000e6);

        vm.prank(alice);
        uint256 withdrawn = pool.withdraw(address(usdc), 400e6, alice);
        assertEq(withdrawn, 400e6);
        assertEq(aUsdc.balanceOf(alice), 600e6);
        assertEq(usdc.balanceOf(alice), 1_000_000e6 - 600e6);

        vm.prank(alice);
        withdrawn = pool.withdraw(address(usdc), type(uint256).max, alice);
        assertEq(withdrawn, 600e6);
        assertEq(aUsdc.balanceOf(alice), 0);
        assertEq(usdc.balanceOf(alice), 1_000_000e6);
    }

    function test_atoken_transferMovesUnderlyingValue() public {
        _deposit(alice, usdc, 1_000e6);
        vm.prank(alice);
        aUsdc.transfer(bob, 250e6);
        assertEq(aUsdc.balanceOf(alice), 750e6);
        assertEq(aUsdc.balanceOf(bob), 250e6);

        vm.prank(bob);
        pool.withdraw(address(usdc), type(uint256).max, bob);
        assertEq(usdc.balanceOf(bob), 1_000_000e6 + 250e6);
    }

    function test_borrow_and_repay() public {
        _deposit(bob, usdc, 2_000e6);

        vm.prank(bob);
        pool.borrow(address(usdc), 1_000e6, 2, 0, bob);
        assertEq(dUsdc.balanceOf(bob), 1_000e6);
        assertEq(usdc.balanceOf(bob), 1_000_000e6 - 2_000e6 + 1_000e6);

        vm.prank(bob);
        uint256 repaid = pool.repay(address(usdc), 400e6, 2, bob);
        assertEq(repaid, 400e6);
        assertEq(dUsdc.balanceOf(bob), 600e6);

        vm.prank(bob);
        repaid = pool.repay(address(usdc), type(uint256).max, 2, bob);
        assertEq(repaid, 600e6);
        assertEq(dUsdc.balanceOf(bob), 0);
    }

    function test_borrow_noCollateral_reverts() public {
        _deposit(alice, usdc, 1_000e6);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(LendingPool.BorrowCapacityExceeded.selector, 100e6, 0));
        pool.borrow(address(usdc), 100e6, 2, 0, bob);
    }

    function test_borrow_exceedsLtv_reverts() public {
        _deposit(bob, usdc, 1_000e6);
        vm.prank(bob);
        pool.borrow(address(usdc), 750e6, 2, 0, bob);

        vm.prank(bob);
        vm.expectRevert();
        pool.borrow(address(usdc), 1e6, 2, 0, bob);
    }

    function test_borrow_invalidRateMode_reverts() public {
        _deposit(bob, usdc, 1_000e6);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(LendingPool.InvalidRateMode.selector, 1));
        pool.borrow(address(usdc), 100e6, 1, 0, bob);
    }

    function test_borrow_onBehalfOfOther_reverts() public {
        _deposit(bob, usdc, 1_000e6);
        vm.prank(bob);
        vm.expectRevert(LendingPool.SelfBorrowOnly.selector);
        pool.borrow(address(usdc), 100e6, 2, 0, alice);
    }

    function test_withdraw_blockedByInsufficientLiquidity() public {
        _deposit(alice, usdc, 1_500e6);
        _deposit(bob, nvda, 12_000e18);

        vm.prank(bob);
        pool.borrow(address(usdc), 1_400e6, 2, 0, bob);

        vm.prank(alice);
        vm.expectRevert(LendingPool.InsufficientLiquidity.selector);
        pool.withdraw(address(usdc), 1_000e6, alice);
    }

    function test_getUserAccountData() public {
        _deposit(bob, usdc, 1_000e6);
        vm.prank(bob);
        pool.borrow(address(usdc), 500e6, 2, 0, bob);

        (uint256 collateral, uint256 debt, uint256 availableBorrows, uint256 threshold, uint256 ltv, uint256 hf) =
            pool.getUserAccountData(bob);

        assertEq(collateral, 1_000e8);
        assertEq(debt, 500e8);
        assertEq(availableBorrows, 250e8);
        assertEq(threshold, 8_000);
        assertEq(ltv, 7_500);
        assertEq(hf, 1.6e18);
    }

    function test_interest_accrues_toSuppliersAndDebt() public {
        _deposit(alice, usdc, 10_000e6);
        _deposit(bob, usdc, 10_000e6);

        vm.prank(bob);
        pool.borrow(address(usdc), 5_000e6, 2, 0, bob);

        vm.warp(block.timestamp + YEAR);
        pool.updateState(address(usdc));

        DataTypes.ReserveData memory data = pool.getReserveData(address(usdc));
        assertGt(data.liquidityIndex, uint128(RAY));
        assertGt(data.variableBorrowIndex, uint128(RAY));
        assertGt(data.currentLiquidityRate, 0);
        assertGt(data.currentVariableBorrowRate, 0);

        assertGt(aUsdc.balanceOf(alice), 10_000e6);
        assertGt(dUsdc.balanceOf(bob), 5_000e6);
        assertLt(data.currentLiquidityRate, data.currentVariableBorrowRate);
    }

    function test_multiMarket_isolatedIndexes() public {
        _deposit(alice, usdc, 10_000e6);
        _deposit(bob, nvda, 10_000e18);
        _deposit(alice, nvda, 10_000e18);

        vm.prank(alice);
        pool.borrow(address(usdc), 3_000e6, 2, 0, alice);

        vm.warp(block.timestamp + YEAR);
        pool.updateState(address(usdc));

        assertGt(pool.getReserveNormalizedIncome(address(usdc)), RAY);
        assertEq(pool.getReserveNormalizedIncome(address(nvda)), RAY);
        assertGt(aUsdc.balanceOf(alice), 10_000e6);
        assertEq(aNvda.balanceOf(alice), 10_000e18);
    }

    function test_crossMarket_collateral_nvdaBorrow() public {
        _deposit(alice, usdc, 10_000e6);
        _deposit(bob, nvda, 10_000e18);

        vm.prank(bob);
        pool.borrow(address(usdc), 5_000e6, 2, 0, bob);
        assertEq(dUsdc.balanceOf(bob), 5_000e6);

        (uint256 collateral, uint256 debt,,,, uint256 hf) = pool.getUserAccountData(bob);
        assertEq(collateral, uint256(10_000e18) * 200e8 / 1e18);
        assertEq(debt, 5_000e8);
        assertGt(hf, 1e18);
    }

    function test_freeze_blocksDepositButNotWithdraw() public {
        _deposit(alice, usdc, 1_000e6);

        configurator.setReserveFreeze(address(usdc), true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LendingPool.ReserveFrozen.selector, address(usdc)));
        pool.deposit(address(usdc), 100e6, alice, 0);

        vm.prank(alice);
        pool.withdraw(address(usdc), 500e6, alice);
        assertEq(aUsdc.balanceOf(alice), 500e6);
    }

    function test_deactivate_blocksOperations() public {
        _deposit(alice, usdc, 1_000e6);
        configurator.setReserveActive(address(usdc), false);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LendingPool.ReserveInactive.selector, address(usdc)));
        pool.deposit(address(usdc), 100e6, alice, 0);
    }

    function test_pause_blocksDepositsNotRepays() public {
        _deposit(bob, usdc, 2_000e6);
        vm.prank(bob);
        pool.borrow(address(usdc), 1_000e6, 2, 0, bob);

        pool.setPaused(true);

        vm.prank(alice);
        vm.expectRevert(LendingPool.IsPaused.selector);
        pool.deposit(address(usdc), 100e6, alice, 0);

        vm.prank(bob);
        pool.repay(address(usdc), 100e6, 2, bob);
        assertEq(dUsdc.balanceOf(bob), 900e6);
    }

    function test_configurator_onlyPoolAdmin() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LendingPoolConfigurator.NotPoolAdmin.selector, alice));
        configurator.configureReserveAsCollateral(address(usdc), 5_000, 6_000, 10_500);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LendingPool.NotConfigurator.selector, alice));
        pool.setReserveBorrowing(address(usdc), false);
    }

    function test_setPaused_onlyPoolAdmin() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LendingPool.NotPoolAdmin.selector, alice));
        pool.setPaused(true);
    }

    function test_reserveFactor_reducesSupplyRate() public {
        uint256 t0 = block.timestamp;
        configurator.setReserveFactor(address(usdc), 5_000);
        _deposit(alice, usdc, 10_000e6);
        _deposit(bob, usdc, 10_000e6);
        vm.prank(bob);
        pool.borrow(address(usdc), 5_000e6, 2, 0, bob);

        vm.warp(t0 + YEAR);
        pool.updateState(address(usdc));
        (uint256 liquidityRateWithHighFactor,,) = _rates();

        configurator.setReserveFactor(address(usdc), 0);
        vm.warp(t0 + 2 * YEAR);
        pool.updateState(address(usdc));
        (uint256 liquidityRateWithZeroFactor,,) = _rates();

        assertGt(liquidityRateWithZeroFactor, liquidityRateWithHighFactor);
    }

    function test_rateModel_aboveOptimalUtilization() public {
        configurator.configureReserveAsCollateral(address(usdc), 9500, 9800, 10500);
        _deposit(alice, usdc, 10_000e6);
        _deposit(bob, usdc, 100_000e6);
        vm.prank(bob);
        pool.borrow(address(usdc), 90_000e6, 2, 0, bob);

        vm.warp(block.timestamp + 1);
        pool.updateState(address(usdc));
        (,, uint256 variableBorrowRate) = _rates();
        assertGt(variableBorrowRate, 0.04e27);
        assertLt(variableBorrowRate, 0.64e27);
    }

    function _rates() internal view returns (uint256 liquidityRate, uint256 stableRate, uint256 variableRate) {
        DataTypes.ReserveData memory data = pool.getReserveData(address(usdc));
        return (data.currentLiquidityRate, data.currentStableBorrowRate, data.currentVariableBorrowRate);
    }

    function test_oracle_pegs() public view {
        assertEq(oracle.getAssetPrice(address(usdc)), 1e8);
        assertEq(oracle.getAssetPrice(address(nvda)), 200e8);
        assertEq(oracle.BASE_CURRENCY_UNIT(), 1e8);
    }

    function test_oracle_unsetReverts() public {
        TestToken other = new TestToken("Other", "OTH", 18);
        vm.expectRevert(abi.encodeWithSelector(PeggedPriceOracle.PriceNotSet.selector, address(other)));
        oracle.getAssetPrice(address(other));
    }

    function test_oracle_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        oracle.setAssetPrice(address(usdc), 2e8);
    }

    function test_provider_registry() public view {
        assertEq(provider.getLendingPool(), address(pool));
        assertEq(provider.getLendingPoolConfigurator(), address(configurator));
        assertEq(provider.getPriceOracle(), address(oracle));
        assertEq(provider.getPoolAdmin(), address(this));
        assertEq(provider.marketId(), "nvda-tranched-arc");
    }

    function test_aToken_onlyPoolCanMintBurn() public {
        vm.expectRevert(abi.encodeWithSelector(AToken.NotPool.selector, address(this)));
        aUsdc.mint(alice, 1e6);

        vm.expectRevert(abi.encodeWithSelector(VariableDebtToken.NotPool.selector, address(this)));
        dUsdc.mint(alice, 1e6);
    }

    function test_getUserAccountData_noDebt_maxHealthFactor() public {
        _deposit(alice, usdc, 1_000e6);
        (,,,,, uint256 hf) = pool.getUserAccountData(alice);
        assertEq(hf, type(uint256).max);
    }
}
