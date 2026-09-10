# Price Sources

Two price variables drive the protocol:

1. **Stock price** — Chainlink Data Streams testnet NVDA (verified onchain), or an
   x402-purchased stock quote pushed onchain by the keeper (writer role).
2. **AMM price** — the Uniswap v4 pool price for the mNVDA/USDC pool, read from
   `PoolManager.getSlot0` by the hook (M3). The hook compares the two and blocks
   swaps that push the pool further away from the stock price beyond the deviation
   threshold.

Both live in `NVDAPriceOracle` with source selection:

- `getPrice()` returns the configured `primarySource` when fresh, otherwise the
  fallback source.
- `getPriceFrom(Source.ChainlinkStreams | Source.X402)` reads a specific source.
- `valid` requires: price > 0, market open (`marketStatus` 1–4), and freshness within
  the per-source max staleness (Chainlink: per-session; x402: `x402MaxStaleness`).

## Source A — Chainlink Data Streams (verified, session-aware)

| Item | Value |
|---|---|
| Testnet API | `https://api.testnet-dataengine.chain.link` |
| Arc Testnet VerifierProxy | `0x72790f9eB82db492a7DDb6d2af22A270Dcc3Db64` |
| Schema | RWA Advanced v11 (`mid`, `bid`, `ask`, `marketStatus`, `lastSeenTimestampNs`) |
| NVDA Regular | `0x000b1d444945231e44dd47736c6abe288b10cb1b53941c7c68012fbdd2b1755c` |
| NVDA Extended | `0x000bf689e4aa5c006c89c207eb155ae99184e433a518753eb745cc552391a743` |
| NVDA Overnight | `0x000b99b86a91cc317e2db8370f1466844dd9460cb51c3bf12fcc8d19d53d97bb` |

- 24/5 session mapping: `1` pre-market / `3` post-market → Extended; `2` → Regular;
  `4` → Overnight; `0`/`5` → invalid.
- `PriceUpdater` (Automation-compatible) submits verified reports.
- `scripts/fetch-report.mjs` fetches signed reports (requires `CHAINLINK_DATASTREAMS_KEY`
  and `CHAINLINK_DATASTREAMS_SECRET` from app.chain.link) into `test/fixtures/` for the
  fork tests.

## Source B — x402-purchased stock quote (keeper-pushed)

`scripts/x402-price.mjs` pays a stock-quote API per call over x402, then pushes the
price onchain via `updateX402Price(mid, marketStatus, sourceTimestamp, paymentRef)`.

- Push access: `writers` mapping (owner-managed); the writer is the keeper/agent.
- `paymentRef` is a hash of the x402 payment receipt, giving an onchain audit trail
  for every price update.
- `marketStatus` is derived from US/Eastern session time (pre/regular/post/overnight/
  closed) by the keeper.

### Commands

```bash
node scripts/x402-price.mjs --probe            # show the 402 challenge (no payment)
node scripts/x402-price.mjs --save             # pay, print price, save fixture
node scripts/x402-price.mjs --push             # pay and push to ORACLE_ADDRESS
node scripts/x402-price.mjs --gateway --push   # Circle Gateway payment on Arc, then push
node scripts/x402-price.mjs --gateway-deposit 1  # fund Gateway (Arc testnet, gas-free)
node scripts/x402-price.mjs --gateway-balances   # wallet + Gateway balances
node scripts/x402-seller.mjs                   # local Gateway-accepting seller (demo)
```

### Payment rails

- **Primary (Arc Testnet): Circle Gateway nanopayments** via `@circle-fin/x402-batching`
  (`chain: "arcTestnet"`, gas-free, ~0.5s deposits). Enable with `--gateway` or
  `X402_USE_GATEWAY=1`; the client automatically falls back to standard x402 if the
  seller does not advertise the Gateway batching scheme.
- **Fallback (external providers): standard x402 on their accepted mainnet chains.**
  Probed 2026-09-10: agent402, x402stock, and klymax402 accept Base, Polygon, Arbitrum,
  Robinhood Chain, Celo, Avalanche (plus non-EVM) — no Arc, no testnets. Set
  `X402_PREFERRED_NETWORK` (default `eip155:8453`) and fund `X402_PAYER_PRIVATE_KEY`
  on one of those chains.
- Keeper flow (`--gateway`): pay on Arc → parse price from the 200 response → push
  `updateX402Price(mid, marketStatus, sourceTimestamp, paymentRef)` on Arc.

**Verified end-to-end on Arc Testnet (2026-09-10):** local Gateway-accepting seller
(`scripts/x402-seller.mjs`) → keeper paid $0.001 from Arc Gateway balance → NVDA quote
returned → oracle updated in tx
`0xb2ce0293f856a4dd1d2aef22bf9d526fe5af360a12cb120233aeca2b947443bf`. Gateway balance
0.998 → 0.997; oracle `getPriceFrom(X402)` returned `valid = true` at 218.36.

### Circle Gateway gotchas (Arc Testnet)

- **Facilitator URL defaults to mainnet.** `BatchFacilitatorClient` / seller middleware
  default to `https://gateway-api.circle.com`; for Arc Testnet pass
  `https://gateway-api-testnet.circle.com` (env `GATEWAY_FACILITATOR_URL`). The buyer
  `GatewayClient` auto-selects the testnet API for `chain: "arcTestnet"`.
- **Self-transfer is rejected** (`INVALID (self_transfer)`): the seller `payTo` address
  must differ from the payer wallet. Generated demo seller:
  `0x25E7D4287eCDCFA04BF59aBEd594e51dc3DabaF3`.
- **Amounts are atomic (6 decimals):** `$0.001 = "1000"`, `$0.01 = "10000"`.
- **Deposit first:** buyers must deposit USDC into Gateway before paying
  (`--gateway-deposit 1`); raw wallet balance cannot sign Gateway authorizations.
- Gateway contracts (Arc Testnet): wallet `0x0077777d7EBA4688BDeF3E311b846F25870A19B9`,
  minter `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B`, domain `26`.

### Indexed values (The Graph)

The Graph subgraph (`subgraph/`, network `arc-testnet`) indexes `NVDAPriceOracle`
events and PoolManager swaps so the frontend/agent can read latest stock price, price
history, pool state, and swaps without RPC scans. See `docs/GRAPH.md`. The subgraph is
a speed layer; RPC reads remain the trust layer for any transaction-gating logic.

### Env

See `.env.example`: `X402_STOCK_URL`, `X402_PAYER_PRIVATE_KEY`,
`X402_PREFERRED_NETWORK`, `X402_MAX_PAYMENT_USDC`, `X402_WRITER`, `ORACLE_ADDRESS`,
`PRIMARY_SOURCE` (1 = Chainlink, 2 = x402), `X402_MAX_STALENESS`.

## Security notes

- x402 updates are writer-attested (no cryptographic proof of the quote onchain);
  the onchain audit trail is the `paymentRef` + event log. The Chainlink path remains
  cryptographically verified via the DON signature.
- Staleness and market-status checks always apply on read (`valid`), regardless of
  source. A stale or closed market degrades to "invalid" and the protocol rests in
  lending (no JIT).
- No price is ever read from a mock in the production path. `MockVerifierProxy` is
  test-only for unit tests; integration tests verify real Chainlink reports against
  the live Arc Testnet VerifierProxy.
