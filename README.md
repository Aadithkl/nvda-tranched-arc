# NVDA Tranched Platform — `nvda-tranched-arc`

Stablecoin-native RWA capital structuring on **Arc Testnet**: NVDA exposure split into
Senior (fixed 5% target) and Junior (leveraged) tranches, with capital resting in a
lending market and a defensive Uniswap v4 JIT hook executing only in `+EV`, market-open,
oracle-valid windows under an agent-operated strategy controller.

## Status

| Milestone | Scope | State |
|---|---|---|
| M0 | Env, repo, Foundry, deps, license audit | done |
| M1 | Chainlink Data Streams NVDA oracle + x402 price path + updater | oracle + tests done; live fixture pending Data Streams key |
| M2a | Uniswap v4 fork (PoolManager + router) on Arc Testnet | done — live demo pool + swap |
| M2b | Aave V2 fork (USDC + EURC + mNVDA reserves) on Arc Testnet | pending |
| M3 | `TrancheJITHook` (DualPool-style multi-bucket JIT + gates) | pending |
| M4 | `StrategyController` + agent daemon + CRE safety stub | pending |
| M5 | ERC-7540 Senior/Junior vaults + ERC-7575 hook share | pending |
| M6 | E2E on Arc Testnet, security pass, docs/ABIs | pending |

Indexing: The Graph subgraph scaffolded and building (`subgraph/`, `arc-testnet`) for oracle + pool values; deploy pending a Graph Studio key.
x402 on Arc: Circle Gateway rail verified end-to-end (pay $0.001 on Arc → NVDA quote → onchain oracle update, tx `0xb2ce…443bf`).

## Architecture (target)

- **Price**: two variables — stock price (Chainlink Data Streams testnet NVDA, V11,
  verified via the Arc Testnet `VerifierProxy`, plus an x402 keeper push paid through
  Circle Gateway nanopayments on Arc) and the Uniswap v4 AMM price. See `docs/PRICE_SOURCES.md`.
- **Execution**: forked Uniswap v4 `PoolManager` + `TrancheJITHook` (multi-bucket JIT,
  `beforeSwap`/`afterSwap`, no custom-accounting return-delta flags).
- **Lending**: forked Aave V2 deployed on Arc Testnet (no ETH/WETH; USDC-native gas).
- **Vaults**: Senior/Junior as ERC-7540 async vaults; hook strategy receipt as ERC-7575.
- **Agent**: role-based EOA calling a bounded `StrategyController` — can reallocate
  between venues, pause swaps and adjust distribution within caps; can never withdraw
  funds to arbitrary addresses or mint/burn user shares.
- **Indexing**: The Graph subgraph on Arc Testnet for fast reads of prices, pool state
  and swaps (`docs/GRAPH.md`); RPC remains the trust layer.

## Tools

```shell
forge build && forge test             # contracts
npm install                           # keeper tooling
node scripts/x402-price.mjs --probe   # inspect a live x402 stock-quote challenge
node scripts/x402-price.mjs --gateway --push   # pay on Arc + push price to oracle
node scripts/x402-seller.mjs          # local Gateway-accepting seller (demo)
node scripts/fetch-report.mjs         # Chainlink Data Streams fixtures (needs API key)
npm run graph:query                   # query the deployed subgraph (needs GRAPH_URL)
cd subgraph && npm install && npm run build    # subgraph codegen + compile
```

## Setup

Foundry (this machine): `C:\Users\klaad\.foundry\bin` (v1.8.1), git: `C:\Users\klaad\tools\PortableGit`.

```shell
forge build
forge test
```

Environment: copy `.env.example` to `.env` and fill in secrets (never committed).

## Dependencies (pinned)

- `Uniswap/v4-core` — `v4.0.0` (BUSL-1.1, change date 2027-06-15; testnet/dev use — see `LICENSES.md`)
- `Uniswap/v4-periphery` — commit `dce236d4e2057422d0791d9a973a58765eb46f65` (MIT)
- `OpenZeppelin/openzeppelin-contracts` — `v5.7.0` (MIT)
- `foundry-rs/forge-std` (MIT)

## Docs

- `LICENSES.md` — dependency license audit
- `docs/PRICE_SOURCES.md` — Chainlink Data Streams + x402 dual-source design, keeper commands, payment rails
- `docs/GRAPH.md` — subgraph entities, queries, price conversion, fallbacks
- `docs/DEPLOYMENTS.md` — live Arc Testnet addresses
- `docs/` — architecture, security, agent, frontend pack (added through M3–M6)
