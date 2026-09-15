# NVDA Tranched Platform — `nvda-tranched-arc`

Stablecoin-native RWA capital structuring on **Arc Testnet**: NVDA exposure split into
Senior (fixed 5% target) and Junior (leveraged) tranches, with capital resting in a
lending market and a defensive Uniswap v4 JIT hook executing only in `+EV`, market-open,
oracle-valid windows under an agent-operated strategy controller.

**Live:** https://aadithkl.github.io/nvda-tranched-arc/ · **Addresses:** `docs/DEPLOYMENTS.md` ·
**Interface pack:** `deployments/arc-testnet.json`, `docs/abis/`, `examples/`

### What's live

- **Price rail** — x402 stock quotes bought with USDC on Arc (Circle Gateway nanopayments) push the
  onchain NVDA/USD oracle; the v4 AMM price is the second, independent reference. No Chainlink.
- **Tranche book** — `TrancheJITHook` (dynamic fee, toxic-flow pricing, bucket-exact JIT, Aave rest)
  plus ERC-7540 Senior/Junior vaults, an ERC-7575 hook share and `TrancheAccountant` settlement;
  one `EXPIRY_TIMESTAMP` per book stops quoting and freezes terminal redemption rates.
- **Agent** — bounded `StrategyController` with a 6h paid LLM verdict, deterministic clamps and
  per-swap onchain gates; hosted heartbeat every 10 minutes.
- **Reads** — the `tranch-stock` subgraph indexes oracle, pools, hook quotes/JIT, strategy
  submissions and tranche events for the app and the agent.

## Quickstart

```shell
forge build && npm install
cp .env.example .env          # secrets + addresses (never committed)
npm run agent:tick            # dry-run one agent tick (no tx)
npm run lending:status        # Aave semi-fork state
npm run hook:demo -- --status # live TrancheJITHook state
npm run export:pack           # regenerate ABIs + deployment manifest
```

Full script list in `package.json`; pinned dependencies and build flags in
[`REQUIREMENTS.md`](REQUIREMENTS.md).

## Architecture

[![System architecture - click to open the interactive map](docs/archify/nvda-tranches.architecture.png)](https://aadithkl.github.io/nvda-tranched-arc/archify/nvda-tranches.architecture.html)

**Click the map to open the interactive version** - pan/zoom, search, focus, light/dark, and export.
Standalone copies: [system map](docs/archify/nvda-tranches.architecture.html) -
[deposit to JIT swap](docs/archify/nvda-deposit-jit.sequence.html) -
[hosted](https://aadithkl.github.io/nvda-tranched-arc/archify/). Code pointers and integration
notes: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Diagrams are generated with Archify from the
typed JSON sources in `docs/archify/`.

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

Developer feedback: [`FEEDBACK.md`](FEEDBACK.md).

## The Graph integration

- **Subgraph:** `tranch-stock` indexes the oracle, v4 pools, hook quotes/JIT, strategy submissions
  and tranche events — live at
  `https://api.studio.thegraph.com/query/1760210/tranch-stock/version/latest`
  (entities and queries in [`docs/GRAPH.md`](docs/GRAPH.md)).
- **Standardized schema:** implements the **Messari Yield Aggregator v1.3.1** schema (vendored at
  [`subgraph/schema-yield.graphql`](subgraph/schema-yield.graphql)) so identical queries run across
  protocols.
- **Agent decisions (Graph-only):** `agent/market.mjs` + `agent/model.mjs` compute volatility, fee
  capture and the fee-vs-IL sweep from the Graph gateway only; the registry
  [`agent/pools.json`](agent/pools.json) tracks 3 live Base subgraphs (Uniswap v3, Aerodrome
  Slipstream, Uniswap v4) — [`docs/AGENT_MARKET.md`](docs/AGENT_MARKET.md).
- **Cross-protocol MCP:** hosted Subgraph MCP at `https://subgraphs.mcp.thegraph.com/sse` —
  discovery across 15,000+ subgraphs, schema lookup and query execution; the demo runs the same
  Messari `vaults` query against this subgraph and **Yearn v2**
  (`FDLuaz69DbMADuBjJDEcLnTuPnjhZqNbFVrkNiBLGkEg`) — tools and setup in
  [`docs/MCP.md`](docs/MCP.md).
- **Verify:** `npm run graph:query` and `npm run market`.

## Arc & Circle integration

Arc is the execution and settlement chain — USDC is the native gas currency (18-dec native
balance, 6-dec ERC-20 interface) — and every paid call in the product settles through
**Circle Gateway batched settlement (nanopayments)**.

**Live v3 stack (Arc):** hook `0x5C374e0B4F3646705839BE9D2b45F6753EAC6aC0` · share
`0x9341fA835A44A225E7f36a245A149794239c221A` · pipe `0x04614f09DfC7D66B5072FB9B745C9B1b9503bA5e` ·
accountant `0x8c0FACD06b0bB540F82817ee5731eDA9D8E75Ce3` · senior `0x2b9Bc484b5De5ffd96e0aD37a05D0ff1B4380266` ·
junior `0xdBEAaAc8281459510E871aBdE4bf88C8AC530F8a` — full tables in
[`docs/DEPLOYMENTS.md`](docs/DEPLOYMENTS.md).

**JIT exercised on Arc:** 23 hook swaps → 23 JIT episodes (all returned to rest), **$42.91 gross
volume, $3.06 fees captured** (13 toxic surge quotes up to 29.5%); hook managed assets grew
35.00 → 51.74 USDC. **Circle verified:** passkey + paymaster live on the hosted app, Agent
Marketplace discovery working, and a nanopayment run settled end-to-end (BlockRun, $0.003/call via
Gateway — verdict `reduce` @ 0.7, bucket 488, max deploy $9,600).

| Piece | Source |
|---|---|
| Oracle rail — x402 quote bought with USDC (Gateway preferred, plain x402 fallback), pushed onchain | [`price.mjs:144`](agent/price.mjs#L144) / [`167`](agent/price.mjs#L167) |
| Paid LLM verdict (every 6h) settled from the payer key | [`refresh.mjs:62`](agent/refresh.mjs#L62) |
| Agent Marketplace discovery + per-call nanopayment | [`agent-market.mjs:50`](scripts/agent-market.mjs#L50) / [`177`](scripts/agent-market.mjs#L177) |
| Passkey smart account + gasless userOps (`paymaster: true`) | [`wallet.ts:124`](frontend/src/wallet.ts#L124) |
| Modular transport (Circle client key, Arc testnet) | [`config.ts:108`](frontend/src/config.ts#L108) |
| Tranche stack + lending fork deployed on Arc | [`DeployTrancheHookV3.s.sol:27`](script/DeployTrancheHookV3.s.sol#L27) / [`DeployLending.s.sol:12`](script/DeployLending.s.sol#L12) |
| Rail policy, CLI setup, passkey troubleshooting | [`docs/CIRCLE.md`](docs/CIRCLE.md) |

## Hosting (GitHub Actions)

- **Frontend:** every push to `main` builds `frontend/` and deploys to GitHub Pages —
  [`.github/workflows/pages.yml`](.github/workflows/pages.yml).
- **Agent heartbeat:** cron every 10 minutes runs one tick (`--submit` when the regime changes or
  the params TTL lapses) and refreshes the paid LLM verdict every 6h —
  [`.github/workflows/agent-heartbeat.yml`](.github/workflows/agent-heartbeat.yml).

## Docs

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — code map + flows ·
[`docs/HOOK.md`](docs/HOOK.md) — hook modules, quote flow, TTL, maturity ·
[`docs/ACCOUNTANT.md`](docs/ACCOUNTANT.md) — claims, waterfalls, settlement ·
[`docs/LENDING.md`](docs/LENDING.md) — Aave semi-fork ·
[`docs/PRICE_SOURCES.md`](docs/PRICE_SOURCES.md) — oracle design ·
[`docs/CIRCLE.md`](docs/CIRCLE.md) — Circle/Gateway integration ·
[`docs/FRONTEND_INTEGRATION.md`](docs/FRONTEND_INTEGRATION.md) — app wiring ·
[`agent/README.md`](agent/README.md) — agent daemon.

## License

MIT — see [`LICENSE`](LICENSE); third-party scope (incl. the Uniswap v4 BUSL-1.1 testnet note) in
[`LICENSES.md`](LICENSES.md).
