// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

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
import { PoolGuardHook } from "../src/hook/PoolGuardHook.sol";
import { PoolGuardSimulator } from "../src/hook/PoolGuardSimulator.sol";
import { GuardParams } from "../src/hook/libraries/GuardParams.sol";
import { LedgerVault } from "../src/vaults/LedgerVault.sol";
import { LedgerEntry7575 } from "../src/vaults/LedgerEntry7575.sol";
import { VaultStrategyController } from "../src/strategy/VaultStrategyController.sol";
import { VaultStrategyAgent } from "../src/strategy/VaultStrategyAgent.sol";
import { StrategyModule } from "../src/adapters/StrategyModule.sol";
import { TrancheAccountant } from "../src/vaults/TrancheAccountant.sol";
import { SeniorVault } from "../src/vaults/SeniorVault.sol";
import { JuniorVault } from "../src/vaults/JuniorVault.sol";
import { HookShareToken } from "../src/core/HookShareToken.sol";
import { IHookSharePipe } from "../src/interfaces/IHookSharePipe.sol";

/// @notice Static-fee book, full stack: simulator + guard hook (mined) + combined LedgerVault
///         (hook owner, share issuer, NAV, pipe, settlement, allocator) + accountant + tranches.
///         Pool initialization is opt-in (`STATIC_INIT_BOOK`) because it deploys the bands and
///         therefore needs the vault to hold the bootstrap inventory first.
contract DeployStaticStack is Script {
    using PoolIdLibrary for PoolKey;

    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 internal constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
            | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
    );

    function run() external {
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        (LedgerVault vault, PoolKey memory key, int24 initialTick, bool initBook, uint64 expiry) = _deployCore(deployer);
        VaultStrategyController controller = _deployControl(address(vault), deployer);
        (,, JuniorVault junior) = _deployTranches(address(vault), deployer, expiry);
        vault.setExitFees(
            uint16(vm.envOr("STATIC_EXIT_FEE_BPS", uint256(20))), uint16(vm.envOr("STATIC_MAX_FINE_BPS", uint256(30)))
        );
        _bootstrapStack(vault, junior, deployer);
        _wireStrategy(vault, controller);
        if (initBook) vault.initializeHook(key, TickMath.getSqrtPriceAtTick(initialTick));
        vm.stopBroadcast();
        console2.log("BookInitialized:", initBook);
    }

    function _deployCore(address deployer)
        internal
        returns (LedgerVault vault, PoolKey memory key, int24 initialTick, bool initBook, uint64 expiry)
    {
        address quote = vm.envAddress("QUOTE_ADDRESS");
        address nvda = vm.envAddress("NVDA_ADDRESS");
        address hook;
        (hook, key) = _mineHook(deployer, quote, nvda);
        expiry = uint64(vm.envOr("STATIC_EXPIRY", uint256(0)));
        initialTick = int24(vm.envInt("STATIC_INITIAL_TICK"));
        initBook = vm.envOr("STATIC_INIT_BOOK", false);
        vault = new LedgerVault(
            IPoolManager(vm.envAddress("V4_POOL_MANAGER")),
            PoolGuardHook(hook),
            key,
            IERC20(quote),
            IERC20(nvda),
            _envOracle(),
            expiry,
            deployer
        );
        PoolGuardHook(hook).setVault(address(vault));
        PoolGuardHook(hook).transferOwnership(address(vault));
        vault.acceptHookOwnership();
        vault.setGuardParams(_guardParams());
        console2.log("PoolGuardHook:", hook);
        console2.log("LedgerVault:", address(vault));
        console2.log("PoolId:", vm.toString(PoolId.unwrap(key.toId())));
        console2.log("Expiry:", expiry);
    }

    function _mineHook(address deployer, address quote, address nvda)
        internal
        returns (address hook, PoolKey memory key)
    {
        address priceOracle = _envOracle();
        address simulator = vm.envOr("STATIC_SIMULATOR", address(0));
        if (simulator == address(0)) simulator = address(new PoolGuardSimulator());
        bytes memory hookArgs = abi.encode(
            IPoolManager(vm.envAddress("V4_POOL_MANAGER")), simulator, priceOracle, nvda, address(0), deployer
        );
        bytes memory initcode = abi.encodePacked(type(PoolGuardHook).creationCode, hookArgs);
        (address expectedHook, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, HOOK_FLAGS, type(PoolGuardHook).creationCode, hookArgs);
        hook = _create2(salt, initcode);
        require(hook == expectedHook, "hook address mismatch");
        require((uint160(hook) >> 152) != uint160(0x91), "hook prefix 0x91");
        key = PoolKey({
            currency0: Currency.wrap(quote < nvda ? quote : nvda),
            currency1: Currency.wrap(quote < nvda ? nvda : quote),
            fee: uint24(vm.envOr("STATIC_FEE", uint256(3_000))),
            tickSpacing: int24(vm.envOr("STATIC_TICK_SPACING", int256(60))),
            hooks: IHooks(hook)
        });
        console2.log("PoolGuardSimulator:", simulator);
        console2.log("HookSalt:", vm.toString(salt));
        console2.log("PriceOracle:", priceOracle);
    }

    function _envOracle() internal view returns (address priceOracle) {
        priceOracle = vm.envOr("NVDA_ORACLE", address(0));
        // Deploy guard: on Robinhood Chain the demo-oracle fallback is forbidden — a dead
        // `sessionSource`/stale feed bricks all swaps. Fail closed at deploy.
        if (block.chainid == 4663) {
            require(priceOracle != address(0), "NVDA_ORACLE required on Robinhood Chain");
        } else if (priceOracle == address(0)) {
            priceOracle = vm.envAddress("HOOK_DEMO_ORACLE");
        }
    }

    function _guardParams() internal view returns (GuardParams.Params memory params) {
        params = GuardParams.Params({
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
    }

    function _deployControl(address vaultAddr, address deployer) internal returns (VaultStrategyController controller) {
        address operator = vm.envOr("AGENT_OPERATOR_ADDRESS", deployer);
        controller = new VaultStrategyController(deployer);
        VaultStrategyAgent agent = new VaultStrategyAgent(deployer, operator, address(controller));
        controller.setVault(vaultAddr);
        controller.setAgent(address(agent), true);
        LedgerVault(vaultAddr).setKeeper(address(controller));
        console2.log("VaultStrategyController:", address(controller));
        console2.log("VaultStrategyAgent:", address(agent));
        console2.log("Keeper/Operator:", operator);
    }

    function _deployTranches(address vaultAddr, address deployer, uint64 expiry)
        internal
        returns (TrancheAccountant accountant, SeniorVault senior, JuniorVault junior)
    {
        address quote = vm.envAddress("QUOTE_ADDRESS");
        address nvda = vm.envAddress("NVDA_ADDRESS");
        accountant = new TrancheAccountant(deployer);
        accountant.setKeeper(vm.envOr("AGENT_OPERATOR_ADDRESS", deployer));
        HookShareToken share = LedgerVault(vaultAddr).shareToken();
        senior = new SeniorVault(
            IERC20(address(share)),
            IERC20(quote),
            IERC20(nvda),
            IHookSharePipe(address(vaultAddr)),
            deployer,
            address(accountant),
            expiry
        );
        junior = new JuniorVault(
            IERC20(address(share)),
            IERC20(quote),
            IERC20(nvda),
            IHookSharePipe(address(vaultAddr)),
            deployer,
            address(accountant),
            expiry
        );
        accountant.setHook(vaultAddr);
        accountant.setVaults(address(senior), address(junior));
        LedgerVault(vaultAddr).setAccountant(address(accountant));
        LedgerEntry7575 entry = new LedgerEntry7575(vaultAddr);
        LedgerVault(vaultAddr).setShareVault(address(entry));
        console2.log("TrancheAccountant:", address(accountant));
        console2.log("SeniorVault:", address(senior));
        console2.log("JuniorVault:", address(junior));
        console2.log("LedgerEntry7575:", address(entry));
        console2.log("HookShareToken:", address(share));
    }

    /// @notice Pre-mine invariant (anti-inflation-attack): the book must never start from
    ///         dust. Deposits 0.1 quote units (10**(decimals-1): $0.10 on a 6-dec book,
    ///         0.1 WETH on an 18-dec book) through the JUNIOR tranche (genesis must be
    ///         junior-led — senior deposits need 25% junior backing, and direct wraps
    ///         revert once the accountant is wired). Deployer keeps the bootstrap
    ///         shares. Deployer must hold the quote and the vault needs a live oracle
    ///         (wrap reverts on invalid mid). Set STATIC_BOOTSTRAP=false to skip
    ///         (not for production books).
    function _bootstrapStack(LedgerVault vault, JuniorVault junior, address deployer) internal {
        if (!vm.envOr("STATIC_BOOTSTRAP", true)) return;
        address quote = vm.envAddress("QUOTE_ADDRESS");
        uint8 quoteDec = vault.quoteDecimals();
        require(quoteDec > 0, "bootstrap: bad quote decimals");
        uint256 bootAmount = 10 ** (quoteDec - 1);
        require(IERC20(quote).balanceOf(deployer) >= bootAmount, "bootstrap: fund deployer with quote");
        IERC20(quote).approve(address(junior), bootAmount);
        uint256 bootShares = junior.depositQuote(bootAmount, deployer);
        console2.log("BootstrapQuote:", bootAmount);
        console2.log("BootstrapShares:", bootShares);
    }

    /// @notice Optional bottom-layer strategy wiring (env-gated). When STRATEGY_MODULE_ADDRESS
    ///         is set, hooks the quote-asset Morpho module up so the controller can allocate
    ///         (allocator) and de-risk (sentinel). The module must still be deployer-owned at
    ///         this point; adapter lifecycle (submit/disable) stays owner-direct on the module.
    ///         Book registry (setBooks) is wired post-deploy once the second hook exists.
    function _wireStrategy(LedgerVault vault, VaultStrategyController controller) internal {
        address strategyModule = vm.envOr("STRATEGY_MODULE_ADDRESS", address(0));
        if (strategyModule == address(0)) return;
        StrategyModule(strategyModule).setVault(address(vault));
        StrategyModule(strategyModule).setAllocator(address(controller));
        StrategyModule(strategyModule).setSentinel(address(controller));
        vault.setStrategyModule(strategyModule);
        controller.setStrategyModule(strategyModule);
        console2.log("StrategyModule:", strategyModule);
    }

    function _create2(bytes32 salt, bytes memory initcode) internal returns (address expected) {
        expected = address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, salt, keccak256(initcode)))))
        );
        (bool success,) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initcode));
        require(success, "create2 deploy failed");
    }
}
