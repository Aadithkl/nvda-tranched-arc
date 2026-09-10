// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Script, console2 } from "forge-std/Script.sol";
import { PoolManager } from "v4-core/src/PoolManager.sol";
import { IPoolManager } from "v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "v4-core/src/types/PoolKey.sol";
import { Currency } from "v4-core/src/types/Currency.sol";
import { IHooks } from "v4-core/src/interfaces/IHooks.sol";
import { TickMath } from "v4-core/src/libraries/TickMath.sol";
import { DemoRouter } from "../src/router/DemoRouter.sol";
import { MockToken } from "../src/test-only/MockToken.sol";

contract DeployV4Fork is Script {
    uint256 internal constant LIQUIDITY = 1e12;

    struct Deployment {
        PoolManager manager;
        DemoRouter router;
        MockToken mockUsdc;
        MockToken mockNvda;
    }

    function run() external {
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerKey);
        Deployment memory deployment = _deploy(deployer);
        bool usdcIsToken0 = _seed(deployment, deployer);
        vm.stopBroadcast();

        console2.log("PoolManager:", address(deployment.manager));
        console2.log("DemoRouter:", address(deployment.router));
        console2.log("MockUSDC:", address(deployment.mockUsdc));
        console2.log("MockNVDA:", address(deployment.mockNvda));
        console2.log("usdcIsToken0:", usdcIsToken0);
    }

    function _deploy(address deployer) internal returns (Deployment memory deployment) {
        deployment.manager = new PoolManager(deployer);
        deployment.router = new DemoRouter(IPoolManager(address(deployment.manager)));
        deployment.mockUsdc = new MockToken("Mock USD Coin", "mUSDC", 6);
        deployment.mockNvda = new MockToken("Mock NVIDIA", "mNVDA", 18);

        deployment.mockUsdc.mint(deployer, 1_000_000e6);
        deployment.mockNvda.mint(deployer, 10_000e18);
        deployment.mockUsdc.approve(address(deployment.router), type(uint256).max);
        deployment.mockNvda.approve(address(deployment.router), type(uint256).max);
    }

    function _seed(Deployment memory deployment, address deployer) internal returns (bool usdcIsToken0) {
        address token0 = address(deployment.mockUsdc) < address(deployment.mockNvda)
            ? address(deployment.mockUsdc)
            : address(deployment.mockNvda);
        address token1 =
            token0 == address(deployment.mockUsdc) ? address(deployment.mockNvda) : address(deployment.mockUsdc);
        usdcIsToken0 = token0 == address(deployment.mockUsdc);

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(token0),
            currency1: Currency.wrap(token1),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });

        int24 tick = usdcIsToken0 ? int24(196260) : int24(-196260);
        deployment.router.initializePool(key, TickMath.getSqrtPriceAtTick(tick));
        deployment.router
            .addLiquidity(
                key, tick - 6000, tick + 6000, int256(LIQUIDITY), type(uint256).max, type(uint256).max, deployer
            );
        deployment.router.swapExactIn(key, usdcIsToken0, 1e6, 0, deployer);
    }
}
