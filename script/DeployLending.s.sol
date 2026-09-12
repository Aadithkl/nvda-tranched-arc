// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Script, console2 } from "forge-std/Script.sol";
import { DefaultReserveInterestRateStrategy } from "../src/lending/DefaultReserveInterestRateStrategy.sol";
import { LendingPool } from "../src/lending/LendingPool.sol";
import { LendingPoolAddressesProvider } from "../src/lending/LendingPoolAddressesProvider.sol";
import { LendingPoolConfigurator } from "../src/lending/LendingPoolConfigurator.sol";
import { PeggedPriceOracle } from "../src/lending/PeggedPriceOracle.sol";

contract DeployLending is Script {
    function run() external {
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        address usdc = vm.envAddress("USDC_ADDRESS");
        address nvda = vm.envAddress("EURC_ADDRESS");
        uint256 nvdaPrice = vm.envOr("EURC_PEGGED_PRICE", uint256(1.1617e8));

        uint256 usdcPeg = vm.envOr("USDC_PEGGED_PRICE", uint256(1e8));
        uint256 baseRate = vm.envOr("LENDING_BASE_BORROW_RATE", uint256(0));
        uint256 slope1 = vm.envOr("LENDING_RATE_SLOPE1", uint256(0.04e27));
        uint256 slope2 = vm.envOr("LENDING_RATE_SLOPE2", uint256(0.6e27));
        uint256 optimal = vm.envOr("LENDING_OPTIMAL_UTILIZATION", uint256(0.8e27));
        uint256 ltv = vm.envOr("LENDING_LTV", uint256(7_500));
        uint256 liquidationThreshold = vm.envOr("LENDING_LIQUIDATION_THRESHOLD", uint256(8_000));
        uint256 liquidationBonus = vm.envOr("LENDING_LIQUIDATION_BONUS", uint256(10_500));
        uint256 reserveFactor = vm.envOr("LENDING_RESERVE_FACTOR", uint256(1_000));

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));

        LendingPoolAddressesProvider provider = new LendingPoolAddressesProvider("nvda-tranched-arc");
        PeggedPriceOracle oracle = new PeggedPriceOracle(deployer);
        LendingPool pool = new LendingPool(address(provider));
        LendingPoolConfigurator configurator = new LendingPoolConfigurator(address(provider));

        provider.setAddress(provider.PRICE_ORACLE(), address(oracle));
        provider.setAddress(provider.LENDING_POOL(), address(pool));
        provider.setAddress(provider.LENDING_POOL_CONFIGURATOR(), address(configurator));

        oracle.setAssetPrice(usdc, usdcPeg);
        oracle.setAssetPrice(nvda, nvdaPrice);

        DefaultReserveInterestRateStrategy strategy =
            new DefaultReserveInterestRateStrategy(baseRate, slope1, slope2, optimal);

        (address aUsdc, address dUsdc) = configurator.initReserve(usdc, 6, "Aave Arc USDC", "aUSDC", address(strategy));
        (address aNvda, address dNvda) = configurator.initReserve(nvda, 6, "Aave Arc EURC", "aEURC", address(strategy));

        configurator.configureReserveAsCollateral(usdc, ltv, liquidationThreshold, liquidationBonus);
        configurator.enableBorrowingOnReserve(usdc, true);
        configurator.setReserveFactor(usdc, reserveFactor);

        configurator.configureReserveAsCollateral(nvda, ltv, liquidationThreshold, liquidationBonus);
        configurator.enableBorrowingOnReserve(nvda, true);
        configurator.setReserveFactor(nvda, reserveFactor);

        vm.stopBroadcast();

        console2.log("LendingPoolAddressesProvider:", address(provider));
        console2.log("PeggedPriceOracle:", address(oracle));
        console2.log("LendingPool:", address(pool));
        console2.log("LendingPoolConfigurator:", address(configurator));
        console2.log("DefaultReserveInterestRateStrategy:", address(strategy));
        console2.log("aUSDC:", aUsdc);
        console2.log("dUSDC:", dUsdc);
        console2.log("aEURC:", aNvda);
        console2.log("dEURC:", dNvda);
        console2.log("USDC peg (8d):", usdcPeg);
        console2.log("EURC peg (8d):", nvdaPrice);
    }
}
