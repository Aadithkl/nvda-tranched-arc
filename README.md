# NVDA Tranched Platform — `nvda-tranched-arc`

Stablecoin-native RWA capital structuring on **Arc Testnet**: NVDA exposure split into
Senior (fixed 5% target) and Junior (leveraged) tranches, with capital resting in a
lending market and a defensive Uniswap v4 JIT hook executing only in `+EV`, market-open,
oracle-valid windows under an agent-operated strategy controller.

## Status

| Milestone | Scope | State |
|---|---|---|
| M0 | Env, repo, Foundry, deps, licenses | done |
| M1 | x402 price oracle + keeper + Circle Gateway rail (no Chainlink) | live on Arc + verified end-to-end |
| M2a | Uniswap v4 fork: core + full periphery + hook proof | done — 8 contracts live, callbacks verified |
| M2b | Aave V2 semi-fork (USDC + NVDA markets, pegged oracle) on Arc Testnet | live on Arc — addresses in `docs/DEPLOYMENTS.md`, docs in `docs/LENDING.md` |
| M3 | `TrancheJITHook` — JIT engine, dynamic fee, toxic-flow pricing, Aave rest | live (v3 dual-token USDC/equity redeploy pending) |
| M4 | `StrategyController` + agent daemon | live — bounded controller; LLM strategy manager (6h paid verdict) with deterministic rails |
| M5 | ERC-7540 Senior/Junior vaults + ERC-7575 hook share + `TrancheAccountant` | live — dual-token exits via `TranchePipeModule` |
| M6 | E2E on Arc Testnet, docs/ABIs | pending |

Indexing: The Graph subgraph (`subgraph/`) indexes the x402 oracle, v4 pools, and the tranche stack; live query URL in `deployments/arc-testnet.json`.
x402 on Arc: Circle Gateway rail verified end-to-end (pay $0.001 on Arc → NVDA quote → onchain oracle update).
Hook path proven: `SmokeHook` deployed at a salt-mined address, `beforeSwap`/`afterSwap` fired with exact `hookData` on Arc (poolId `0x092c…3677`).
Frontend pack: `deployments/arc-testnet.json` (manifest) + `docs/abis/` + `docs/FRONTEND_INTEGRATION.md` + `examples/`; regenerate with `npm run export:pack`.
Tranche vaults: `src/vaults/` — ERC-7540 Senior/Junior vaults (asset = hook share) + `TrancheAccountant` rules; `TranchePipeModule` handles USDC/equity exits and LLM-proposed, rail-validated rebalancing (75% equity hard cap).
Hardening (v3.1): bucket-exact JIT sizing from v4 amount-delta math (replacing the spot approximation, under EIP-170); deadline-enforced, `SafeERC20` rebalancing router; controller guardian pause + bounds validation; two-step oracle ownership with oracle-decimal scaling; locked-redemption accounting fix; invariant suite (`test/invariant/`); agent-side economic audit gate (`agent/model.mjs`) with LLM manager: paid verdict every 6h owns params/audit thresholds/rebalances, deterministic clamps and per-swap onchain gates enforce the rails.
Maturity (v3.2): one `EXPIRY_TIMESTAMP` per book (hook + both vaults). At expiry quoting/JIT and rebalancing stop, deposits close; permissionless settlement (`TranchePipeModule.settleSwap` / `finalizeSettlement`) converts equity to USDC only as needed, pays the senior guarantee first, hands the remainder (USDC + all equity) to junior, and freezes terminal per-share redemption rates — holders then burn srNVDA/jrNVDA via `redeemAtExpiry`.

## Architecture

![System architecture](docs/assets/system-architecture.svg)

Full component map, code pointers (file + line links), deployment topology and seven flow
walkthroughs: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Diagrams are authored in Mermaid
(`docs/diagrams/*.mmd`) and exported with `npm run diagrams:export`.

### Components

- **Price**: two variables — stock price pushed onchain from x402 purchases (USDC paid
  on Arc via Circle Gateway nanopayments) and the Uniswap v4 AMM price. See
  `docs/PRICE_SOURCES.md`. No Chainlink anywhere in the price path.
- **Execution**: full Uniswap v4 fork on Arc — core `PoolManager` + periphery
  (`PositionManager`, `PositionDescriptor`, `StateView`, `V4Quoter`, `ReservesLens`) +
  `TrancheJITHook` (multi-bucket JIT, `beforeSwap`/`afterSwap`, no custom-accounting
  return-delta flags). Hook deploy path proven with `SmokeHook`.
- **Lending**: forked Aave V2 deployed on Arc Testnet (no ETH/WETH; USDC-native gas).
- **Vaults**: Senior/Junior as ERC-7540 async vaults; hook strategy receipt as ERC-7575.
- **Agent**: role-based EOA calling a bounded `StrategyController` — an LLM strategy manager refreshes
  params/audit thresholds/rebalance proposals every 6h; deterministic code clamps them per tick and the
  hook checks profitability + hard gates on every swap. It can pause swaps and adjust distribution
  within caps, but can never withdraw funds to arbitrary addresses or mint/burn user shares.
- **Indexing**: The Graph subgraph on Arc Testnet for fast reads of prices, pool state
  and swaps (`docs/GRAPH.md`); RPC remains the trust layer.

## Tools

```shell
forge build                          # contracts
npm install                           # keeper tooling
node scripts/x402-price.mjs --probe   # inspect a live x402 stock-quote challenge
node scripts/x402-price.mjs --gateway --push   # pay on Arc + push price to oracle
node scripts/x402-seller.mjs          # local Gateway-accepting seller (demo)
npm run seed:nvda                     # USDC/NVDA pool status (--execute to seed)
npm run lending:status                # Aave semi-fork: prices, balances, liquidity index
npm run lending:seed                  # deposit 10 USDC + 1 NVDA into the lending pool
npm run hook:demo -- --status         # live TrancheJITHook demo (fees, toxic surge, Aave rest)
npm run agent:keygen                  # generate the local agent-operator key (testnet only)
npm run agent:tick                    # offchain agent dry-run (regime -> params, no tx)
npm run export:pack                   # regenerate ABIs + deployment manifest
npm run graph:query                   # query the deployed subgraph (needs GRAPH_URL)
cd subgraph && npm install && npm run build    # subgraph codegen + compile
```

## Setup

```shell
forge build
```

Environment: copy `.env.example` to `.env` and fill in secrets (never committed).

Before running anything onchain, set `USDC_ADDRESS`, `NVDA_ADDRESS` (18-dec NVDA token),
`NVDA_ORACLE`, and `NVDA_PEGGED_PRICE` (USD 8d); the pool knobs (`NVDA_POOL_FEE`,
`NVDA_POOL_TICK_SPACING`, `NVDA_POOL_PRICE`) derive the tick automatically. Then seed with
`npm run lending:seed` (10 USDC + 1 NVDA) and `npm run seed:nvda -- --execute`.

## Dependencies (pinned)

- `Uniswap/v4-core` — `59d3ecf53afa9264a16bba0e38f4c5d2231f80bc` (BUSL-1.1, change date 2027-06-15; testnet/dev use — see `LICENSES.md`)
- `Uniswap/v4-periphery` — commit `dce236d4e2057422d0791d9a973a58765eb46f65` (MIT)
- `OpenZeppelin/uniswap-hooks` — `2ae32be4906d300fc49b4384842ef6bc3e902d73` (MIT; hook base + fee modules)
- `OpenZeppelin/openzeppelin-community-contracts` — `92f252851c41449bd8417a6ebdcc8db95c8f66c9` (MIT; ERC-7540 base)
- `OpenZeppelin/openzeppelin-contracts` — `v5.7.0` (MIT)
- `foundry-rs/forge-std` (MIT)
- Build note: `via_ir = true`, global `optimizer_runs = 200`, `bytecode_hash = "none"` so the periphery fits under EIP-170.

## Docs

- `LICENSES.md` — dependency licenses
- `docs/CIRCLE.md` — Circle integration: Arc, Gateway/nanopayments, Agent Marketplace, wallets/paymaster
- `docs/PRICE_SOURCES.md` — x402 stock-price design, Circle Gateway rails, keeper commands
- `docs/HOOK.md` — `TrancheJITHook` modules, quote flow, TTL state machine, maturity, roles
- `docs/ACCOUNTANT.md` — tranche rules: claims, escrow, waterfalls, rebalancing, settlement
- `agent/README.md` — offchain agent daemon (regimes, run modes, GitHub heartbeat)
- `docs/AGENT_MARKET.md` — market model: pool registry, IL/fee math, LLM manager, audit gate
- `docs/LENDING.md` — Aave V2 semi-fork: pool/provider/configurator, USDC + NVDA markets, pegs, gaps
- `docs/GRAPH.md` — subgraph entities, queries, price conversion, fallbacks
- `docs/MCP.md` — The Graph subgraph MCP (cross-protocol analysis)
- `docs/DEPLOYMENTS.md` — live Arc Testnet addresses
- `docs/FRONTEND_INTEGRATION.md` — addresses/ABIs/flows for the frontend (`deployments/arc-testnet.json`, `docs/abis/`, `examples/`)

## Uniswap v4 integration

The canonical Uniswap v4 contracts are used unmodified (pinned submodules) and redeployed on Arc
testnet, because Arc has no canonical v4 deployment. The tranche hook is the integration point —
verifiable at the lines below.

| Piece | Source |
|---|---|
| Hook permissions (`beforeSwap` + `afterSwap`) | [`TrancheJITHook.sol:207`](src/hook/TrancheJITHook.sol#L207) |
| `beforeSwap` entry / quote gates | [`TrancheJITHook.sol:844`](src/hook/TrancheJITHook.sol#L844) / [`493`](src/hook/TrancheJITHook.sol#L493) |
| Dynamic fee (deviation × toxicity, EV floor) | [`TrancheJITHook.sol:768`](src/hook/TrancheJITHook.sol#L768) |
| JIT one-sided position | [`_jitBeforeSwap:500`](src/hook/TrancheJITHook.sol#L500) / [`_jitAfterSwap:555`](src/hook/TrancheJITHook.sol#L555) / [`_sizeJit:615`](src/hook/TrancheJITHook.sol#L615) |
| `afterSwap` entry | [`TrancheJITHook.sol:860`](src/hook/TrancheJITHook.sol#L860) |
| Pool init / active pool | [`340`](src/hook/TrancheJITHook.sol#L340) / [`347`](src/hook/TrancheJITHook.sol#L347) |
| Swap entry (`swapExactIn`) | [`DemoRouter.sol:59`](src/router/DemoRouter.sol#L59) |
| v4 deployment (`new PoolManager`) | [`DeployV4Stack.s.sol:40`](script/DeployV4Stack.s.sol#L40) |
| Live addresses | `docs/DEPLOYMENTS.md`, `deployments/arc-testnet.json` |

Developer feedback for the Uniswap team: [`FEEDBACK.md`](FEEDBACK.md).


## The Graph integration

The Graph is load-bearing, live, and in the decision path:

- **Subgraph (protocol indexing):** `tranch-stock` indexes the oracle, v4 pools, hook quotes/JIT,
  strategy submissions and tranche events. Live query URL in `deployments/arc-testnet.json`;
  entities and example queries in [`docs/GRAPH.md`](docs/GRAPH.md).
- **Graph gateway (agent decisions):** `agent/market.mjs` pulls 336h hourly + 30d daily pool data
  and computes volatility, fee capture, active TVL and the fee-vs-IL range sweep that drives
  quoting and rebalancing — [`docs/AGENT_MARKET.md`](docs/AGENT_MARKET.md).
- **Subgraph MCP (cross-protocol analysis):** the same Messari `vaults` query runs against our
  subgraph and any live yield subgraph — [`docs/MCP.md`](docs/MCP.md).
- **Verify live data:** `npm run graph:query` and `npm run market`.



## Integrations

- **Circle / Arc:** Circle Gateway nanopayments (oracle rail +
  paid agent reasoning), Modular Wallets/passkey + Paymaster frontend, Agent Marketplace discovery,
  Arc-native USDC accounting — [`docs/CIRCLE.md`](docs/CIRCLE.md).
- **Uniswap:** [`FEEDBACK.md`](FEEDBACK.md) — integration feedback.
- **The Graph:** Subgraphs + Subgraph MCP as the blockchain-data source (above).

## License

MIT — see [`LICENSE`](LICENSE); third-party scope (incl. the Uniswap v4 BUSL-1.1 testnet note) in
[`LICENSES.md`](LICENSES.md).
