# Robinhood testnet bring-up (chain 46630)

Target: deploy the static-fee book on Robinhood Chain Testnet and exercise it
through `frontend/` (no build step: `npm run frontend` → http://127.0.0.1:5173).

## 0. Network facts (verified 2026-10-14)

| | |
|---|---|
| Chain ID | **46630** (`0xB616`) — not 46646 (wrong, breaks signatures) |
| RPC (verified working) | `https://rpc.testnet.chain.robinhood.com` |
| RPC alt (faucet docs) | `https://rpc.testnet.chain.robinhood.com/rpc` |
| RPC alt (chainlist) | `https://robinhood-sepolia-rpc.publicnode.com` |
| Explorer | `https://explorer.testnet.chain.robinhood.com` |
| Gas token | ETH |
| Faucet | `https://faucet.testnet.chain.robinhood.com/` — 0.01 testnet ETH + 5 of each stock token per wallet / 24h |

No Uniswap v4 exists on 46630, and Morpho is mainnet-only: the testnet flow
self-deploys v4 (`DeployV4Stack`), mock quote/equity (`mUSDC` 6-dec / `mNVDA`
18-dec), a writer-owned `NVDAPriceOracle`, then the static stack. Lending uses
the in-repo Aave semi-fork, not Morpho.

## 1. Fund the deployer

The deploy in §3 needs testnet ETH for gas. Claim the faucet to
`DEPLOYER_ADDRESS`, then confirm:

```powershell
$addr = ((Get-Content .env | Where-Object { $_ -match '^DEPLOYER_ADDRESS=' }) -split '=', 2)[1].Trim()
cast balance $addr --rpc-url https://rpc.testnet.chain.robinhood.com
```

`DeployV4Stack` + `DeployStaticStack` are heavy (PoolManager, periphery,
22KB vault). If one faucet drip (0.01 ETH) doesn't cover both, wait 24h or
split across two funded keys. Set in `.env` (never commit it):

```sh
ROBINHOOD_TESTNET_RPC_URL=https://rpc.testnet.chain.robinhood.com
DEPLOYER_ADDRESS=0x…
DEPLOYER_PRIVATE_KEY=0x…
```

## 2. Deploy v4 + mocks

```sh
forge script script/DeployV4Stack.s.sol \
  --rpc-url $ROBINHOOD_TESTNET_RPC_URL --broadcast
```

Record from output: `PoolManager` → `V4_POOL_MANAGER`, `DemoRouter`,
`mUSDC` → `QUOTE_ADDRESS`, `mNVDA` → `NVDA_ADDRESS`. (Script refuses chain
4663 by design; test-only tokens stay off mainnet.)

## 3. Deploy the oracle + push the first price

```sh
ORACLE_WRITER=<your-keeper-EOA> \
forge script script/DeployOracle.s.sol \
  --rpc-url $ROBINHOOD_TESTNET_RPC_URL --broadcast
# then, as the writer key:
cast send $NVDA_ORACLE "updatePrice(int192,uint32,uint32,bytes32)" \
  20000000000 2 $(date +%s) 0x0000000000000000000000000000000000000000000000000000000000000000 \
  --rpc-url $ROBINHOOD_TESTNET_RPC_URL --private-key $ORACLE_WRITER_KEY
```

Wraps and book init revert until the oracle reads valid (`mid > 0`, fresh).
`marketStatus = 2` (Regular) matches the test fixtures.

## 4. Deploy the static stack (book init OFF first)

```sh
STATIC_INIT_BOOK=false \
V4_POOL_MANAGER=… QUOTE_ADDRESS=… NVDA_ADDRESS=… NVDA_ORACLE=… \
STATIC_INITIAL_TICK=<see below> \
forge script script/DeployStaticStack.s.sol \
  --rpc-url $ROBINHOOD_TESTNET_RPC_URL --broadcast
```

Paste every logged address into the frontend (Deployment bar → Save), or into
`deployments/robinhood-testnet.json`.

### Init tick

`initializeBook` enforces the deviation band when the oracle is live, so the
init tick must sit on the oracle price. Use the Deploy tab calculator
(target = oracle mid × 1e10, rounded to tick spacing), then confirm deviation
≈ 0 bps on Overview after init. For a $200 NVDA book with 3000/60 fee/spacing
the tick lands near ±196260 depending on token order — do NOT hardcode it.

## 5. Fund + init the book (frontend Keeper tab, or cast)

1. `fundHook` with quote + equity (hook needs inventory — strict deploy reverts
   without it).
2. `initializeHook` with the PoolKey (currencies sorted ascending, fee,
   tickSpacing, hook) + `sqrtPriceX96` for the tick from step 4.
3. Refresh Overview: `poolInitialized`, guard present, deviation ≈ 0.

## 6. Test flows (frontend tabs)

- **Faucet**: open-mint `mUSDC`/`mNVDA` to your wallet (test mocks only).
- **Deposit**: approve + `depositQuote` on senior/junior (genesis must be
  junior-led — 25% junior floor).
- **Swap**: sells through `DemoRouter`; toxic flow pulls the guard mid-swap
  (pool thins to base, swap still executes). Preview with `simulateEv` first.
- **Redeem**: `requestRedeem` → `executeEpoch` (permissionless) →
  `fulfillRedeem` (keeper pre-expiry) → `claimAndUnwrapQuote`.
- **Keeper**: guard params, recenter/recall/rearm, `supplyIdle`, exit fees
  (owner, one-shot), oracle pushes (writer).
- **Settle**: warp is unavailable on testnet — use a short `STATIC_EXPIRY`
  (e.g. +2 days) at deploy, then `haltIfExpired` → `finalizeSettlement` →
  matured claims.

## 7. Record + verify

- Download the deployment JSON from the frontend and merge into
  `deployments/robinhood-testnet.json`; commit on `static-fee`.
- Verify sources on
  `https://explorer.testnet.chain.robinhood.com` (contract → Verify).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `cast`/wallet RPC errors | Public RPC sits behind Cloudflare for some clients: switch RPC in the UI, or `npm run robinhood:proxy` with `UPSTREAM_RPC_URL=https://rpc.testnet.chain.robinhood.com` and use `http://127.0.0.1:8546` |
| `InitPriceOffMarket` on init | tick off the oracle price — use the calculator, push a fresh price first |
| `OracleInvalid` on wrap | oracle not live — push price as writer, check `maxStaleness` |
| `NotTranche` on wrap | only senior/junior vaults (or owner pre-accountant) may wrap |
| Swaps revert when market closed | `allowedSessionsMask`/oracle session gate — push `marketStatus=2`, or set mask 0 |
| `FloorBreach` on senior deposit | deposit junior first (25% floor) |
| `OracleInvalid` mid-broadcast | oracle price older than `maxStaleness` (300s): re-push right before the timed txs |
| Foul `.env` line without `=` | breaks dotenv parsing for every var below it — forge then silently falls back to script defaults (seen: keeper/writer became deployer/zero). Keep `.env` strictly `KEY=value` |
| Deploy runs out of gas | faucet drip is 0.01 ETH — split deploys across days/keys |
