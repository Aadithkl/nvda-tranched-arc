// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";
import { IPoolManager } from "v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "v4-core/src/types/PoolKey.sol";
import { Currency } from "v4-core/src/types/Currency.sol";
import { IHooks } from "v4-core/src/interfaces/IHooks.sol";
import { Hooks } from "v4-core/src/libraries/Hooks.sol";
import { HookMiner } from "v4-periphery/test/shared/HookMiner.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { TestToken } from "../../src/test-only/TestToken.sol";
import { NVDAPriceOracle } from "../../src/oracle/NVDAPriceOracle.sol";
import { PoolGuardHook } from "../../src/hook/PoolGuardHook.sol";
import { PoolGuardSimulator } from "../../src/hook/PoolGuardSimulator.sol";
import { LedgerVault } from "../../src/vaults/LedgerVault.sol";

/// @notice Minimal lending venue: aToken accounting + deposit/withdraw.
contract MockAToken is TestToken {
    constructor() TestToken("aUSD", "aUSDC", 6) {}

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

contract MockVenue {
    IERC20 public immutable asset;
    IERC20 public immutable aToken;

    constructor(IERC20 asset_, IERC20 aToken_) {
        asset = asset_;
        aToken = aToken_;
    }

    function deposit(address asset_, uint256 amount, address onBehalfOf, uint16) external {
        require(asset_ == address(asset), "asset");
        asset.transferFrom(msg.sender, address(this), amount);
        MockAToken(address(aToken)).mint(onBehalfOf, amount);
    }

    function withdraw(address asset_, uint256 amount, address to) external returns (uint256) {
        require(asset_ == address(asset), "asset");
        MockAToken(address(aToken)).burn(msg.sender, amount);
        asset.transfer(to, amount);
        return amount;
    }
}

/// @notice Minimal strategy module: reports a fixed outstanding loop debt and pulls
///         repayment funding from the vault exactly like `StrategyModule.repay` does.
contract MockStrategyModule {
    using SafeERC20 for IERC20;

    IERC20 public asset;
    address public vault;
    uint256 public loopDebt;

    constructor(IERC20 asset_, uint256 debt_) {
        asset = asset_;
        loopDebt = debt_;
    }

    function setVault(address vault_) external {
        vault = vault_;
    }

    function setDebt(uint256 debt_) external {
        loopDebt = debt_;
    }

    function totalAssets() external view returns (uint256) {
        return 0;
    }

    function badDebt() external view returns (uint256) {
        return 0;
    }

    function totalLoopDebt() external view returns (uint256) {
        return loopDebt;
    }

    function pullToVault(uint256 amount) external returns (uint256 pulled) {
        asset.safeTransferFrom(vault, address(this), amount);
        pulled = amount;
    }

    function exitAll() external {}
}

/// @notice Audit PoC: `LedgerVault.supplyIdle`/`supplyIdleAmount` (added in 570f495)
///         parks the vault's ENTIRE idle quote into the lending venue without
///         reserving outstanding loop debt, while the same commit makes
///         `fundHook` and `_ensureQuote` reserve it. `StrategyModule.repay` /
///         `deleverage` / `exitAll` fund repayments by pulling from the vault's
///         balance, so parking the reserve strands the debt-repayment capital.
contract AuditVenueReserveTest is Test {
    IPoolManager internal manager;
    PoolGuardSimulator internal simulator;
    PoolGuardHook internal hook;
    LedgerVault internal vault;
    NVDAPriceOracle internal oracle;
    TestToken internal quote;
    TestToken internal nvda;
    TestToken internal aToken;
    MockVenue internal venue;
    MockStrategyModule internal module;

    address internal keeper = makeAddr("keeper");
    uint64 internal expiry;

    function setUp() public {
        manager = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        simulator = new PoolGuardSimulator();
        quote = new TestToken("USD Coin", "mUSDC", 6);
        nvda = new TestToken("NVIDIA", "mNVDA", 18);
        aToken = new MockAToken();

        oracle = new NVDAPriceOracle(8, address(this));
        oracle.setWriter(address(this), true);
        oracle.setMaxStaleness(1 hours);
        oracle.updatePrice(200e8, 2, uint32(block.timestamp), bytes32(0));

        address token0 = address(quote) < address(nvda) ? address(quote) : address(nvda);
        address token1 = token0 == address(quote) ? address(nvda) : address(quote);
        expiry = uint64(block.timestamp + 30 days);

        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
                | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
        );
        bytes memory args = abi.encode(manager, simulator, address(oracle), address(nvda), address(0), address(this));
        (, bytes32 salt) = HookMiner.find(address(this), flags, type(PoolGuardHook).creationCode, args);
        hook = new PoolGuardHook{ salt: salt }(
            manager, simulator, address(oracle), address(nvda), address(0), address(this)
        );

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(token0),
            currency1: Currency.wrap(token1),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });

        vault = new LedgerVault(
            manager, hook, key, IERC20(address(quote)), IERC20(address(nvda)), address(oracle), expiry, address(this)
        );
        vault.setKeeper(keeper);

        venue = new MockVenue(IERC20(address(quote)), IERC20(address(aToken)));
        vault.setVenue(address(venue), address(aToken));

        module = new MockStrategyModule(IERC20(address(quote)), 0);
        module.setVault(address(vault));
        vault.setStrategyModule(address(module));
    }

    /// @notice PoC 1: the vault's hook-funding path DOES reserve outstanding loop debt.
    function test_fundHookReservesLoopDebt() public {
        module.setDebt(600e6);
        quote.mint(address(vault), 1_000e6);
        vm.prank(keeper);
        vm.expectRevert();
        // 1000 idle, 600 reserved -> only 400 may be funded
        vault.fundHook(500e6, 0);
    }

    /// @notice PoC 2: the venue-parking path does NOT reserve it — the whole idle
    ///         balance (including the debt-repayment reserve) is swept into the venue.
    function test_supplyIdleIgnoresLoopDebtReserve() public {
        module.setDebt(600e6);
        quote.mint(address(vault), 1_000e6);
        vm.prank(keeper);
        uint256 supplied = vault.supplyIdle();

        assertEq(supplied, 1_000e6, "the whole idle balance was parked");
        assertEq(quote.balanceOf(address(vault)), 0, "no quote left for the loop repayment");
        assertEq(aToken.balanceOf(address(vault)), 1_000e6, "venue holds the reserve");
        assertEq(module.totalLoopDebt(), 600e6, "debt still outstanding and unfunded");
    }

    /// @notice PoC 3: after parking, the strategy module cannot pull repayment funds
    ///         from the vault (the reserve is stranded in the venue).
    function test_parkedReserveCannotFundRepayment() public {
        module.setDebt(600e6);
        quote.mint(address(vault), 1_000e6);
        vm.prank(keeper);
        vault.supplyIdle();

        // The vault approves the module for one repayment pull, as the keeper does
        // before `StrategyModule.repay` / `deleverage` / `exitAll`.
        vm.prank(keeper);
        vault.approveStrategy(address(quote), 1_000e6);

        vm.expectRevert();
        module.pullToVault(600e6);
    }

    /// @notice PoC 4: control — with no loop debt the park is harmless.
    function test_parkWithoutDebtIsFine() public {
        module.setDebt(0);
        quote.mint(address(vault), 1_000e6);
        vm.prank(keeper);
        uint256 supplied = vault.supplyIdle();
        assertEq(supplied, 1_000e6);
        assertEq(aToken.balanceOf(address(vault)), 1_000e6);
    }
}
