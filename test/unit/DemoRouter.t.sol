// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { PoolManager } from "v4-core/src/PoolManager.sol";
import { IPoolManager } from "v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "v4-core/src/types/PoolKey.sol";
import { Currency } from "v4-core/src/types/Currency.sol";
import { IHooks } from "v4-core/src/interfaces/IHooks.sol";
import { TickMath } from "v4-core/src/libraries/TickMath.sol";
import { BalanceDelta, BalanceDeltaLibrary } from "v4-core/src/types/BalanceDelta.sol";
import { DemoRouter } from "../../src/router/DemoRouter.sol";
import { TestToken } from "../../src/test-only/TestToken.sol";

contract DemoRouterTest is Test {
    using BalanceDeltaLibrary for BalanceDelta;
    PoolManager internal manager;
    DemoRouter internal router;
    TestToken internal usdc;
    TestToken internal nvda;

    PoolKey internal key;
    int24 internal initialTick;
    bool internal usdcIsToken0;

    uint256 internal constant LIQUIDITY = 1e12;

    function setUp() public {
        manager = new PoolManager(address(this));
        router = new DemoRouter(IPoolManager(address(manager)));
        usdc = new TestToken("USD Coin", "mUSDC", 6);
        nvda = new TestToken("NVIDIA", "mNVDA", 18);

        address token0 = address(usdc) < address(nvda) ? address(usdc) : address(nvda);
        address token1 = token0 == address(usdc) ? address(nvda) : address(usdc);
        usdcIsToken0 = token0 == address(usdc);

        key = PoolKey({
            currency0: Currency.wrap(token0),
            currency1: Currency.wrap(token1),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });

        initialTick = usdcIsToken0 ? int24(196260) : int24(-196260);
        router.initializePool(key, TickMath.getSqrtPriceAtTick(initialTick));

        usdc.mint(address(this), 10_000_000e6);
        nvda.mint(address(this), 100_000e18);
        usdc.approve(address(router), type(uint256).max);
        nvda.approve(address(router), type(uint256).max);
    }

    function _addDefaultLiquidity() internal {
        router.addLiquidity(
            key,
            initialTick - 6000,
            initialTick + 6000,
            int256(LIQUIDITY),
            type(uint256).max,
            type(uint256).max,
            address(this)
        );
    }

    function test_addSwapRemove() public {
        uint256 usdcBefore = usdc.balanceOf(address(this));
        uint256 nvdaBefore = nvda.balanceOf(address(this));

        _addDefaultLiquidity();

        uint256 usdcAfterAdd = usdc.balanceOf(address(this));
        uint256 nvdaAfterAdd = nvda.balanceOf(address(this));
        assertLt(usdcAfterAdd, usdcBefore);
        assertLt(nvdaAfterAdd, nvdaBefore);

        uint256 amountIn = 1e6;
        uint256 outBefore = nvda.balanceOf(address(this));

        router.swapExactIn(key, usdcIsToken0, amountIn, 0, address(this));

        uint256 outAfter = nvda.balanceOf(address(this));
        assertGt(outAfter, outBefore);

        uint256 usdcAfterSwap = usdc.balanceOf(address(this));
        uint256 nvdaAfterSwap = nvda.balanceOf(address(this));

        router.removeLiquidity(key, initialTick - 6000, initialTick + 6000, -int256(LIQUIDITY), address(this));

        assertGt(usdc.balanceOf(address(this)), usdcAfterSwap);
        assertGt(nvda.balanceOf(address(this)), nvdaAfterSwap);
    }

    function test_swap_slippageReverts() public {
        _addDefaultLiquidity();
        vm.expectRevert(DemoRouter.SlippageExceeded.selector);
        router.swapExactIn(key, usdcIsToken0, 1e6, type(uint256).max, address(this));
    }

    function test_addLiquidity_amountCapReverts() public {
        vm.expectRevert();
        router.addLiquidity(key, initialTick - 6000, initialTick + 6000, int256(LIQUIDITY), 0, 0, address(this));
    }

    function test_swap_withoutLiquidity_isNoOp() public {
        BalanceDelta delta = router.swapExactIn(key, usdcIsToken0, 1e6, 0, address(this));
        assertEq(delta.amount0(), 0);
        assertEq(delta.amount1(), 0);
    }
}
