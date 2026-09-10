// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { PoolManager } from "v4-core/src/PoolManager.sol";
import { IPoolManager } from "v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "v4-core/src/types/PoolId.sol";
import { Currency } from "v4-core/src/types/Currency.sol";
import { IHooks } from "v4-core/src/interfaces/IHooks.sol";
import { Hooks } from "v4-core/src/libraries/Hooks.sol";
import { TickMath } from "v4-core/src/libraries/TickMath.sol";
import { SwapParams } from "v4-core/src/types/PoolOperation.sol";
import { HookMiner } from "v4-periphery/test/shared/HookMiner.sol";
import { DemoRouter } from "../../src/router/DemoRouter.sol";
import { MockToken } from "../../src/test-only/MockToken.sol";
import { SmokeHook } from "../../src/test-only/SmokeHook.sol";

contract SmokeHookTest is Test {
    using PoolIdLibrary for PoolKey;

    PoolManager internal manager;
    DemoRouter internal router;
    SmokeHook internal hook;
    MockToken internal usdc;
    MockToken internal nvda;

    PoolKey internal key;
    PoolId internal poolId;
    bool internal usdcIsToken0;
    int24 internal initialTick;

    uint256 internal constant LIQUIDITY = 1e12;

    function setUp() public {
        manager = new PoolManager(address(this));
        router = new DemoRouter(IPoolManager(address(manager)));
        usdc = new MockToken("USD Coin", "mUSDC", 6);
        nvda = new MockToken("NVIDIA", "mNVDA", 18);

        address token0 = address(usdc) < address(nvda) ? address(usdc) : address(nvda);
        address token1 = token0 == address(usdc) ? address(nvda) : address(usdc);
        usdcIsToken0 = token0 == address(usdc);
        initialTick = usdcIsToken0 ? int24(196260) : int24(-196260);

        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG);
        bytes memory args = abi.encode(IPoolManager(address(manager)));
        (address hookAddress, bytes32 salt) = HookMiner.find(address(this), flags, type(SmokeHook).creationCode, args);
        hook = new SmokeHook{ salt: salt }(IPoolManager(address(manager)));
        assertEq(address(hook), hookAddress);

        key = PoolKey({
            currency0: Currency.wrap(token0),
            currency1: Currency.wrap(token1),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        poolId = key.toId();

        router.initializePool(key, TickMath.getSqrtPriceAtTick(initialTick));

        usdc.mint(address(this), 10_000_000e6);
        nvda.mint(address(this), 100_000e18);
        usdc.approve(address(router), type(uint256).max);
        nvda.approve(address(router), type(uint256).max);
    }

    function _addLiquidity() internal {
        router.addLiquidity(
            key,
            initialTick - 6000,
            initialTick + 6000,
            int256(LIQUIDITY),
            type(uint256).max,
            type(uint256).max,
            address(this),
            bytes("add-liq")
        );
    }

    function test_permissions() public view {
        Hooks.Permissions memory permissions = hook.getHookPermissions();
        assertTrue(permissions.beforeSwap);
        assertTrue(permissions.afterSwap);
        assertFalse(permissions.beforeSwapReturnDelta);
        assertFalse(permissions.afterSwapReturnDelta);
    }

    function test_swap_firesHookAndRecordsData() public {
        _addLiquidity();
        assertEq(hook.swapCount(poolId), 0);

        router.swapExactIn(key, usdcIsToken0, 1e6, 0, address(this), hex"deadbeef");

        assertEq(hook.swapCount(poolId), 1);
        assertEq(hook.lastHookDataHash(poolId), keccak256(hex"deadbeef"));
        assertGt(hook.lastSqrtPriceX96(poolId), 0);
        assertEq(hook.lastSwapBlock(poolId), block.number);
    }

    function test_swap_emptyHookData() public {
        _addLiquidity();
        router.swapExactIn(key, usdcIsToken0, 1e6, 0, address(this));
        assertEq(hook.lastHookDataHash(poolId), keccak256(""));
    }

    function test_multipleSwaps_increment() public {
        _addLiquidity();
        router.swapExactIn(key, usdcIsToken0, 1e6, 0, address(this), hex"01");
        router.swapExactIn(key, usdcIsToken0, 1e6, 0, address(this), hex"02");
        assertEq(hook.swapCount(poolId), 2);
        assertEq(hook.lastHookDataHash(poolId), keccak256(hex"02"));
    }

    function test_directCall_reverts() public {
        vm.expectRevert(SmokeHook.NotPoolManager.selector);
        hook.beforeSwap(address(this), key, _emptySwapParams(), "");
    }

    function _emptySwapParams() internal pure returns (SwapParams memory) {
        return SwapParams({ zeroForOne: true, amountSpecified: -1, sqrtPriceLimitX96: 0 });
    }
}
