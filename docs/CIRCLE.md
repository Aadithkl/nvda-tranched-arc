# Circle Integration

Everything below is used *because it does a job in the product*, not for coverage.

## What is integrated

| Circle product | Where | Status |
|---|---|---|
| **Arc + USDC** | Contracts, gas, accounting (tranches, lending fork, JIT hook, FX pool) | live on Arc testnet |
| **Gateway / Nanopayments** | x402 price rail (`scripts/x402-price.mjs`, `scripts/x402-seller.mjs`) | live, settled |
| **Agent Marketplace (Discovery API)** | `scripts/agent-market.mjs --search` picks the LLM service by network/price/rails | working (no auth) |
| **Nanopayment for AI reasoning** | `scripts/agent-market.mjs` pays AIsa per call from the agent wallet (Gateway) with the Graph snapshot | ready; needs agent-wallet login + ~$1–2 on Base |
| **App Kits (Swap)** | `scripts/quote-compare.mjs` — App Kits `estimateSwap` vs our v4 pool quote (USDC→EURC) | working live |
| **Circle Wallets (modular/passkey)** | `frontend/` scaffold (deferred to last): passkey wallet on Arc testnet | scaffolded |
| **Paymaster / Gas Station** | frontend gasless user op (`paymaster: true`), testnet policy preconfigured | scaffolded (frontend phase) |
| **CCTP / Bridge Kit** | optional funding flow (Base→Arc) | not started (optional) |
| StableFX | permissioned institutional product — documented as unavailable; our USDC/EURC pool covers FX | n/a |
| Circle Contracts (SCP) | optional (Arc testnet only); not needed for the DeFi flows | n/a |

## Circle CLI setup (agent wallet + nanopayments)

```bash
npm install -g @circle-fin/cli

# terms acceptance for non-interactive shells (CI/scripts)
# Windows PowerShell:  $env:CIRCLE_ACCEPT_TERMS="1";  (persisted in .env)

# mainnet session (for Base USDC nanopayments)
circle wallet login you@example.com

# testnet session (Arc testnet ops)
circle wallet login you@example.com --testnet

circle wallet status
circle wallet list --type agent --chain BASE -o json
circle gateway balance --address 0x... --chain BASE --all
```

Then set `AGENT_CIRCLE_WALLET` in `.env` to the Base agent wallet address and fund it
(~$1–2 USDC) with `circle wallet fund --address 0x... --chain BASE --amount 2 --method crypto`.

## Agent Marketplace reasoning (the paid AI step)

```bash
npm run market            # refresh the Graph-derived snapshot
npm run circle:discover   # discovery API: LLM services payable via Gateway
npm run circle:inspect    # show the 402 challenge of the chosen service
npm run circle:reason     # pay per call with the agent wallet, store the verdict
```

- Default service: **AIsa API** (`https://api.aisa.one/v2/chat/completions`), OpenAI-compatible,
  ~90 models, token-metered from **$0.003/call**, `supportsCircleGateway: true` (Base/Ethereum/Arbitrum/
  Optimism/Polygon/Avalanche/Unichain, all mainnet).
- Default model: `claude-haiku-4-5-20251001` (configurable via `--model` / `AGENT_AI_MODEL`).
- Output: `agent/.cache/reasoning.json` — verdict JSON + `snapshotHash`, payer, usage, service.
- Fallback: Arc-native seller (`scripts/x402-seller.mjs` + `scripts/x402-ai.mjs --gateway-check`) or the
  deterministic model — the onchain decision stays bounded either way.

## App Kits vs our pool (quote comparison)

```bash
npm run quote:compare -- --amount 5
# pair:            USDC -> EURC (Arc testnet)
# App Kits out:    4.056198 EURC
# our pool out:    4.212875 EURC (fee 1 bps)
# difference:      -371 bps (our-pool)
```

- App Kits Swap on Arc testnet supports **USDC, EURC, cirBTC only** — the NVDA leg cannot be routed
  through it, so the NVDA↔USDC venue is our own v4 pool (`V4Quoter` quote vs x402 oracle mid).
- `--execute --via app-kit` performs the real App Kits swap when a funded wallet is available.

## Paymaster (Arc testnet) — frontend phase

- Client key stored in `.env` (`CIRCLE_CLIENT_KEY`, `NEXT_PUBLIC_CIRCLE_CLIENT_KEY`).
- Preconditions: in Circle Console configure **Wallets → Modular Wallets → Passkey domain** to the
  frontend domain (localhost for dev).
- The scaffolded `frontend/` page creates a passkey modular wallet, reads USDC/EURC balances, and
  submits an `approve + swap` batch with `paymaster: true` (gasless, testnet policy preconfigured).

## Notes / risks

- Circle Agent Marketplace has **no Arc listings** (`network=eip155:5042002` → 0), so the paid
  reasoning step settles on Base mainnet; Arc remains the execution/valuation chain.
- Gateway is `arcTestnet`-only for Arc, so mainnet nanopayments use Base USDC via the agent wallet.
- `CIRCLE_ACCEPT_TERMS=1` is set in `.env` by us; it records acceptance of the Circle CLI Terms of Use
  on behalf of the project owner (you can unset it to decline).
