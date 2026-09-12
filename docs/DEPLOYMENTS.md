# Deployments

## Arc Testnet (chainId 5042002, RPC `https://rpc.testnet.arc.network`)

### x402 / Circle Gateway

| Item | Value |
|---|---|
| Gateway Wallet | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` |
| Gateway Minter | `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B` |
| Gateway Domain ID | `26` |
| Testnet facilitator | `https://gateway-api-testnet.circle.com` |
| Demo seller (`scripts/x402-seller.mjs`) | `0x25E7D4287eCDCFA04BF59aBEd594e51dc3DabaF3` |
| Latest x402 oracle update | tx `0x63640b6d9cc19814b1578cfdea1bb1b022d4228c2085c0936617ab10199f0264` (block `61456133`, mid 218.36e8, status 3 = post-market; paymentRef `0x1a1a…4f72` = keccak256 of the Circle settlement id) |

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
| Pair | USDC `0x3600…0000` (6d) / NVDA (`NVDA_ADDRESS`, 18d) |
| Params | `NVDA_POOL_FEE` / `NVDA_POOL_TICK_SPACING` (default `3000` / `60`), no hook |
| Initial price | tick derived from `NVDA_POOL_PRICE` (default 200 USD/NVDA) and token decimals |
| Liquidity | `NVDA_POOL_LIQUIDITY` over a ±6000-tick band around the derived tick |
| Tool | `node scripts/seed-usdc-nvda.mjs [--execute] [--swap]` |

**Important (Arc quirk):** Arc's USDC `transferFrom` calls a compliance precompile
(`0x1800…0001 isBlocklisted`) that Foundry's local EVM does not emulate, so
`forge script` cannot simulate/broadcast real-USDC flows (even with
`--skip-simulation`, because scripts are replayed locally). Use the viem script or
`cast send`; the Arc node itself executes the precompile fine.

### Lending — Aave V2 semi-fork (ours, MIT)

| Contract | Address |
|---|---|
| `LendingPoolAddressesProvider` | `0xd70165E2eC57c8367f6D93eB8F576978d3b75529` |
| `PeggedPriceOracle` | `0x6DC2A77B42B4049f96593b5Aa979227580aA510b` |
| `LendingPool` | `0x75E6E7711a87dbC53D613806bb961bc1Bb01e0c8` |
| `LendingPoolConfigurator` | `0x43169D2DaaC35E90ec4487E7f156A4958D20EFBe` |
| `DefaultReserveInterestRateStrategy` | `0xdd4DdB9a2f33de6eb6b53B064CC09c60F82381Dc` |
| `aUSDC` / `dUSDC` | `0x7d38DBec34bbe287181328E9f5Bd66A199E80eA1` / `0x2C42c727A7cE9B0f3FC5cbad473228E948ee8ee6` |

- Markets: USDC + NVDA (both initialized by `DeployLending.s.sol`); the current live pool predates the
  NVDA reserve — the v3 redeploy re-inits with USDC + NVDA. No WETH, no Chainlink.
  Pegs: USDC `1e8`, NVDA `200e8` (`NVDA_PEGGED_PRICE`, USD 8d).
- Reserve params: LTV `7500`, liquidation threshold `8000`, bonus `10500`, reserve factor `1000`.
- Rate model: base `0`, slope1 `4%`, slope2 `60%`, optimal utilization `80%`.
- `poolAdmin` / provider owner = deployer `0x749E3A3a743889beC27584C1C8212f4cf926b431`.
- Deploy: `forge script script/DeployLending.s.sol --rpc-url arc_testnet --broadcast` (no USDC transfers, so Foundry simulation is safe);
  txs in `broadcast/DeployLending.s.sol/5042002/run-latest.json`.
- Seeded: **10 USDC** deposited by the deployer — `aUSDC` balance = 10 (NVDA seeds after the v3 redeploy).
  - approve USDC `0x9388b95e…`, deposit USDC `0xbb4e6fcf…`
- Pegs (softcoded, owner-settable): USDC `1e8`, NVDA `200e8` (`NVDA_PEGGED_PRICE`); demo re-set tx `0x54f26bf3…` (USDC).
  Ops tool: `npm run lending:status | lending:set-price | lending:seed` (`scripts/lending-admin.mjs`).
- Verified onchain: provider wiring, oracle pegs, aToken names/symbols. Docs: `docs/LENDING.md`.

### TrancheJITHook live demo (test exercise)

| Contract | Address |
|---|---|
| `TrancheJITHook` | `0xceb3ed91e12b828cbea2d1f407d5d3c99e192ac0` |
| `HookShareToken` (created by hook) | `0xFA8F387fAa130Fffe46A9513D1090f69478A4BAF` |
| Demo price oracle (`NVDAPriceOracle` instance) | `0xef7295e74b5ac0a8f3caf89ec19bd26e5f812174` |
| `StrategyController` | `0x6ea148829e32ba3051869f73092c015d34661edd` |
| `StrategyAgent` | `0x636bfd9e072c9ba93453a2d798Cb7D09b8Fe1E8c` |
| Agent operator (separate key, local `.env`) | `0xbA965f327c05E9daD998f387C1Cb4E6720eEaf95` |
| PoolId | `0x1adee7f4fc915d8217b238785d857f49c431ded9ed48bdaf1e8ecf3559eb7f86` |

- Pool: dynamic fee (`0x800000`), tickSpacing `1` (v2 test deployment; superseded by the v3 USDC/NVDA redeploy).
- Liquidity: seeded over the v2 test range (tx `0x2b10fd16…`).
- Live exercise txs: fund operator `0x343f8392…`, `submitParams` `0x2cb53bcb…`, swap @ fee 3000 `0x298179e5…`,
  `submitBaseFee(5000)` `0x06666bc4…`, swap @ fee 5000 `0x7b0d966f…`, oracle move `0x4956708f…`,
  **toxic swap charged surge 30000 (3%)** `0x24fdfebc…`, wrap 1 USDC → Aave `0xd4fbc548…`,
  unwrap 0.5 shares `0xd8161857…`, oracle reset `0x43e1429e…`.
- Result: oracle-anchored toxic-flow pricing, agent-controlled dynamic fee, TTL-gated quoting, and the
  Aave rest state (aToken credited/debited) all verified onchain.
- Runbook: `npm run hook:demo -- --status | --set-params | --add-liquidity | --swap <usdc6> | --set-fee <fee> | --set-oracle <8d> | --wrap <usdc6> | --unwrap <shares18> | --fund-operator <usdc6>`
- Deploy txs: `broadcast/DeployTrancheHookDemo.s.sol/5042002/run-latest.json`.

### Tranche stack — current test deployment (v2, superseded by v3)

Source of truth: `deployments/arc-testnet.json` (`stack`), regenerated by `npm run export:pack`.
Never hardcode these in app code; read them from the manifest / `.env`.

| Contract | Address |
|---|---|
| `TrancheJITHook` (v2) | `0xB229976cB5F64C6f747033c26217299AeCD42Ac0` |
| `HookShareToken` (created by hook) | `0x917386b70E03cdC2026B612fd1388d9DfC349C96` |
| `TrancheAccountant` | `0x3903C50fB7066C9a2d473d772e4dA48cfb4563a4` |
| `SeniorVault` | `0x708C2FF1d6829cf1980da8Ad4f6A1f14F958018e` |
| `JuniorVault` | `0x19858E406Eb262CdD899AF8Dc2aa866521b3135c` |
| PoolId (dynamic fee, tickSpacing 1) | `0xba11852e08659fc30d1f5221e7de78a3a0b8d9ec69a99341868fe6c5d9e3c4c1` |
| `StrategyController` / `StrategyAgent` | `0x6ea148829e32ba3051869f73092c015d34661edd` / `0x636bfd9e072c9ba93453a2d798cb7d09b8fe1e8c` |
| Keeper (operator) | `0xbA965f327c05E9daD998f387C1Cb4E6720eEaf95` |

The v2 stack was the test-pair deployment. The v3 redeploy swaps in the USDC/NVDA dual-token
`TranchePipeModule` and replaces hook/share/accountant/vault/controller addresses.

### V3 redeploy checklist

**Before running (required env):** `USDC_ADDRESS`, `NVDA_ADDRESS` (18-dec NVDA token on Arc),
`NVDA_ORACLE` (x402-pushed price for the hook), `NVDA_PEGGED_PRICE` (USD 8d, e.g. `20000000000`),
and the pool knobs `NVDA_POOL_FEE` / `NVDA_POOL_TICK_SPACING` / `NVDA_POOL_PRICE` (tick is derived).
`NVDA_ADDRESS` is the single source for the pool, the lending reserve, and the vault equity leg.

1. Fill `.env`: `USDC_ADDRESS`, `NVDA_ADDRESS`, `NVDA_ORACLE`, `NVDA_PEGGED_PRICE`,
   `V3_INITIAL_TICK` (compute for the address-sorted pair and 18/6 decimals), `V3_TICK_SPACING`,
   `HOOK_DEMO_CONTROLLER`, `LENDING_POOL`, optional `REBALANCE_ROUTER` / `REBALANCE_POOL_FEE` /
   `REBALANCE_TICK_SPACING`.
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

### Hook proof (SmokeHook, test-only)

| Item | Value |
|---|---|
| `SmokeHook` | `0x3Cee7340818FD498e54D44DA2E634d02a72800C0` |
| Hook poolId | `0x092c224a431c94b955394fcdd56fcccae4970b2223fcbd9796737e631a023677` |
| Permissions | `beforeSwap` + `afterSwap` (salt-mined address) |
| Onchain proof | `swapCount = 1`, `lastSqrtPriceX96 = 1420897083832996649242119661407270`, `lastHookDataHash = keccak256(0xfeed)` |

### Not yet deployed

- v3 stack: USDC/NVDA dual-token `TrancheJITHook` + `TranchePipeModule` + tranche vaults — see the
  redeploy checklist above.
- Universal Router (deferred; DemoRouter + PositionManager cover swaps/LP)
- Lending extensions (liquidations, treasury accrual, stable-rate debt) — documented gaps in `docs/LENDING.md`

## Deprecated (do not integrate)

| Contract | Address | Why |
|---|---|---|
| `PoolManager` (v4-core v4.0.0) | `0xF570d08D4388D6487E348C28c00D714a347D33c4` | superseded by the 1.0.2-era core for periphery compatibility |
| `DemoRouter` (old) | `0x2022D0876132E26f32Df4a3bDdF2cFcB96010B28` | bound to the old PoolManager |
| `NVDAPriceOracle` (Chainlink-era) | `0xa2c6489fA9b1dba1ec63f410AB042543c86aa15F` | Chainlink removed |

## Indexing (The Graph)

Subgraph in `subgraph/` (`arc-testnet`): `NVDAPriceOracle` + `PoolManager`.
Not yet deployed to Graph Studio (pending a Studio key); manifests carry the current addresses
and start blocks.

## Conventions

- `Test*`/m-token deployments are test-only and clearly labeled; no test token is used in the oracle price path.
- Re-run deploy scripts through simulation first (`forge script ... --rpc-url <rpc>`), then `--broadcast`.
- Keys live only in local `.env`; never committed.
