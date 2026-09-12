# Price Sources

Two price variables drive the protocol:

1. **Stock price** — NVDA/USD purchased per call over x402 (USDC paid on Arc through
   Circle Gateway nanopayments) and pushed onchain by the keeper.
2. **AMM price** — the Uniswap v4 pool price for the mNVDA/USDC pool, read from
   `PoolManager.getSlot0` by the hook (M3). The hook compares it against the stock
   price and blocks swaps that move the pool further away beyond the deviation
   threshold.

Chainlink is not used anywhere in the price path. Onchain values, price history and
pool state are indexed with The Graph (`docs/GRAPH.md`).

## Oracle — `NVDAPriceOracle` (x402 push)

| Aspect | Design |
|---|---|
| Updater | `writers` role (keeper/agent), owner-managed |
| Update | `updatePrice(int192 mid, uint32 marketStatus, uint32 sourceTimestamp, bytes32 paymentRef)` |
| Audit trail | every update emits `PriceUpdated` with the x402 `paymentRef` (hash of the payment receipt) |
| Staleness | `maxStaleness` (default 300s); `getPrice().valid` requires fresh + market open |
| Market status | 24/5 US equities mapping: `1` pre / `3` post → Extended, `2` Regular, `4` Overnight, `0`/`5` invalid |
| Integrations | `latestRoundData()` + `decimals()` for Aave V2's `AaveOracle` (M2b) |
| Safety | `paused` flag; writer revocation; zero/negative prices and invalid status rejected |

## Keeper — `scripts/x402-price.mjs`

```bash
node scripts/x402-price.mjs --probe            # show the 402 challenge (no payment)
node scripts/x402-price.mjs --save             # pay, print price, save fixture
node scripts/x402-price.mjs --push             # pay and push to ORACLE_ADDRESS
node scripts/x402-price.mjs --gateway --push   # Circle Gateway payment on Arc, then push
node scripts/x402-price.mjs --gateway-deposit 1  # fund Gateway (Arc testnet)
node scripts/x402-price.mjs --gateway-balances   # wallet + Gateway balances
node scripts/x402-seller.mjs                   # local Gateway-accepting seller (demo)
```

Flow (`--gateway`): pay $0.001 on Arc via Gateway → seller returns the NVDA quote →
keeper derives the market session from US/Eastern time → `updatePrice(...)` on Arc.

### Verified end-to-end on Arc Testnet

Local seller (`scripts/x402-seller.mjs`) → Gateway payment settled → live NVDA quote →
onchain oracle update → `getPrice()` returns `valid = true`. See `docs/DEPLOYMENTS.md`
for the latest transaction.

### Circle Gateway gotchas

- **Facilitator URL defaults to mainnet.** Seller middleware / `BatchFacilitatorClient`
  must pass `https://gateway-api-testnet.circle.com` for Arc Testnet
  (`GATEWAY_FACILITATOR_URL`). The buyer `GatewayClient` auto-selects the testnet API
  for `chain: "arcTestnet"`.
- **Self-transfer rejected** (`INVALID (self_transfer)`): the seller `payTo` must differ
  from the payer wallet.
- **Atomic units (6 decimals):** `$0.001 = "1000"`, `$0.01 = "10000"`.
- **Deposit first:** buyers deposit USDC into Gateway (`--gateway-deposit 1`) before
  paying; raw wallet balance cannot sign Gateway authorizations.
- Gateway contracts (Arc Testnet): wallet `0x0077777d7EBA4688BDeF3E311b846F25870A19B9`,
  minter `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B`, domain `26`.

### External providers (fallback)

Public x402 stock providers (agent402, x402stock, klymax402) accept mainnet chains only
(Base, Polygon, Arbitrum, etc.) and do not advertise Circle Gateway yet; they remain a
fallback path via standard x402 (`X402_PREFERRED_NETWORK`, `X402_MAX_PAYMENT_USDC` cap).

## Env

`X402_STOCK_URL`, `X402_PAYER_PRIVATE_KEY`, `X402_USE_GATEWAY`,
`X402_PREFERRED_NETWORK`, `X402_MAX_PAYMENT_USDC`, `X402_WRITER`, `ORACLE_ADDRESS`,
`X402_MAX_STALENESS`, plus seller vars and `GATEWAY_*`. See `.env.example`.

## Security notes

- x402 updates are writer-attested; the onchain audit trail is `paymentRef` + the
  `PriceUpdated` event. Writers are revocable and the oracle can be paused.
- `valid` requires freshness and an open market; stale/closed data degrades to invalid
  and the protocol rests in lending (no JIT).
- No price is ever read from a test token in the production path. `TestToken` is test-only.
