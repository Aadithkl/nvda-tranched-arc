// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Script, console2 } from "forge-std/Script.sol";
import { PoolManager } from "v4-core/src/PoolManager.sol";
import { IPoolManager } from "v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "v4-core/src/types/PoolId.sol";
import { Currency } from "v4-core/src/types/Currency.sol";
import { IHooks } from "v4-core/src/interfaces/IHooks.sol";
import { TickMath } from "v4-core/src/libraries/TickMath.sol";
import { IAllowanceTransfer } from "permit2/src/interfaces/IAllowanceTransfer.sol";
import { PositionDescriptor } from "v4-periphery/src/PositionDescriptor.sol";
import { PositionManager } from "v4-periphery/src/PositionManager.sol";
import { StateView } from "v4-periphery/src/lens/StateView.sol";
import { V4Quoter } from "v4-periphery/src/lens/V4Quoter.sol";
import { ReservesLens } from "v4-periphery/src/lens/ReservesLens.sol";
import { IPositionDescriptor } from "v4-periphery/src/interfaces/IPositionDescriptor.sol";
import { IWETH9 } from "v4-periphery/src/interfaces/external/IWETH9.sol";
import { DemoRouter } from "../src/router/DemoRouter.sol";
import { TestToken } from "../src/test-only/TestToken.sol";
import { TestWETH9 } from "../src/test-only/TestWETH9.sol";

contract DeployV4Stack is Script {
    using PoolIdLibrary for PoolKey;

    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint256 internal constant LIQUIDITY = 1e12;

    function run() external {
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        address permit2 = vm.envOr("PERMIT2", address(0x000000000022D473030F116dDEE9F6B43aC78BA3));
        uint256 unsubscribeGasLimit = vm.envOr("POSM_UNSUBSCRIBE_GAS_LIMIT", uint256(300_000));
        bytes32 nativeLabel = bytes32(bytes(vm.envOr("NATIVE_CURRENCY_LABEL", string("WETH"))));
        address existingUsdc = vm.envOr("TEST_USDC", vm.envOr("MOCK_USDC", address(0)));
        address existingNvda = vm.envOr("TEST_NVDA", vm.envOr("MOCK_NVDA", address(0)));

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));

        PoolManager manager = new PoolManager(deployer);
        DemoRouter router = new DemoRouter(IPoolManager(address(manager)));
        TestWETH9 weth9 = new TestWETH9();

        TestToken mUsdc =
            existingUsdc == address(0) ? new TestToken("USD Coin (test)", "mUSDC", 6) : TestToken(existingUsdc);
        TestToken mNvda =
            existingNvda == address(0) ? new TestToken("NVIDIA (test)", "mNVDA", 18) : TestToken(existingNvda);

        if (existingUsdc == address(0)) mUsdc.mint(deployer, 1_000_000e6);
        if (existingNvda == address(0)) mNvda.mint(deployer, 10_000e18);

        mUsdc.approve(address(router), type(uint256).max);
        mNvda.approve(address(router), type(uint256).max);

        address descriptor = _create2(
            bytes32(0),
            abi.encodePacked(
                type(PositionDescriptor).creationCode,
                abi.encode(IPoolManager(address(manager)), address(weth9), nativeLabel)
            )
        );
        address posm = _create2(
            bytes32(uint256(3)),
            abi.encodePacked(
                type(PositionManager).creationCode,
                abi.encode(
                    IPoolManager(address(manager)),
                    IAllowanceTransfer(permit2),
                    unsubscribeGasLimit,
                    IPositionDescriptor(descriptor),
                    IWETH9(address(weth9))
                )
            )
        );
        address stateView = _create2(
            bytes32(0), abi.encodePacked(type(StateView).creationCode, abi.encode(IPoolManager(address(manager))))
        );
        address quoter = _create2(
            bytes32(0), abi.encodePacked(type(V4Quoter).creationCode, abi.encode(IPoolManager(address(manager))))
        );
        address lens = _create2(keccak256("nvda-tranched-reserves-lens"), type(ReservesLens).creationCode);

        (PoolKey memory key, bool usdcIsToken0) = _poolKey(address(mUsdc), address(mNvda), address(0));
        int24 tick = usdcIsToken0 ? int24(196260) : int24(-196260);
        router.initializePool(key, TickMath.getSqrtPriceAtTick(tick));
        router.addLiquidity(
            key, tick - 6000, tick + 6000, int256(LIQUIDITY), type(uint256).max, type(uint256).max, deployer
        );
        router.swapExactIn(key, usdcIsToken0, 1e6, 0, deployer);

        vm.stopBroadcast();

        console2.log("PoolManager:", address(manager));
        console2.log("DemoRouter:", address(router));
        console2.log("TestWETH9:", address(weth9));
        console2.log("PositionDescriptor:", descriptor);
        console2.log("PositionManager:", posm);
        console2.log("StateView:", stateView);
        console2.log("V4Quoter:", quoter);
        console2.log("ReservesLens:", lens);
        console2.log("mUSDC:", address(mUsdc));
        console2.log("mNVDA:", address(mNvda));
        console2.log("DemoPoolId:");
        console2.logBytes32(PoolId.unwrap(key.toId()));
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
