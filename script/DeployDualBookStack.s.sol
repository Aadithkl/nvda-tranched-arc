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
import { DualBookHub } from "../src/hook/DualBookHub.sol";
import { PoolGuardSimulator } from "../src/hook/PoolGuardSimulator.sol";
import { IPoolGuardSimulator } from "../src/interfaces/IPoolGuardSimulator.sol";
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
import { IBookHook } from "../src/interfaces/IBookHook.sol";

/// @notice Mines + deploys arbitrary initcode from a non-script address so a second
///         valid hook slot exists (CREATE2 address commits to the deployer).
///         Takes full initcode (never embeds hook bytecode itself) so this helper
///         stays far inside EIP-170 no matter how big the hook grows.
contract DualBookHookFactory {
    error DeployFailed();

    function deployHook(bytes32 salt, bytes calldata initcode) external returns (address hook) {
        // Copy to memory first: CREATE2 reads initcode from memory, and plain
        // `mload` on a calldata offset would read the wrong space.
        bytes memory code = initcode;
        assembly {
            hook := create2(0, add(code, 32), mload(code), salt)
        }
        if (hook == address(0)) revert DeployFailed();
    }
}

/// @notice Dual static-fee stack: low-fee book A + high-fee book B (same pair) under a
///         `DualBookHub` the vault owns. Both books initialize armed (base + guard) so
///         every later switch is atomic with no flag fiddling; the controller's
///         `submitSwitchBook` migrates pull -> fund -> arm in one agent call.
///
///         Wiring order matters (custody!): stage params on both books -> hub -> books
///         point at hub + hand ownership over -> vault (hook = hub) -> hub.setVault ->
///         fund + init both books -> controller/books/hub registry -> hub keeper ->
///         hub ownership to vault -> tranches/fees/bootstrap/strategy.
///
///         Funding for init (init deploys bands strictly — books must hold inventory):
///         STATIC_FUND_QUOTE / STATIC_FUND_EQUITY go to the vault (active book A), and
///         STATIC_FUND_B_QUOTE / STATIC_FUND_B_EQUITY stage the inactive book B. All four
///         are pulled via transferFrom, so approve this script first, or leave them zero
///         and fund + `initializeHook` manually (STATIC_INIT_BOOKS=false, default).
contract DeployDualBookStack is Script {
    using PoolIdLibrary for PoolKey;

    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 internal constant HOOK_FLAGS = uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG);

    function run() external {
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        address quote = vm.envAddress("QUOTE_ADDRESS");
        address nvda = vm.envAddress("NVDA_ADDRESS");
        IPoolManager manager = IPoolManager(vm.envAddress("V4_POOL_MANAGER"));
        address priceOracle = _envOracle();
        address simulator = vm.envOr("STATIC_SIMULATOR", address(0));
        if (simulator == address(0)) simulator = address(new PoolGuardSimulator());

        (address hookA, PoolKey memory keyA) = _mineAndDeploy(
            deployer,
            CREATE2_DEPLOYER,
            manager,
            simulator,
            priceOracle,
            nvda,
            uint24(vm.envOr("STATIC_FEE_A", uint256(3_000))),
            int24(vm.envOr("STATIC_TICK_SPACING_A", int256(60))),
            quote,
            nvda
        );
        DualBookHookFactory factory = new DualBookHookFactory();
        (address hookB, PoolKey memory keyB) = _mineAndDeploy(
            deployer,
            address(factory),
            manager,
            simulator,
            priceOracle,
            nvda,
            uint24(vm.envOr("STATIC_FEE_B", uint256(10_000))),
            int24(vm.envOr("STATIC_TICK_SPACING_B", int256(200))),
            quote,
            nvda
        );

        PoolGuardHook(hookA).setGuardParams(_guardParams("STATIC"));
        PoolGuardHook(hookB).setGuardParams(_guardParams("STATIC_B"));

        DualBookHub hub = new DualBookHub(
            manager,
            PoolGuardHook(hookA),
            PoolGuardHook(hookB),
            keyA,
            keyB,
            IERC20(quote),
            IERC20(nvda),
            deployer,
            deployer
        );
        PoolGuardHook(hookA).setVault(address(hub));
        PoolGuardHook(hookB).setVault(address(hub));
        PoolGuardHook(hookA).transferOwnership(address(hub));
        PoolGuardHook(hookB).transferOwnership(address(hub));
        hub.acceptHookOwnership();

        uint64 expiry = uint64(vm.envOr("STATIC_EXPIRY", uint256(0)));
        LedgerVault vault = new LedgerVault(
            manager, IBookHook(address(hub)), keyA, IERC20(quote), IERC20(nvda), priceOracle, expiry, deployer
        );
        vault.setGuardParams(_guardParams("STATIC"));
        hub.setVault(address(vault));

        VaultStrategyController controller = _deployControl(address(vault), deployer);
        controller.setBooks(hookA, hookB);
        controller.setHub(address(hub));
        hub.setKeeper(address(controller));

        _fundAndInit(vault, hub, keyA, keyB, quote, nvda, deployer);

        hub.transferOwnership(address(vault));
        vault.acceptHubOwnership(address(hub));

        _deployTranches(address(vault), deployer, expiry);
        vault.setExitFees(
            uint16(vm.envOr("STATIC_EXIT_FEE_BPS", uint256(20))), uint16(vm.envOr("STATIC_MAX_FINE_BPS", uint256(30)))
        );
        _bootstrapStack(vault, deployer);
        _wireStrategy(vault, controller);
        vm.stopBroadcast();

        console2.log("DualBookHub:", address(hub));
        console2.log("LedgerVault:", address(vault));
        console2.log("PoolIdA:", vm.toString(PoolId.unwrap(keyA.toId())));
        console2.log("PoolIdB:", vm.toString(PoolId.unwrap(keyB.toId())));
        console2.log("Expiry:", expiry);
    }

    function _mineAndDeploy(
        address deployer,
        address create2Wallet,
        IPoolManager manager,
        address simulator,
        address priceOracle,
        address nvda,
        uint24 fee,
        int24 tickSpacing,
        address quote,
        address equity
    ) internal returns (address hook, PoolKey memory key) {
        bytes memory hookArgs = abi.encode(manager, simulator, priceOracle, nvda, address(0), deployer);
        bytes memory initcode = abi.encodePacked(type(PoolGuardHook).creationCode, hookArgs);
        (address expectedHook, bytes32 salt) =
            HookMiner.find(create2Wallet, HOOK_FLAGS, type(PoolGuardHook).creationCode, hookArgs);
        if (create2Wallet == CREATE2_DEPLOYER) {
            hook = _create2(salt, initcode);
        } else {
            hook = DualBookHookFactory(create2Wallet).deployHook(salt, initcode);
        }
        require(hook == expectedHook, "hook address mismatch");
        require((uint160(hook) >> 152) != uint160(0x91), "hook prefix 0x91");
        key = PoolKey({
            currency0: Currency.wrap(quote < equity ? quote : equity),
            currency1: Currency.wrap(quote < equity ? equity : quote),
            fee: fee,
            tickSpacing: tickSpacing,
            hooks: IHooks(hook)
        });
        console2.log("PoolGuardHook:", hook);
        console2.log("HookSalt:", vm.toString(salt));
    }

    function _envOracle() internal view returns (address priceOracle) {
        priceOracle = vm.envOr("NVDA_ORACLE", address(0));
        // Audit: on Robinhood Chain the demo-oracle fallback is forbidden (H4).
        if (block.chainid == 4663) {
            require(priceOracle != address(0), "NVDA_ORACLE required on Robinhood Chain");
        } else if (priceOracle == address(0)) {
            priceOracle = vm.envAddress("HOOK_DEMO_ORACLE");
        }
    }

    function _guardParams(string memory prefix) internal view returns (GuardParams.Params memory params) {
        params = GuardParams.Params({
            guardTickWidth: int24(vm.envOr(string.concat(prefix, "_GUARD_TICK_WIDTH"), int256(600))),
            baseTickWidth: int24(vm.envOr(string.concat(prefix, "_BASE_TICK_WIDTH"), int256(6_000))),
            guardLiquidity: uint128(vm.envOr(string.concat(prefix, "_GUARD_LIQUIDITY"), uint256(50e12))),
            baseLiquidity: uint128(vm.envOr(string.concat(prefix, "_BASE_LIQUIDITY"), uint256(0.5e12))),
            minEvBps: uint16(vm.envOr(string.concat(prefix, "_MIN_EV_BPS"), uint256(0))),
            recheckMaxDeviationBps: uint16(vm.envOr(string.concat(prefix, "_RECHECK_MAX_DEV_BPS"), uint256(50))),
            recheckInterval: uint32(vm.envOr(string.concat(prefix, "_RECHECK_INTERVAL"), uint256(300))),
            maxPriceAge: uint32(vm.envOr(string.concat(prefix, "_MAX_PRICE_AGE"), uint256(300))),
            allowedSessionsMask: uint8(vm.envOr(string.concat(prefix, "_ALLOWED_SESSIONS_MASK"), uint256(0)))
        });
    }

    /// @notice Funds both books from the deployer (approve this script first) and
    ///         initializes both pools armed. Skipped unless STATIC_INIT_BOOKS=true.
    function _fundAndInit(
        LedgerVault vault,
        DualBookHub hub,
        PoolKey memory keyA,
        PoolKey memory keyB,
        address quote,
        address nvda,
        address deployer
    ) internal {
        if (!vm.envOr("STATIC_INIT_BOOKS", false)) return;
        uint256 fundQ = vm.envOr("STATIC_FUND_QUOTE", uint256(0));
        uint256 fundE = vm.envOr("STATIC_FUND_EQUITY", uint256(0));
        uint256 fundBQ = vm.envOr("STATIC_FUND_B_QUOTE", uint256(0));
        uint256 fundBE = vm.envOr("STATIC_FUND_B_EQUITY", uint256(0));
        require(fundQ > 0 && fundE > 0 && fundBQ > 0 && fundBE > 0, "init: set all four STATIC_FUND_*");
        require(
            IERC20(quote).allowance(deployer, address(this)) >= fundQ + fundBQ
                && IERC20(nvda).allowance(deployer, address(this)) >= fundE + fundBE,
            "init: approve script for quote+equity first"
        );
        int24 initialTick = int24(vm.envInt("STATIC_INITIAL_TICK"));
        IERC20(quote).transferFrom(deployer, address(vault), fundQ);
        IERC20(nvda).transferFrom(deployer, address(vault), fundE);
        vault.fundHook(fundQ, fundE);
        hub.pushToActive();
        vault.initializeHook(keyA, TickMath.getSqrtPriceAtTick(initialTick));
        IERC20(quote).transferFrom(deployer, address(hub.bookB()), fundBQ);
        IERC20(nvda).transferFrom(deployer, address(hub.bookB()), fundBE);
        vault.initializeHook(keyB, TickMath.getSqrtPriceAtTick(initialTick));
        console2.log("BooksInitialized: true");
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

    function _deployTranches(address vaultAddr, address deployer, uint64 expiry) internal {
        address quote = vm.envAddress("QUOTE_ADDRESS");
        address nvda = vm.envAddress("NVDA_ADDRESS");
        TrancheAccountant accountant = new TrancheAccountant(deployer);
        accountant.setKeeper(vm.envOr("AGENT_OPERATOR_ADDRESS", deployer));
        HookShareToken share = LedgerVault(vaultAddr).shareToken();
        SeniorVault senior = new SeniorVault(
            IERC20(address(share)),
            IERC20(quote),
            IERC20(nvda),
            IHookSharePipe(address(vaultAddr)),
            deployer,
            address(accountant),
            expiry
        );
        JuniorVault junior = new JuniorVault(
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

    function _bootstrapStack(LedgerVault vault, address deployer) internal {
        if (!vm.envOr("STATIC_BOOTSTRAP", true)) return;
        address quote = vm.envAddress("QUOTE_ADDRESS");
        uint8 quoteDec = vault.quoteDecimals();
        require(quoteDec > 0, "bootstrap: bad quote decimals");
        uint256 bootAmount = 10 ** (quoteDec - 1);
        require(IERC20(quote).balanceOf(deployer) >= bootAmount, "bootstrap: fund deployer with quote");
        IERC20(quote).approve(address(vault), bootAmount);
        uint256 bootShares = vault.wrapQuote(bootAmount, deployer);
        console2.log("BootstrapQuote:", bootAmount);
        console2.log("BootstrapShares:", bootShares);
    }

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
