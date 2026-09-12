// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Script, console2 } from "forge-std/Script.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { TrancheAccountant } from "../src/vaults/TrancheAccountant.sol";
import { SeniorVault } from "../src/vaults/SeniorVault.sol";
import { JuniorVault } from "../src/vaults/JuniorVault.sol";
import { StrategyController } from "../src/strategy/StrategyController.sol";
import { IHookSharePipe } from "../src/interfaces/IHookSharePipe.sol";

interface IHookConfig {
    function shareToken() external view returns (address);
    function setAccountant(address newAccountant) external;
    function setJitEnabled(bool enabled) external;
    function setLiquidityGuard(bool enabled) external;
}

/// @notice Step 2 of the stack deploy: accountant + senior/junior vaults over the hook share,
///         then wire hook/accountant/controller. Requires HOOK_ADDRESS from step 1.
contract DeployTrancheStack is Script {
    function run() external {
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        address hook = vm.envAddress("HOOK_ADDRESS");
        address usdc = vm.envAddress("USDC_ADDRESS");
        address controllerAddr = vm.envAddress("HOOK_DEMO_CONTROLLER");
        address operator = vm.envAddress("AGENT_OPERATOR_ADDRESS");

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));

        IHookConfig h = IHookConfig(hook);
        address share = h.shareToken();

        TrancheAccountant accountant = new TrancheAccountant(deployer);
        accountant.setKeeper(operator);

        SeniorVault senior =
            new SeniorVault(IERC20(share), IERC20(usdc), IHookSharePipe(hook), deployer, address(accountant));
        JuniorVault junior =
            new JuniorVault(IERC20(share), IERC20(usdc), IHookSharePipe(hook), deployer, address(accountant));

        accountant.setHook(hook);
        accountant.setVaults(address(senior), address(junior));

        h.setAccountant(address(accountant));
        h.setJitEnabled(true);
        h.setLiquidityGuard(true);
        StrategyController(controllerAddr).setHook(hook);

        vm.stopBroadcast();

        console2.log("TrancheJITHook:", hook);
        console2.log("HookShareToken:", share);
        console2.log("TrancheAccountant:", address(accountant));
        console2.log("SeniorVault:", address(senior));
        console2.log("JuniorVault:", address(junior));
        console2.log("StrategyController:", controllerAddr);
        console2.log("Keeper:", operator);
    }
}
