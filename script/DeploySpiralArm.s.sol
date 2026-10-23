// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Script, console2 } from "forge-std/Script.sol";
import { IMorpho } from "../src/adapters/IMorpho.sol";
import { MorphoLoopAdapter } from "../src/adapters/MorphoLoopAdapter.sol";
import { StrategyModule } from "../src/adapters/StrategyModule.sol";

/// @notice Adds the Spiral NVDA strategy as ONE loop arm on the existing Morpho module.
///
///         Spiral's NVDA "vault" is a composition that posts NVDA as collateral to NetNet's
///         Morpho market and borrows USDG. That is exactly the repo's `MorphoLoopAdapter`, so
///         the arm is a normal module adapter — no bespoke sleeve, no separate custody.
///
///         Safe rollout: `submitAdapter` schedules the arm behind the module's timelock
///         (default 24h). Run this script once to deploy + submit, then again with
///         `SPIRAL_ARM_EXECUTE=true` after the timelock to enable it.
///
///         Env:
///           STRATEGY_MODULE_ADDRESS, ROBINHOOD_MORPHO_BLUE, QUOTE_ADDRESS, NVDA_ADDRESS
///           SPIRAL_NVDA_ORACLE, SPIRAL_NVDA_IRM, SPIRAL_NVDA_LLTV (default 625e15)
///           SPIRAL_NVDA_TARGET_LTV_OF_LLTV_BPS (default 4700 = 29.375% LTV on a 62.5% market)
///           SPIRAL_NVDA_MIN_HEALTH_FACTOR (default 1.5e18)
///           SPIRAL_ARM_ABS_CAP, SPIRAL_ARM_REL_CAP_BPS (default 2000 = 20% NAV)
///           SPIRAL_ARM_CONFIGURE (default true), SPIRAL_ARM_EXECUTE (default false)
contract DeploySpiralArm is Script {
    function run() external {
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));

        address module = vm.envAddress("STRATEGY_MODULE_ADDRESS");
        address morpho = vm.envAddress("ROBINHOOD_MORPHO_BLUE");
        address usdg = vm.envAddress("QUOTE_ADDRESS");
        address nvda = vm.envAddress("NVDA_ADDRESS");

        IMorpho.MarketParams memory params = IMorpho.MarketParams({
            loanToken: usdg,
            collateralToken: nvda,
            oracle: vm.envAddress("SPIRAL_NVDA_ORACLE"),
            irm: vm.envAddress("SPIRAL_NVDA_IRM"),
            lltv: vm.envUint("SPIRAL_NVDA_LLTV")
        });

        uint16 targetBps = uint16(vm.envOr("SPIRAL_NVDA_TARGET_LTV_OF_LLTV_BPS", uint256(4_700)));
        uint256 minHealth = vm.envOr("SPIRAL_NVDA_MIN_HEALTH_FACTOR", uint256(1.5e18));

        MorphoLoopAdapter adapter = new MorphoLoopAdapter(module, morpho, params, usdg, targetBps, minHealth);
        console2.log("Spiral NVDA arm adapter:", address(adapter));
        console2.log("Morpho market id:", vm.toString(adapter.marketId()));

        if (vm.envOr("SPIRAL_ARM_CONFIGURE", true)) {
            StrategyModule(module).setCanonicalMorpho(morpho);
            StrategyModule(module).setOracleAllowed(params.oracle, true);
            StrategyModule(module).setOracleAllowlistOn(true);
        }

        uint256 absCap = vm.envUint("SPIRAL_ARM_ABS_CAP");
        uint16 relCap = uint16(vm.envOr("SPIRAL_ARM_REL_CAP_BPS", uint256(2_000)));
        StrategyModule(module).submitAdapter(address(adapter), false, true, absCap, relCap);

        if (vm.envOr("SPIRAL_ARM_EXECUTE", false)) {
            StrategyModule(module).executeAdapter(address(adapter));
            console2.log("Spiral NVDA arm ENABLED");
        } else {
            console2.log("Spiral NVDA arm submitted (timelocked). Re-run with SPIRAL_ARM_EXECUTE=true.");
        }

        vm.stopBroadcast();
    }
}
