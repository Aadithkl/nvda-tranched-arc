// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Script, console2 } from "forge-std/Script.sol";

interface ISpiralArmAgent {
    function submitApproveStrategy(address token, uint256 amount) external;
    function submitAllocateCollateral(address adapter, uint256 amount) external;
    function submitBorrow(address adapter, uint256 amount) external;
}

/// @notice Deploy the vault's IDLE NVDA into the Spiral NVDA arm.
///
///         The arm's input is NVDA, not USDG: `allocateCollateral` pulls NVDA from the vault
///         into the Morpho loop adapter, and `borrow` borrows USDG *against* that collateral
///         (sent to the vault). No USDG deposit is required.
///
///         Runs as the operator through `VaultStrategyAgent` (the only address the controller
///         accepts). Risk-up stays a deliberate operator/multisig step; the keeper only
///         de-leverages.
///
///         Env:
///           AGENT_OPERATOR_PRIVATE_KEY, STRATEGY_AGENT_ADDRESS, SPIRAL_ARM_ADAPTER,
///           NVDA_ADDRESS, SPIRAL_ARM_NVDA_AMOUNT, SPIRAL_ARM_BORROW_AMOUNT (0 = collateral only)
contract AllocateSpiralArm is Script {
    function run() external {
        uint256 key = vm.envUint("AGENT_OPERATOR_PRIVATE_KEY");
        address agent = vm.envAddress("STRATEGY_AGENT_ADDRESS");
        address adapter = vm.envAddress("SPIRAL_ARM_ADAPTER");
        address nvda = vm.envAddress("NVDA_ADDRESS");
        uint256 nvdaAmount = vm.envUint("SPIRAL_ARM_NVDA_AMOUNT");
        uint256 borrowAmount = vm.envUint("SPIRAL_ARM_BORROW_AMOUNT");

        vm.startBroadcast(key);
        // One-shot exact allowance; the module pulls NVDA from the vault.
        ISpiralArmAgent(agent).submitApproveStrategy(nvda, nvdaAmount);
        // Pull NVDA into the arm (collateral). This is the "deploy NVDA" step.
        ISpiralArmAgent(agent).submitAllocateCollateral(adapter, nvdaAmount);
        // Optional: borrow USDG against the NVDA. The proceeds go to the vault, not the arm.
        if (borrowAmount != 0) {
            ISpiralArmAgent(agent).submitBorrow(adapter, borrowAmount);
        }
        vm.stopBroadcast();

        console2.log("NVDA allocated to arm:", nvdaAmount);
        console2.log("USDG borrowed against it:", borrowAmount);
    }
}
