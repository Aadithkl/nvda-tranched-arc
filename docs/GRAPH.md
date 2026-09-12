# The Graph — Indexed Values & Prices

The subgraph in `subgraph/` indexes the protocol on **Arc Testnet** and provides fast
read access to:

- latest NVDA stock price pushed over x402, with market session and status
- every price update with its onchain payment reference (payment audit trail)
- v4 pool state (`sqrtPriceX96`, `tick`, `liquidity`) and every swap
- hook quote + JIT activity (`SwapQuoted`, `JitDeployed/Removed`, claims, share flows)
- agent actions (`ParamsSubmitted`, `BaseFeeSubmitted`, `QuotingSubmitted`)
- tranche flows and accountant reports (deposits, redemptions, rebalances)

**Philosophy:** the subgraph is a *speed layer* for the frontend/agent. Security-sensitive
reads (swaps, redemptions, hook gates) use direct RPC through the contracts; the
subgraph is never the trust layer.

## Deployment credential

| Purpose | Credential | Notes |
|---|---|---|
| Deploy | **Subgraph Studio deploy key** | `thegraph.com/studio` → connect wallet → create `nvda-tranched-arc` → Settings → deploy key. `graph auth <key>` then `npm run deploy:studio` from `subgraph/` |
| Query (dev) | none (keyless Studio URL, rate-limited) | `https://api.studio.thegraph.com/query/<id>/nvda-tranched-arc/<version>` |
| Query (prod) | **Graph API key** (Studio → API Keys) | `https://gateway.thegraph.com/api/<key>/subgraphs/id/<deployment-id>` |
| Query (keyless, paid) | none — per-query USDC via x402 gateway | matches this project's payment rail |

**Arc network ids:** `arc-testnet` (chain 5042002) and `arc` (chain 5042) are in The
Graph networks registry with the `subgraphs` service.

**Not a deploy credential:** Substreams/StreamingFast API tokens (dfuse-issued JWTs) do
not deploy or query subgraphs, and Arc has no public Substreams/Firehose endpoint today.
Use them only for chains with a StreamingFast/Pinax endpoint.

**Deploy note (graph-cli ≥ 0.98):** the `--studio` flag was removed; Studio deploys use
`graph deploy <slug> --node https://api.studio.thegraph.com/deploy/ --deploy-key <key> --version-label <v>`.
The slug must exist in Studio first (create it in the browser, wallet-connected).

## Standardized schema (Messari Yield Aggregator v1.3.1)

The subgraph implements the Messari Yield Aggregator schema (vendored at
`subgraph/schema-yield.graphql`) so the same queries run across protocols:

| Messari entity | Populated from |
|---|---|
| `YieldAggregator` (Protocol) | protocol bootstrap (`nvda-tranched-arc`) |
| `Token` | USDC (input) + tjSHARE (output) |
| `Vault` | the hook share pipe (wrap/unwrap = deposit/withdraw) |
| `Deposit` / `Withdraw` | `SharesWrapped` / `SharesUnwrapped` |
| `VaultDailySnapshot` / `VaultHourlySnapshot` | upserted on each share flow |
| `UsageMetricsDailySnapshot` / `UsageMetricsHourlySnapshot` | block handler (decimated) |
| `FinancialsDailySnapshot` | block handler (decimated) |
| `Account` / `ActiveAccount` | unique depositors/withdrawers |

Extensions kept on top (allowed by the standard): `HookState`, `Quote`, `JitDeployment`,
`JitRemoval`, `ClaimRedemption`, `ShareFlow`, `ParamChange`, `AgentAction`, `VaultState`,
`VaultFlow`, `AccountantReport`, `Rebalance`, `RedemptionFulfilment`, plus the oracle and
v4 pool entities. The only enum extension is `Network.ARC_TESTNET`.

Example cross-protocol query (identical against our subgraph and e.g. Yearn v2):

```graphql
{
  vaults(first: 5, orderBy: totalValueLockedUSD, orderDirection: desc) {
    id
    name
    symbol
    inputToken { symbol }
    outputToken { symbol }
    totalValueLockedUSD
    cumulativeTotalRevenueUSD
    inputTokenBalance
    outputTokenSupply
    pricePerShare
  }
}
```

## Data sources

| Source | Address | Status |
|---|---|---|
| `NVDAPriceOracle` | `0x2D58…738A` | live |
| `PoolManager` | `0xFc41…Ae67` | live |
| `TrancheJITHook` | `0xceb3…ac0` (demo) | update on JIT redeploy |
| `StrategyController` | `0x6ea1…edD` | update on redeploy |
| `StrategyAgent` | `0x636b…E8c` | update on redeploy |
| `SeniorVault` / `JuniorVault` | placeholder `0x0` | set at vault deploy |
| `TrancheAccountant` | placeholder `0x0` | set at accountant deploy |

## Entities

| Entity | What it holds |
|---|---|
| `OracleState` (`id: "global"`) | latest `mid`/`bid`/`ask`, `marketStatus`, `lastSourceTimestamp`, `lastUpdatedAt`, `lastWriter`, `lastPaymentRef`, `totalUpdates` |
| `PriceUpdate` | one row per x402 push: values, session, writer, paymentRef, tx |
| `Pool` | pool key, current `sqrtPriceX96` / `tick` / `liquidity`, volume, swap count |
| `PoolSwap` | per-swap amounts, price after swap, fee, sender, tx |
| `HookState` (one per hook) | params snapshot (base/surge fee, deviation band, TTL, bucket ticks), flags (`quotingEnabled`, `jitEnabled`, `liquidityGuard`, `paused`), wiring, totals (`totalQuotes`, `totalJitDeployments`, wraps/unwraps, Aave flows) |
| `Quote` | per-quote `deviationBps`, `fee`, `toxic`, TTL state, tx |
| `JitDeployment` / `JitRemoval` | JIT range (`tickLower`/`tickUpper`), `liquidity`, seed, claim deltas, tx |
| `ClaimRedemption` | ERC-6909 claim redemption per asset |
| `ShareFlow` | wrap/unwrap/supply/withdraw/seed rows with USDC + share amounts |
| `ParamChange` | hook-level params/base-fee/quoting changes |
| `AgentAction` | controller/agent submissions with full params snapshot |
| `VaultState` / `VaultFlow` | per-vault deposit/unwrap/move aggregates + rows |
| `AccountantReport` | `DepositReported` / `RedeemReported` rows |
| `Rebalance` | escrow rebalancing moves |
| `RedemptionFulfilment` | senior/junior keeper redemptions |

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

Hook state + fee/toxicity history (agent perception input):

```graphql
{
  hookStates {
    baseFee
    maxSurgeFee
    maxDeviationBps
    quotingEnabled
    jitEnabled
    activePoolId
    totalQuotes
    totalJitDeployments
    totalWraps
    totalUnwraps
  }
  quotes(first: 20, orderBy: timestamp, orderDirection: desc) {
    fee
    deviationBps
    toxic
    state
    zeroForOne
    timestamp
  }
}
```

JIT fee yield + agent actions:

```graphql
{
  jitDeployments(first: 20, orderBy: timestamp, orderDirection: desc) {
    liquidity
    seed
    zeroForOne
    tickLower
    tickUpper
    timestamp
  }
  jitRemovals(first: 20, orderBy: timestamp, orderDirection: desc) {
    liquidity
    claim0
    claim1
    timestamp
  }
  agentActions(first: 20, orderBy: timestamp, orderDirection: desc) {
    agent
    source
    kind
    baseFee
    maxDeviationBps
    timestamp
  }
}
```

Tranche activity:

```graphql
{
  vaultStates {
    id
    isSenior
    totalDepositUsdc
    totalUnwrapUsdc
    depositCount
    unwrapCount
  }
  accountantReports(first: 20, orderBy: timestamp, orderDirection: desc) {
    kind
    senior
    hookShares
    usdcValue
    timestamp
  }
  redemptionFulfilments(first: 10, orderBy: timestamp, orderDirection: desc) {
    senior
    user
    shares
    assets
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
