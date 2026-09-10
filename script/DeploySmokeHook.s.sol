// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Script, console2 } from "forge-std/Script.sol";
import { IPoolManager } from "v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "v4-core/src/types/PoolId.sol";
import { Currency } from "v4-core/src/types/Currency.sol";
import { IHooks } from "v4-core/src/interfaces/IHooks.sol";
import { Hooks } from "v4-core/src/libraries/Hooks.sol";
import { TickMath } from "v4-core/src/libraries/TickMath.sol";
import { HookMiner } from "v4-periphery/test/shared/HookMiner.sol";
import { DemoRouter } from "../src/router/DemoRouter.sol";
import { MockToken } from "../src/test-only/MockToken.sol";
import { SmokeHook } from "../src/test-only/SmokeHook.sol";

contract DeploySmokeHook is Script {
    using PoolIdLibrary for PoolKey;

    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint256 internal constant LIQUIDITY = 1e12;

    function run() external {
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        address poolManager = vm.envAddress("V4_POOL_MANAGER");
        address routerAddress = vm.envAddress("DEMO_ROUTER");
        address usdcAddress = vm.envAddress("MOCK_USDC");
        address nvdaAddress = vm.envAddress("MOCK_NVDA");

        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG);
        bytes memory constructorArgs = abi.encode(IPoolManager(poolManager));
        bytes memory initcode = abi.encodePacked(type(SmokeHook).creationCode, constructorArgs);
        (address expectedHook, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, flags, type(SmokeHook).creationCode, constructorArgs);

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));

        address hook = _create2(salt, initcode);
        require(hook == expectedHook, "hook address mismatch");

        DemoRouter router = DemoRouter(routerAddress);
        MockToken usdc = MockToken(usdcAddress);
        MockToken nvda = MockToken(nvdaAddress);
        usdc.approve(address(router), type(uint256).max);
        nvda.approve(address(router), type(uint256).max);

        (PoolKey memory key, bool usdcIsToken0) = _poolKey(usdcAddress, nvdaAddress, hook);
        int24 tick = usdcIsToken0 ? int24(196260) : int24(-196260);
        router.initializePool(key, TickMath.getSqrtPriceAtTick(tick));
        router.addLiquidity(
            key,
            tick - 6000,
            tick + 6000,
            int256(LIQUIDITY),
            type(uint256).max,
            type(uint256).max,
            deployer,
            bytes("seed")
        );
        router.swapExactIn(key, usdcIsToken0, 1e6, 0, deployer, hex"feed");

        vm.stopBroadcast();

        console2.log("SmokeHook:", hook);
        console2.log("PoolManager:", poolManager);
        console2.log("DemoPoolId:");
        console2.logBytes32(PoolId.unwrap(key.toId()));
        console2.log("SwapCount:", SmokeHook(hook).swapCount(key.toId()));
        console2.log("LastHookDataHash:");
        console2.logBytes32(SmokeHook(hook).lastHookDataHash(key.toId()));
        console2.log("usdcIsToken0:", usdcIsToken0);
    }

    function _poolKey(address tokenA, address tokenB, address hook)
        internal
        pure
        returns (PoolKey memory key, bool aIsToken0)
    {
        address token0 = tokenA < tokenB ? tokenA : tokenB;
        address token1 = token0 == tokenA ? tokenB : tokenA;
        aIsToken0 = token0 == tokenA;
        key = PoolKey({
            currency0: Currency.wrap(token0),
            currency1: Currency.wrap(token1),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(hook)
        });
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
