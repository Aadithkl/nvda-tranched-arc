# Price Sources

Two price variables drive the protocol:

1. **Stock price** — NVDA/USD published onchain by the agent, which is the only authorized
   writer. The agent pushes a fresh quote automatically on load and on every tick when the
   onchain price is stale. There is no public, permissionless, or paid push path:
   `updatePrice` reverts `NotWriter` for every other address.
2. **AMM price** — the Uniswap v4 pool price for the mNVDA/USDC pool, read from
   `PoolManager.getSlot0` by the hook. The hook compares it against the stock price and
   blocks swaps that move the pool further away beyond the deviation threshold.

Chainlink is not used anywhere in the price path. **No external oracle provider (Pyth,
Chainlink, RedStone, …) is integrated**: the stock price is purchased from x402 sellers and
settled through Circle Gateway nanopayments, and the onchain price is indexed from Arc by
The Graph (`docs/GRAPH.md`).

## Oracle — `NVDAPriceOracle`

| Aspect | Design |
|---|---|
| Updater | `writers` role; `script/DeployOracle.s.sol` seeds the agent operator (`ORACLE_WRITER` / `AGENT_OPERATOR_ADDRESS`) as the only writer |
| Update | `updatePrice(int192 mid, uint32 marketStatus, uint32 sourceTimestamp, bytes32 paymentRef)` — reverts `NotWriter` for everyone else |
| Audit trail | every update emits `PriceUpdated` with the updater and `paymentRef` |
| Staleness | `maxStaleness` (default 300s); `getPrice().valid` requires fresh + market open |
| Market status | 24/5 US equities mapping: `1` pre / `3` post → Extended, `2` Regular, `4` Overnight, `0`/`5` invalid |
| Integrations | `latestRoundData()` + `decimals()` for Aave V2's `AaveOracle` (M2b) |
| Safety | `paused` flag; writer revocation; zero/negative prices and invalid status rejected |

## Automatic rail — `agent/price.mjs`

The agent calls the rail before every submitted tick (`agent/index.mjs`). Two prices exist and
are displayed separately in the UI (see below).

**Stock feed (oracle):**

1. reads `getPrice()`; if the price is fresh (<80% of `maxStaleness`) or the market is
   closed (US/Eastern session 5), it skips — no payment, no gas.
2. otherwise walks the seller list (`ORACLE_PRICE_SELLERS`, tried in order). Every paid
   call is x402; **Circle Gateway nanopayments** (`GatewayWalletBatched`) are preferred, and
   sellers without Gateway batching are paid with a **plain x402 exact** authorization
   (`@x402/fetch` + `ExactEvmScheme`, Base USDC by default) as the fallback rail. If one
   seller fails (upstream outage, payment issue), the next seller is tried.
3. an optional free last-resort URL (`ORACLE_PRICE_FALLBACK_URL`, empty by default) and a
   manual override (`ORACLE_PRICE_USD`) are available for offline runs.
4. derives the session from US/Eastern time and calls `updatePrice(...)` with the agent
   operator key (`ORACLE_WRITER_PRIVATE_KEY` / `AGENT_OPERATOR_PRIVATE_KEY`).

Run it standalone with `npm run oracle:refresh` (`--force` ignores freshness, `--dry`
fetches without pushing). The oracle rejects the call unless the sender is the whitelisted
writer, so only the agent can publish a price.

**Onchain price (The Graph, Base):** the frontend Price page reads the NVDAc pools on Base
from the agent registry (`agent/pools.json` — Uniswap v3, Aerodrome, Uniswap v4) through the
Graph gateway and derives the USD price from each pool's `sqrtPrice` and token decimals. This
is the outside market reference — never our own Arc v4 pool. It is shown in a separate card so
the real-world stock feed and the Base market price are never conflated; the engine's
deviation band is what ties them together.

## Env

`AGENT_ORACLE`, `ORACLE_OWNER`, `ORACLE_WRITER`, `ORACLE_WRITER_PRIVATE_KEY`,
`ORACLE_PRICE_PAYER_PRIVATE_KEY`, `AGENT_PRICE_PUSH`, `ORACLE_PRICE_SELLERS`,
`ORACLE_PRICE_FALLBACK_URL`, `ORACLE_PRICE_USD`,
`X402_MAX_STALENESS`, `GRAPH_API_KEY` (agent + Base market reads). The frontend uses
`VITE_GRAPH_API_KEY` / `VITE_GRAPH_GATEWAY`. See `.env.example`.

## Security notes

- Only the agent (the seeded writer) can publish a price; the onchain audit trail is the
  `PriceUpdated` event. The writer is revocable and the oracle can be paused.
- `valid` requires freshness and an open market; stale/closed data degrades to invalid
  and the protocol rests in lending (no JIT).
- No price is ever read from a test token in the production path. `TestToken` is test-only.
