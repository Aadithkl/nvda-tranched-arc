# Deployments

## Arc Testnet (chainId 5042002, RPC `https://rpc.testnet.arc.network`)

### Circle Gateway

| Item | Value |
|---|---|
| Gateway Wallet | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` |
| Gateway Minter | `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B` |
| Gateway Domain ID | `26` |
| Testnet facilitator | `https://gateway-api-testnet.circle.com` |
| Latest oracle update | tx `0x63640b6d9cc19814b1578cfdea1bb1b022d4228c2085c0936617ab10199f0264` (block `61456133`, mid 218.36e8, status 3 = post-market) |

### Oracle — `NVDAPriceOracle` (x402 push, no Chainlink)

| Contract | Address |
|---|---|
| `NVDAPriceOracle` | `0x2D58dE768ABff2da0e4a00BE92f63DFB6CE0738A` |

- Deployment block: `61455183`
- Owner / writer: `0x749E3A3a743889beC27584C1C8212f4cf926b431`
- `maxStaleness`: 300s
- Deploy txs: `broadcast/DeployOracle.s.sol/5042002/run-latest.json`

### Uniswap v4 fork — core

| Contract | Address | Notes |
|---|---|---|
| `PoolManager` | `0xFc4146c0de93B518Ce60158e2eD0943697c3Ae67` | v4-core @ `59d3ecf5` (BUSL-1.1 → MIT; see `LICENSES.md`), owner = deployer |
| `Permit2` | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | canonical predeploy |
| `Multicall3` | `0xcA11bde05977b3631167028862bE2a173976CA11` | canonical predeploy |
| Deterministic CREATE2 deployer | `0x4e59b44847b379578588920cA78FbF26c0B4956C` | canonical predeploy |

### Uniswap v4 fork — periphery (v4-periphery @ `dce236d`, MIT)

| Contract | Address | Deploy method |
|---|---|---|
| `DemoRouter` (ours, MIT) | `0xC76fd7Ee062C5E498a0E2be6CcB7c2aD2dF0d062` | CREATE |
| `PositionDescriptor` | `0x449d1311782EC031087199d497bF05A35fCe7a4f` | CREATE2 salt `0x00` |
| `PositionManager` | `0x7Cdfa5f9369c3869c63B0fF0Ca89165Ae2B2b111` | CREATE2 salt `0x03` |
| `StateView` | `0xb60F573748341F202818B09730d59333392b8CcC` | CREATE2 salt `0x00` |
| `V4Quoter` | `0x8f9ba259d70aF45c26Ef56A713Fb6F0159C4526B` | CREATE2 salt `0x00` |
| `ReservesLens` | `0x8D98aa45020c81F4751271B70cecc6399659bCef` | CREATE2 project salt |
| `TestWETH9` (test-only) | `0x08Ac921E786a5e19eC5D053E4c4eabe3BE042f90` | CREATE; constructor dependency only |
| `mUSDC` / `mNVDA` (test-only) | `0x071E67900B728370969eFF988085CF3D84195E31` / `0x308F5c32fF62c24DA5F66f4F6d40d698B8d37BE9` | reused from M2a |

- Demo pool (hookless): mUSDC/mNVDA, fee `3000`, tickSpacing `60`, seeded + swap executed.
- Verified wiring: `PositionManager.poolManager()/permit2()/tokenDescriptor()`, `StateView.poolManager()`, `V4Quoter.poolManager()`, `PositionDescriptor.wrappedNative()` → TestWETH9.
- Deploy txs: `broadcast/DeployV4Stack.s.sol/5042002/run-latest.json`

### USDC/NVDA venue pool (plain pool, no hook)

| Item | Value |
|---|---|
| Pair | USDC `0x3600…0000` (6d) / `MOCK_NVDA` `0x308F…BE9` (18d; test token until a real `NVDA_ADDRESS` is listed) |
| PoolId | `0x8b3f39708820fd7b754259c9f05d288aa787b79fd3a6986451c40b248c0d459f` |
| Params | fee `3000` (0.30%), tickSpacing `60`, no hook |
| Range | `[-226380, -220380]` around tick `-223338` (≈ 200 USD/NVDA at seed) |
| Liquidity | `30,072,089,785,824` ≈ **60 USDC + 0.3 NVDA** (deployer is the only LP) |
| Volume | **26 swaps, ≈ $98 gross** on 2026-09-13 (fees ≈ $0.29 accrue to the LP); subgraph `swapCount = 26` |
| Tool | `node scripts/seed-usdc-nvda.mjs --execute --usdc 60 --nvda 0.3 --swaps 16 --swap-usdc 3` (add `--skip-lp` for volume-only runs) |
| Txs | init `0xe9005d0a…`, addLiquidity `0x9d238fc9…`, first swap `0x3c189949…`, last swap `0x7953dd0d…` |

**Important (Arc quirk):** Arc's USDC `transferFrom` calls a compliance precompile
(`0x1800…0001 isBlocklisted`) that Foundry's local EVM does not emulate, so
`forge script` cannot simulate/broadcast real-USDC flows (even with
`--skip-simulation`, because scripts are replayed locally). Use the viem script or
`cast send`; the Arc node itself executes the precompile fine.

### Lending — Aave V2 semi-fork (ours, MIT)

Current deployment (2026-09-13, USDC + NVDA, borrow-capacity fix):

| Contract | Address |
|---|---|
| `LendingPoolAddressesProvider` | `0x8757b2a066f1a4F52ff63F2aCeb87F802908C886` |
| `PeggedPriceOracle` | `0xf74237e03574eF9E2824cC42021A39f7881ad781` |
| `LendingPool` | `0x492adCb2e5d5b2f7e82c8c9E9789Bd6dCBff7028` |
| `LendingPoolConfigurator` | `0x03f17Df6903228edc76b07Fce52FaEAa6c4bA4C4` |
| `DefaultReserveInterestRateStrategy` | `0x8bb7733B71ad2daaEc506813744831744EC195b7` — base `0`, slope1 `9%`, slope2 `60%`, optimal `80%` |
| `aUSDC` / `dUSDC` | `0xAF09f106Aa27EdaA0ea7f7dB3B4a92c6b929dc4F` / `0xfaeFcc1D448330aed160Ff934F1fE86D55c9d38f` |
| `aNVDA` / `dNVDA` | `0x3F6Ee392f39d323652CD1cE528BCbD3e494F981D` / `0x134187EE4ceB9c2E187a04750c9C3eB72075642D` |

- Markets: **USDC + NVDA** (NVDA = `MOCK_NVDA` 18d until a real `NVDA_ADDRESS` is set). No WETH, no Chainlink.
  Pegs: USDC `1e8`, NVDA `200e8` (`NVDA_PEGGED_PRICE`, USD 8d).
- Reserve params: LTV `7500`, liquidation threshold `8000`, bonus `10500`, reserve factor `1000`.
- Deploy: `NVDA_ADDRESS=$MOCK_NVDA LENDING_RATE_SLOPE1=0.09e27 forge script script/DeployLending.s.sol --rpc-url arc_testnet --broadcast`
  (no USDC transfers, so Foundry simulation is safe); txs in `broadcast/DeployLending.s.sol/5042002/run-latest.json`.
- **Borrow-capacity fix:** `borrow` converts the amount to USD base (`amount × price / 10^decimals`) before
  comparing against `availableBorrows`; the earlier code compared raw token units and broke 18-dec assets.
- Flowing since 2026-09-13 (deployer-wallet seeds):
  USDC supplied **230**, borrowed **160** — utilization **69.6%**, supply **4.90%**, borrow **7.83%**;
  NVDA supplied **2**, borrowed **1.2** — utilization **60.0%**, supply **3.64%**, borrow **6.75%**;
  account collateral **$630**, debt **$400**, HF **1.26**.
  Txs: seed USDC `0xbe91a532…`, seed NVDA `0x5289f851…`, borrow USDC `0x16ffecce…`, borrow NVDA `0xb05c71b0…`,
  `updateState` USDC `0x023c539f…`, NVDA `0x41887181…`.
- Pegs (softcoded, owner-settable): USDC `1e8`, NVDA `200e8`; ops:
  `npm run lending:status | lending:set-price | lending:seed` plus `--deposit / --borrow / --repay / --withdraw /
  --update / --set-strategy / --init-nvda / --mint-nvda / --deposit-nvda / --borrow-nvda` (`scripts/lending-admin.mjs`).
- Legacy pre-fix lending deployments are deprecated; `.env` + `deployments/arc-testnet.json` point at this stack.
- Verified onchain: provider wiring, oracle pegs, aToken names/symbols. Docs: `docs/LENDING.md`.

### Tranche stack — live v3 (USDC/NVDA JIT, 2026-09-13)

Source of truth: `deployments/arc-testnet.json` (`stack`), regenerated by `npm run export:pack`.
Never hardcode these in app code; read them from the manifest / `.env`.

| Contract | Address |
|---|---|
| `TrancheJITHook` (v3, JIT quoting live) | `0x5C374e0B4F3646705839BE9D2b45F6753EAC6aC0` |
| `HookShareToken` (created by hook) | `0x9341fA835A44A225E7f36a245A149794239c221A` |
| `TranchePipeModule` | `0x04614f09DfC7D66B5072FB9B745C9B1b9503bA5e` |
| `TrancheAccountant` | `0x8c0FACD06b0bB540F82817ee5731eDA9D8E75Ce3` |
| `SeniorVault` / `JuniorVault` | `0x2b9Bc484b5De5ffd96e0aD37a05D0ff1B4380266` / `0xdBEAaAc8281459510E871aBdE4bf88C8AC530F8a` |
| PoolId (USDC/NVDA, dynamic fee, tickSpacing 60) | `0x93b8dfd381ccd69e771c70fb0dc6fc19ab9b031d60197032372e46000fa67292` |
| `StrategyController` / `StrategyAgent` | `0x14F723bd9D1Cd4Ab288EeeeADb14D6a00d54Aade` / `0x2235C6a19C2C80e93f74915c922B1B319B954320` |
| Keeper (operator) | `0xbA965f327c05E9daD998f387C1Cb4E6720eEaf95` |

- Deploy (both steps with `--slow` to avoid Arc RPC nonce races):
  `DeployTrancheHookV3` (fresh controller+agent when `HOOK_DEMO_CONTROLLER` is unset) then
  `DeployTrancheStack` with `HOOK_ADDRESS` + `PIPE_ADDRESS`. Blocks `61893891…61894101`.
- Funded + JIT exercised: senior 10 USDC / junior 5 USDC; inventory seeded 20 USDC + 0.02 NVDA
  (later topped up +0.03 NVDA); params baseFee `3000`, band `300`, TTL/grace `3600`, maxDeploy `4` USDC,
  bucketTicks `60`. **23 swaps routed through the hook** (2 USDC / 0.01 NVDA sizes) produced 23 JIT
  episodes — all returning to rest — with **$42.91 gross volume and $3.06 fees captured** (13 toxic
  surge quotes up to 29.5%); hook managed assets grew `35.00 → 51.74` USDC and JIT net realized
  (claims − seeds) ≈ **+$3.73**. Txs: seed USDC `0xd000e0e9…`, seed NVDA `0xd112e32c…` (+top-up
  `0xbb7be3bc…`), params `0x270c22f2…`, swaps `0x760329ae…` / `0xf8ecaa56…` / `0xc79e4049…`
  (13.2% toxic) / `0x806816e6…` (29.5% toxic).
- Subgraph v3b (`tranch-stock/v3b-20260913`, start block `61891077`) indexes the hook pool, JIT
  episodes/claims, quotes and vault flows; `hookStates` reports `totalQuotes = 23`,
  `totalJitDeployments = 23`, `totalJitRemovals = 23`.
- The v2 stack (hook `0xB229…2Ac0`, EURC-era test pair) is deprecated; it never expires (`expiry()`
  reverts), while the v3 vaults inherit the hook's `EXPIRY_TIMESTAMP` (`1789862400`, ~6 days out).

### V3 redeploy checklist

**Before running (required env):** `USDC_ADDRESS`, `NVDA_ADDRESS` (18-dec NVDA token on Arc),
`NVDA_ORACLE` (x402-pushed price for the hook), `NVDA_PEGGED_PRICE` (USD 8d, e.g. `20000000000`),
and the pool knobs `NVDA_POOL_FEE` / `NVDA_POOL_TICK_SPACING` / `NVDA_POOL_PRICE` (tick is derived).
`NVDA_ADDRESS` is the single source for the pool, the lending reserve, and the vault equity leg.

1. Fill `.env`: `USDC_ADDRESS`, `NVDA_ADDRESS`, `NVDA_ORACLE`, `NVDA_PEGGED_PRICE`,
   `V3_INITIAL_TICK` (compute for the address-sorted pair and 18/6 decimals), `V3_TICK_SPACING`,
   `HOOK_DEMO_CONTROLLER`, `LENDING_POOL`, optional `REBALANCE_ROUTER` / `REBALANCE_POOL_FEE` /
   `REBALANCE_TICK_SPACING`, and optional `EXPIRY_TIMESTAMP` (unix seconds, shared by the hook and
   both vaults; blank/`0` = no expiry).
2. `forge script script/DeployTrancheHookV3.s.sol:DeployTrancheHookV3 --rpc-url arc_testnet --broadcast -vv`
   (deploys the hook + `TranchePipeModule`, inits the pool, wires module/controller). Set
   `HOOK_ADDRESS` and `PIPE_ADDRESS` from the logs.
3. `forge script script/DeployTrancheStack.s.sol:DeployTrancheStack --rpc-url arc_testnet --broadcast -vv`
   (accountant + senior/junior vaults over `PIPE_ADDRESS`; wires hook/accountant/controller).
4. Update `.env`: `TRANCHE_HOOK`, `TRANCHE_SHARE`, `TRANCHE_ACCOUNTANT`, `TRANCHE_SENIOR`,
   `TRANCHE_JUNIOR`, `TRANCHE_POOL_ID`, `PIPE_ADDRESS`, `AGENT_HOOK`, `AGENT_MODULE`, `AGENT_KEEPER`.
5. `npm run export:pack` then `npm run subgraph:sync` (manifest + ABIs + subgraph addresses).
6. Seed the lending market (`npm run lending:seed` → 10 USDC + 1 NVDA) and the external rebalance
   venue (`npm run seed:nvda -- --execute`), push a fresh oracle price, then `npm run agent:tick -- --submit`.

### Historical proofs (test-only, verified)

| Item | Value |
|---|---|
| `SmokeHook` (v4 callback proof) | `0x3Cee7340818FD498e54D44DA2E634d02a72800C0` |
| SmokeHook poolId | `0x092c224a431c94b955394fcdd56fcccae4970b2223fcbd9796737e631a023677` |
| JIT demo hook (pre-v2 exercise) | `0xceb3ed91e12b828cbea2d1f407d5d3c99e192ac0` |
| JIT demo poolId (dynamic fee, tickSpacing 1) | `0x1adee7f4fc915d8217b238785d857f49c431ded9ed48bdaf1e8ecf3559eb7f86` |

Verified onchain: v4 `beforeSwap`/`afterSwap` fired with exact `hookData` (`swapCount = 1`,
`lastHookDataHash = keccak256(0xfeed)`); JIT demo charged the oracle-anchored toxic surge (3%),
took agent-set dynamic fees under the TTL gate, and moved the Aave rest state (`aToken`
credited/debited). Tx trail: `broadcast/DeployTrancheHookDemo.s.sol/5042002/run-latest.json`;
runbook `npm run hook:demo`.

### Not yet deployed

- Universal Router (deferred; DemoRouter + PositionManager cover swaps/LP)
- Lending extensions (liquidations, treasury accrual, stable-rate debt) — documented gaps in `docs/LENDING.md`

## Deprecated (do not integrate)

| Contract | Address | Why |
|---|---|---|
| `PoolManager` (v4-core v4.0.0) | `0xF570d08D4388D6487E348C28c00D714a347D33c4` | superseded by the 1.0.2-era core for periphery compatibility |
| `DemoRouter` (old) | `0x2022D0876132E26f32Df4a3bDdF2cFcB96010B28` | bound to the old PoolManager |
| `NVDAPriceOracle` (Chainlink-era) | `0xa2c6489fA9b1dba1ec63f410AB042543c86aa15F` | Chainlink removed |

## Indexing (The Graph)

Live: Studio subgraph **Tranch-Stock** (`tranch-stock`) —
`https://api.studio.thegraph.com/query/1760210/tranch-stock/version/latest`. Sources
(`NVDAPriceOracle`, `PoolManager`, hook/controller/agent, vaults, accountant) are synced from
`deployments/arc-testnet.json` with per-source start blocks (`npm run subgraph:sync`, verify with
`--check`). Entities and queries: `docs/GRAPH.md`; MCP setup: `docs/MCP.md`.

## Conventions

- `Test*`/m-token deployments are test-only and clearly labeled; no test token is used in the oracle price path.
- Re-run deploy scripts through simulation first (`forge script ... --rpc-url <rpc>`), then `--broadcast`.
- Keys live only in local `.env`; never committed.
