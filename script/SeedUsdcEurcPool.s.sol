// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Script, console2 } from "forge-std/Script.sol";
import { IPoolManager } from "v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "v4-core/src/types/PoolId.sol";
import { Currency } from "v4-core/src/types/Currency.sol";
import { IHooks } from "v4-core/src/interfaces/IHooks.sol";
import { TickMath } from "v4-core/src/libraries/TickMath.sol";
import { StateLibrary } from "v4-core/src/libraries/StateLibrary.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { DemoRouter } from "../src/router/DemoRouter.sol";

contract SeedUsdcEurcPool is Script {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    function run() external {
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        IPoolManager manager = IPoolManager(vm.envAddress("V4_POOL_MANAGER"));
        DemoRouter router = DemoRouter(vm.envAddress("DEMO_ROUTER"));
        address usdc = vm.envAddress("USDC_ADDRESS");
        address eurc = vm.envAddress("EURC_ADDRESS");
        uint24 fee = uint24(vm.envOr("EURC_POOL_FEE", uint256(100)));
        int24 tickSpacing = int24(int256(vm.envOr("EURC_POOL_TICK_SPACING", uint256(1))));
        int24 tick = int24(vm.envInt("EURC_POOL_TICK"));
        int24 tickLower = int24(vm.envInt("EURC_POOL_TICK_LOWER"));
        int24 tickUpper = int24(vm.envInt("EURC_POOL_TICK_UPPER"));
        int256 liquidity = int256(vm.envInt("EURC_POOL_LIQUIDITY"));

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));

        IERC20(usdc).approve(address(router), type(uint256).max);
        IERC20(eurc).approve(address(router), type(uint256).max);

        (PoolKey memory key,) = _poolKey(usdc, eurc, fee, tickSpacing);
        router.initializePool(key, TickMath.getSqrtPriceAtTick(tick));
        router.addLiquidity(key, tickLower, tickUpper, liquidity, 5_050_000, 4_850_000, deployer, bytes("usdc-eurc"));
        router.swapExactIn(key, true, 500_000, 0, deployer, hex"01");

        vm.stopBroadcast();

        (uint160 sqrtPriceX96, int24 endTick,,) = manager.getSlot0(key.toId());
        console2.log("USDC/EURC PoolId:");
        console2.logBytes32(PoolId.unwrap(key.toId()));
        console2.log("tickAfter:", endTick);
        console2.log("sqrtPriceX96:", uint256(sqrtPriceX96));
        console2.log("USDC balance:", IERC20(usdc).balanceOf(deployer));
        console2.log("EURC balance:", IERC20(eurc).balanceOf(deployer));
    }

    function _poolKey(address tokenA, address tokenB, uint24 fee, int24 tickSpacing)
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
            fee: fee,
            tickSpacing: tickSpacing,
            hooks: IHooks(address(0))
        });
    }
}
