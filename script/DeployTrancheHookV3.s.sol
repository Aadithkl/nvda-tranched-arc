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
import { TrancheJITHook } from "../src/hook/TrancheJITHook.sol";
import { TranchePipeModule } from "../src/periphery/TranchePipeModule.sol";
import { StrategyController } from "../src/strategy/StrategyController.sol";

/// @notice Step 1 of the v3 (dual-token USDC/NVDA) stack deploy: JIT hook at a mined address,
///         pool initialization, lending wiring, controller re-point, optional rebalance venue.
///         All token/oracle/venue addresses come from env so they can be inserted later.
contract DeployTrancheHookV3 is Script {
    using PoolIdLibrary for PoolKey;

    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() external {
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        address poolManager = vm.envAddress("V4_POOL_MANAGER");
        address usdc = vm.envAddress("USDC_ADDRESS");
        address nvda = vm.envAddress("NVDA_ADDRESS");
        address priceOracle = vm.envOr("NVDA_ORACLE", address(0));
        if (priceOracle == address(0)) priceOracle = vm.envAddress("HOOK_DEMO_ORACLE");
        address lendingPool = vm.envOr("LENDING_POOL", address(0));
        address controllerAddr = vm.envAddress("HOOK_DEMO_CONTROLLER");

        int24 tickSpacing = int24(vm.envOr("V3_TICK_SPACING", int256(60)));
        int24 initialTick = int24(vm.envInt("V3_INITIAL_TICK"));
        uint16 hardCapBps = uint16(vm.envOr("V3_HARD_CAP_BPS", uint256(8_000)));

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));

        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
                | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
        );
        bytes memory constructorArgs =
            abi.encode(IPoolManager(poolManager), IERC20(usdc), IERC20(nvda), priceOracle, deployer, controllerAddr);
        bytes memory initcode = abi.encodePacked(type(TrancheJITHook).creationCode, constructorArgs);
        (address expectedHook, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, flags, type(TrancheJITHook).creationCode, constructorArgs);
        address hook = _create2(salt, initcode);
        require(hook == expectedHook, "hook address mismatch");

        TrancheJITHook h = TrancheJITHook(hook);
        if (lendingPool != address(0)) h.setLendingPool(lendingPool);

        address token0 = usdc < nvda ? usdc : nvda;
        address token1 = usdc < nvda ? nvda : usdc;
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(token0),
            currency1: Currency.wrap(token1),
            fee: 0x800000,
            tickSpacing: tickSpacing,
            hooks: IHooks(hook)
        });
        h.initializePool(key, TickMath.getSqrtPriceAtTick(initialTick));

        TranchePipeModule pipe = new TranchePipeModule(hook, deployer);
        h.setModule(address(pipe));
        pipe.setController(controllerAddr);
        pipe.setHardMaxEquityBps(hardCapBps);

        StrategyController controller = StrategyController(controllerAddr);
        controller.setHook(hook);
        controller.setRebalanceTarget(address(pipe));
        _maybeSetVenue(pipe, token0, token1);

        vm.stopBroadcast();

        console2.log("TrancheJITHook:", hook);
        console2.log("HookShareToken:", address(h.shareToken()));
        console2.log("TranchePipeModule:", address(pipe));
        console2.log("StrategyController:", controllerAddr);
        console2.log("LendingPool:", lendingPool);
        console2.log("NVDA oracle:", priceOracle);
        console2.log("PoolId:");
        console2.logBytes32(PoolId.unwrap(key.toId()));
        console2.log("InitialTick:", initialTick);
        console2.log("TickSpacing:", tickSpacing);
        console2.log("HardMaxEquityBps:", hardCapBps);
    }

    function _maybeSetVenue(TranchePipeModule pipe, address token0, address token1) internal {
        address router = vm.envOr("REBALANCE_ROUTER", address(0));
        if (router == address(0)) return;
        uint24 fee = uint24(vm.envUint("REBALANCE_POOL_FEE"));
        int24 spacing = int24(vm.envInt("REBALANCE_TICK_SPACING"));
        PoolKey memory venueKey = PoolKey({
            currency0: Currency.wrap(token0),
            currency1: Currency.wrap(token1),
            fee: fee,
            tickSpacing: spacing,
            hooks: IHooks(address(0))
        });
        pipe.setRebalanceVenue(venueKey, router);
        console2.log("RebalanceRouter:", router);
        console2.log("RebalancePoolId:");
        console2.logBytes32(PoolId.unwrap(venueKey.toId()));
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
