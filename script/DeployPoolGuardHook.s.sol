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
import { PoolGuardHook } from "../src/hook/PoolGuardHook.sol";
import { PoolGuardSimulator } from "../src/hook/PoolGuardSimulator.sol";
import { GuardParams } from "../src/hook/libraries/GuardParams.sol";

/// @notice Static-fee book step 1: `PoolGuardHook` at a mined address (no `0x91` prefix, no delta
///         flags), guard params applied. Pool initialization is opt-in via `STATIC_INIT_BOOK`
///         because it deploys the base band and therefore needs the token inventory in place.
///         Ownership is transferred to the vault later (`transferOwnership` + vault accept).
contract DeployPoolGuardHook is Script {
    using PoolIdLibrary for PoolKey;

    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 internal constant HOOK_FLAGS = uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG);

    function run() external {
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        address poolManager = vm.envAddress("V4_POOL_MANAGER");
        address quote = vm.envAddress("QUOTE_ADDRESS");
        address nvda = vm.envAddress("NVDA_ADDRESS");
        address priceOracle = vm.envOr("NVDA_ORACLE", address(0));
        if (priceOracle == address(0)) priceOracle = vm.envAddress("HOOK_DEMO_ORACLE");
        address vault = vm.envOr("STATIC_VAULT", address(0));

        uint24 staticFee = uint24(vm.envOr("STATIC_FEE", uint256(3_000)));
        int24 tickSpacing = int24(vm.envOr("STATIC_TICK_SPACING", int256(60)));
        int24 initialTick = int24(vm.envInt("STATIC_INITIAL_TICK"));
        bool initBook = vm.envOr("STATIC_INIT_BOOK", false);

        GuardParams.Params memory params = GuardParams.Params({
            guardTickWidth: int24(vm.envOr("STATIC_GUARD_TICK_WIDTH", int256(600))),
            baseTickWidth: int24(vm.envOr("STATIC_BASE_TICK_WIDTH", int256(6_000))),
            guardLiquidity: uint128(vm.envOr("STATIC_GUARD_LIQUIDITY", uint256(50e12))),
            baseLiquidity: uint128(vm.envOr("STATIC_BASE_LIQUIDITY", uint256(0.5e12))),
            minEvBps: uint16(vm.envOr("STATIC_MIN_EV_BPS", uint256(0))),
            recheckMaxDeviationBps: uint16(vm.envOr("STATIC_RECHECK_MAX_DEV_BPS", uint256(200))),
            recheckInterval: uint32(vm.envOr("STATIC_RECHECK_INTERVAL", uint256(300))),
            maxPriceAge: uint32(vm.envOr("STATIC_MAX_PRICE_AGE", uint256(300))),
            allowedSessionsMask: uint8(vm.envOr("STATIC_ALLOWED_SESSIONS_MASK", uint256(0)))
        });

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));

        address simulator = vm.envOr("STATIC_SIMULATOR", address(0));
        if (simulator == address(0)) simulator = address(new PoolGuardSimulator());

        bytes memory constructorArgs =
            abi.encode(IPoolManager(poolManager), simulator, priceOracle, nvda, vault, deployer);
        bytes memory initcode = abi.encodePacked(type(PoolGuardHook).creationCode, constructorArgs);
        (address expectedHook, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, HOOK_FLAGS, type(PoolGuardHook).creationCode, constructorArgs);
        address hook = _create2(salt, initcode);
        require(hook == expectedHook, "hook address mismatch");
        require((uint160(hook) >> 152) != uint160(0x91), "hook prefix 0x91");
        require(uint160(hook) & uint160(0x3FFF) == HOOK_FLAGS, "hook flag mismatch");

        PoolGuardHook h = PoolGuardHook(hook);
        h.setGuardParams(params);

        address token0 = quote < nvda ? quote : nvda;
        address token1 = quote < nvda ? nvda : quote;
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(token0),
            currency1: Currency.wrap(token1),
            fee: staticFee,
            tickSpacing: tickSpacing,
            hooks: IHooks(hook)
        });

        if (initBook) {
            h.initializeBook(key, TickMath.getSqrtPriceAtTick(initialTick));
        }

        vm.stopBroadcast();

        console2.log("PoolGuardHook:", hook);
        console2.log("PoolGuardSimulator:", simulator);
        console2.log("HookSalt:", vm.toString(salt));
        console2.log("PoolId:", vm.toString(PoolId.unwrap(key.toId())));
        console2.log("Fee (static):", staticFee);
        console2.log("TickSpacing:", tickSpacing);
        console2.log("InitialTick:", initialTick);
        console2.log("GuardTickWidth:", params.guardTickWidth);
        console2.log("BaseTickWidth:", params.baseTickWidth);
        console2.log("GuardLiquidity:", params.guardLiquidity);
        console2.log("BaseLiquidity:", params.baseLiquidity);
        console2.log("MinEvBps:", params.minEvBps);
        console2.log("RecheckInterval:", params.recheckInterval);
        console2.log("Vault:", vault);
        console2.log("PriceOracle:", priceOracle);
        console2.log("BookInitialized:", initBook);
    }

    function _create2(bytes32 salt, bytes memory initcode) internal returns (address expected) {
        expected = address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, salt, keccak256(initcode)))))
        );
        (bool success,) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initcode));
        require(success, "create2 deploy failed");
    }
}
