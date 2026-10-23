// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Script, console2 } from "forge-std/Script.sol";
import { IMorpho } from "../src/adapters/IMorpho.sol";
import { MorphoBlueLendAdapter } from "../src/adapters/MorphoBlueLendAdapter.sol";
import { StrategyModule } from "../src/adapters/StrategyModule.sol";

/// @notice Deploys the plain Morpho USDG lending arm (loan-side supply only).
///
///         This is the second arm: idle/borrowed USDG is supplied to a USDG Morpho
///         market and earns the market supply APY. It is not a loop adapter and is
///         redemption-safe.
///
///         Env:
///           STRATEGY_MODULE_ADDRESS, ROBINHOOD_MORPHO_BLUE, QUOTE_ADDRESS
///           USDG_LEND_COLLATERAL, USDG_LEND_ORACLE, USDG_LEND_IRM, USDG_LEND_LLTV
///           USDG_LEND_ABS_CAP, USDG_LEND_REL_CAP_BPS (default 2000)
///           USDG_LEND_EXECUTE (default false; set true after the module timelock)
contract DeployUsdgLendArm is Script {
    function run() external {
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));

        address module = vm.envAddress("STRATEGY_MODULE_ADDRESS");
        address morpho = vm.envAddress("ROBINHOOD_MORPHO_BLUE");
        address usdg = vm.envAddress("QUOTE_ADDRESS");

        IMorpho.MarketParams memory params = IMorpho.MarketParams({
            loanToken: usdg,
            collateralToken: vm.envAddress("USDG_LEND_COLLATERAL"),
            oracle: vm.envAddress("USDG_LEND_ORACLE"),
            irm: vm.envAddress("USDG_LEND_IRM"),
            lltv: vm.envUint("USDG_LEND_LLTV")
        });

        MorphoBlueLendAdapter adapter = new MorphoBlueLendAdapter(module, morpho, params, usdg);
        console2.log("USDG lend arm adapter:", address(adapter));
        console2.log("Morpho market id:", vm.toString(adapter.marketId()));

        uint256 absCap = vm.envUint("USDG_LEND_ABS_CAP");
        uint16 relCap = uint16(vm.envOr("USDG_LEND_REL_CAP_BPS", uint256(2_000)));
        StrategyModule(module).submitAdapter(address(adapter), true, false, absCap, relCap);

        if (vm.envOr("USDG_LEND_EXECUTE", false)) {
            StrategyModule(module).executeAdapter(address(adapter));
            console2.log("USDG lend arm ENABLED");
        } else {
            console2.log("USDG lend arm submitted (timelocked). Re-run with USDG_LEND_EXECUTE=true.");
        }

        vm.stopBroadcast();
    }
}
