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
import { TestToken } from "../src/test-only/TestToken.sol";

contract DeployV4Fork is Script {
    uint256 internal constant LIQUIDITY = 1e12;

    struct Deployment {
        PoolManager manager;
        DemoRouter router;
        TestToken mUsdc;
        TestToken mNvda;
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
        console2.log("mUSDC:", address(deployment.mUsdc));
        console2.log("mNVDA:", address(deployment.mNvda));
        console2.log("usdcIsToken0:", usdcIsToken0);
    }

    function _deploy(address deployer) internal returns (Deployment memory deployment) {
        deployment.manager = new PoolManager(deployer);
        deployment.router = new DemoRouter(IPoolManager(address(deployment.manager)));
        deployment.mUsdc = new TestToken("USD Coin (test)", "mUSDC", 6);
        deployment.mNvda = new TestToken("NVIDIA (test)", "mNVDA", 18);

        deployment.mUsdc.mint(deployer, 1_000_000e6);
        deployment.mNvda.mint(deployer, 10_000e18);
        deployment.mUsdc.approve(address(deployment.router), type(uint256).max);
        deployment.mNvda.approve(address(deployment.router), type(uint256).max);
    }

    function _seed(Deployment memory deployment, address deployer) internal returns (bool usdcIsToken0) {
        address token0 = address(deployment.mUsdc) < address(deployment.mNvda)
            ? address(deployment.mUsdc)
            : address(deployment.mNvda);
        address token1 = token0 == address(deployment.mUsdc) ? address(deployment.mNvda) : address(deployment.mUsdc);
        usdcIsToken0 = token0 == address(deployment.mUsdc);

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
