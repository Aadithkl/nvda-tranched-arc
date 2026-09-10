# The Graph — Indexed Values & Prices

The subgraph in `subgraph/` indexes the protocol on **Arc Testnet** and provides fast
read access to:

- latest NVDA stock price pushed over x402, with market session and status
- every price update with its onchain payment reference (payment audit trail)
- v4 pool state (`sqrtPriceX96`, `tick`, `liquidity`) and every swap

**Philosophy:** the subgraph is a *speed layer* for the frontend/agent. Security-sensitive
reads (swaps, redemptions, hook gates) use direct RPC through the contracts; the
subgraph is never the trust layer.

## Entities

| Entity | What it holds |
|---|---|
| `OracleState` (`id: "global"`) | latest `mid`/`bid`/`ask`, `marketStatus`, `lastSourceTimestamp`, `lastUpdatedAt`, `lastWriter`, `lastPaymentRef`, `totalUpdates` |
| `PriceUpdate` | one row per x402 push: values, session, writer, paymentRef, tx |
| `Pool` | pool key, current `sqrtPriceX96` / `tick` / `liquidity`, volume, swap count |
| `PoolSwap` | per-swap amounts, price after swap, fee, sender, tx |

## Example queries

Latest stock price state:

```graphql
{
  oracleState(id: "global") {
    marketStatus
    lastMid
    lastBid
    lastAsk
    lastSourceTimestamp
    lastUpdatedAt
    lastWriter
    lastPaymentRef
    totalUpdates
  }
}
```

Recent x402 price updates (with payment refs):

```graphql
{
  priceUpdates(first: 10, orderBy: timestamp, orderDirection: desc) {
    mid
    session
    marketStatus
    paymentRef
    writer
    transactionHash
    timestamp
  }
}
```

Pool state + recent swaps:

```graphql
{
  pools {
    id
    sqrtPriceX96
    tick
    liquidity
    volume0
    volume1
    swapCount
  }
  poolSwaps(first: 10, orderBy: timestamp, orderDirection: desc) {
    pool { id }
    amount0
    amount1
    tick
    sqrtPriceX96
    timestamp
  }
}
```

## Price conversion

- Oracle `mid` uses 8 decimals (e.g. `218.36e8`).
- Pool price: `price = 1.0001^tick`, then adjust for token decimals (mNVDA 18d,
  mUSDC 6d). Deviation between the two variables is computed client-side from
  `OracleState.lastMid` and `Pool.tick`.

## Query from the CLI

```bash
GRAPH_URL="https://api.studio.thegraph.com/query/<id>/nvda-tranched-arc/<version>" \
GRAPH_API_KEY=<optional-studio-key> \
node scripts/graph-query.mjs
```

Or pass a query file: `node scripts/graph-query.mjs path/to/query.graphql`.

## Keyless / x402-paid alternative

The Graph can also be queried through x402-paid gateways (for example PayQL), which
matches this project's payment rail: the payment *is* the auth, no API key needed.

## Fallback behavior (for the frontend)

1. Subgraph (fast, indexed)
2. Direct RPC reads (`NVDAPriceOracle.getPrice()`, `PoolManager.getSlot0`)
3. Never gate a transaction on subgraph data alone
