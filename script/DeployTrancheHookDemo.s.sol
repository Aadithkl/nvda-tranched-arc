// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Script, console2 } from "forge-std/Script.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IPoolManager } from "v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "v4-core/src/types/PoolId.sol";
import { Currency } from "v4-core/src/types/Currency.sol";
import { IHooks } from "v4-core/src/interfaces/IHooks.sol";
import { Hooks } from "v4-core/src/libraries/Hooks.sol";
import { TickMath } from "v4-core/src/libraries/TickMath.sol";
import { HookMiner } from "v4-periphery/test/shared/HookMiner.sol";
import { NVDAPriceOracle } from "../src/oracle/NVDAPriceOracle.sol";
import { TrancheJITHook } from "../src/hook/TrancheJITHook.sol";
import { StrategyController } from "../src/strategy/StrategyController.sol";
import { StrategyAgent } from "../src/strategy/StrategyAgent.sol";

contract DeployTrancheHookDemo is Script {
    using PoolIdLibrary for PoolKey;

    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    int24 internal constant INITIAL_TICK = -1499;

    function run() external {
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        address poolManager = vm.envAddress("V4_POOL_MANAGER");
        address usdc = vm.envAddress("USDC_ADDRESS");
        address eurc = vm.envAddress("EURC_ADDRESS");
        address lendingPool = vm.envAddress("LENDING_POOL");
        address operator = vm.envAddress("AGENT_OPERATOR_ADDRESS");
        uint256 eurcPrice = vm.envOr("HOOK_DEMO_EURC_PRICE", uint256(116_170_000));

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));

        NVDAPriceOracle priceOracle = new NVDAPriceOracle(8, deployer);
        priceOracle.setWriter(deployer, true);
        priceOracle.setMaxStaleness(300);
        priceOracle.updatePrice(int192(int256(eurcPrice)), 2, uint32(block.timestamp), bytes32(0));

        StrategyController controller = new StrategyController(deployer);
        StrategyAgent agent = new StrategyAgent(deployer, operator, address(controller));
        controller.setAgent(address(agent), true);

        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
                | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
        );
        bytes memory constructorArgs = abi.encode(
            IPoolManager(poolManager), IERC20(usdc), IERC20(eurc), address(priceOracle), deployer, address(controller)
        );
        bytes memory initcode = abi.encodePacked(type(TrancheJITHook).creationCode, constructorArgs);
        (address expectedHook, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, flags, type(TrancheJITHook).creationCode, constructorArgs);
        address hook = _create2(salt, initcode);
        require(hook == expectedHook, "hook address mismatch");

        TrancheJITHook(hook).setLendingPool(lendingPool);
        controller.setHook(hook);

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(usdc),
            currency1: Currency.wrap(eurc),
            fee: 0x800000,
            tickSpacing: 1,
            hooks: IHooks(hook)
        });
        TrancheJITHook(hook).initializePool(key, TickMath.getSqrtPriceAtTick(INITIAL_TICK));

        vm.stopBroadcast();

        console2.log("TrancheJITHook:", hook);
        console2.log("HookShareToken:", address(TrancheJITHook(hook).shareToken()));
        console2.log("EURCPriceOracle:", address(priceOracle));
        console2.log("StrategyController:", address(controller));
        console2.log("StrategyAgent:", address(agent));
        console2.log("PoolId:");
        console2.logBytes32(PoolId.unwrap(key.toId()));
        console2.log("InitialTick:", INITIAL_TICK);
        console2.log("EURC oracle mid (8d):", eurcPrice);
        console2.log("LendingPool:", lendingPool);
        console2.log("aToken:", address(TrancheJITHook(hook).aToken()));
        console2.log("Operator:", operator);
    }

    function _create2(bytes32 salt, bytes memory initcode) internal returns (address expected) {
        expected = address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, salt, keccak256(initcode)))))
        );
        if (expected.code.length != 0) {
            return expected;
        }
        (bool success,) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initcode));
        require(success, "create2 deploy failed");
        require(expected.code.length != 0, "no code at expected address");
    }
}
