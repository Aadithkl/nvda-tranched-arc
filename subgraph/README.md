# Tranch-Stock subgraph (`tranch-stock`)

Indexes the protocol on **Arc Testnet** (`arc-testnet`, chainId 5042002):

- `NVDAPriceOracle` — x402 price pushes (`PriceUpdated`) and market status changes
- `PoolManager` — `Initialize`, `Swap` (Uniswap v4 fork)

Entities: `OracleState` (latest values, singleton), `PriceUpdate` (one row per x402
push with its payment reference), `Pool`, `PoolSwap`.

## Build

```bash
npm install
npm run codegen
npm run build
```

## Deploy (Graph Studio)

1. Studio subgraph: **Tranch-Stock** (slug `tranch-stock`).
2. Deploy (graph-cli ≥ 0.98 removed `--studio`):
   `npx graph deploy tranch-stock --node https://api.studio.thegraph.com/deploy/ --deploy-key $GRAPH_DEPLOY_KEY --version-label v0.1.0`
   (`npm run deploy:studio` is the same command; append `--deploy-key <key>`).
3. Addresses are generated, not hand-edited: `npm run subgraph:sync` (from the repo root) rewrites
   `subgraph.yaml` / `networks.json` from `deployments/arc-testnet.json`.

The deploy key stays local (env/CLI), never committed. Query URL after deploy:
`https://api.studio.thegraph.com/query/<id>/tranch-stock/<version>`
