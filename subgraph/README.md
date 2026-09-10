# nvda-tranched subgraph

Indexes the protocol on **Arc Testnet** (`arc-testnet`, chainId 5042002):

- `NVDAPriceOracle` — `PriceUpdated` (Chainlink Data Streams), `X402PriceUpdated`,
  `MarketStatusUpdated`, `PrimarySourceUpdated`
- `PoolManager` — `Initialize`, `Swap` (Uniswap v4 fork)

Entities: `OracleState` (latest values, singleton), `PriceUpdate`, `Pool`, `PoolSwap`.

## Build

```bash
npm install
npm run codegen
npm run build
```

## Deploy (Graph Studio)

1. Create the subgraph in Graph Studio named `nvda-tranched-arc`.
2. Authenticate: `npx graph auth --studio <DEPLOY_KEY>`
3. `npm run deploy:studio`

The deploy key stays local (env/CLI), never committed. Query URL after deploy:
`https://api.studio.thegraph.com/query/<id>/nvda-tranched-arc/<version>`

Addresses and start blocks live in `subgraph.yaml` and `networks.json`; update both on
redeploy (`docs/DEPLOYMENTS.md` is the source of truth).
