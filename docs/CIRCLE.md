# Circle Integration

Everything below is used *because it does a job in the product*, not for coverage.

**Payment rail policy:** every paid call in the product settles through **Circle Gateway batched
settlement (nanopayments)**. Raw x402 paths are legacy (`x402-ai.mjs`, `x402-price.mjs --legacy-x402`)
and are not used in production flows.

## Tranche stack deployment (Arc testnet, 2026-09-12)

| Contract | Address |
|---|---|
| TrancheJITHook (v2, JIT + security fixes) | `0xB229976cB5F64C6f747033c26217299AeCD42Ac0` |
| HookShareToken (ERC-7575) | `0x917386b70E03cdC2026B612fd1388d9DfC349C96` |
| TrancheAccountant | `0x3903C50fB7066C9a2d473d772e4dA48cfb4563a4` |
| SeniorVault (ERC-7540) | `0x708C2FF1d6829cf1980da8Ad4f6A1f14F958018e` |
| JuniorVault (ERC-7540) | `0x19858E406Eb262CdD899AF8Dc2aa866521b3135c` |
| PoolId (USDC/EURC, dynamic fee, JIT) | `0xba11852e08659fc30d1f5221e7de78a3a0b8d9ec69a99341868fe6c5d9e3c4c1` |

Deployed in two steps to avoid a solc pragma clash between v4-core (0.8.26) and ERC-7540 (^0.8.27):
`forge script script/DeployTrancheHookV2.s.sol` then `script/DeployTrancheStack.s.sol` with
`HOOK_ADDRESS` set. Wiring verified onchain (accountant/senior/junior/controller/share/JIT flag).
Manifest: `deployments/arc-testnet.json` → `stack`.


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

## Agent Marketplace reasoning (the paid AI step) — working end-to-end

Agent wallets (one EVM address per Circle account, same address across EVM chains):
- Base mainnet: `0x974f9aa0fca4870baff480727ee0e684b3dbe4f2`
- Arc testnet: `0xbba61cef4a53467929161c1c9eac8ee554b4a05d` (faucet-funded 20 USDC)

```bash
npm run market            # refresh the Graph-derived snapshot
npm run circle:discover   # discovery API: LLM services payable via Gateway
npm run circle:inspect    # show the 402 challenge of the chosen service
npm run circle:reason     # pay per call with the agent wallet, store the verdict
```

- Default service: **BlockRun.AI** (`https://nano.blockrun.ai/api/v1/chat/completions`), $0.003/call,
  payable via **Circle Gateway on Polygon**; CLI `--chain MATIC`.
- Funding path: Base USDC → Gateway via eco deposit (no gas):
  `circle gateway deposit --amount 0.5 --address 0x974f... --chain BASE --method eco`
  (destination is always Polygon; pay with `--chain MATIC`). Arc testnet uses
  `--method direct` (onchain, gas in native USDC).
- Verified run: `decision="reduce"`, `confidence=0.7`, `recommendedBucketTicks=488`,
  `recommendedMaxDeployUsdc=9600`, saved with `snapshotHash` to `agent/.cache/reasoning.json`.
- AIsa (`api.aisa.one`, 90 models) is listed but its server enforces exact requirement equality
  (`maxTimeoutSeconds 604900`) while the Circle CLI signs `2592000` → `payment_requirements_mismatch`
  (no funds moved). Workaround: pay via `@circle-fin/x402-batching` `GatewayClient` once a Gateway
  balance is held by a local (non-custodial) key — needs mainnet gas for the deposit.
- Arc-native nanopayment verified: the testnet agent wallet paid our own x402 seller $0.001 on Arc
  (`circle services pay http://127.0.0.1:4021/api/nvda --address 0xbba6... --chain ARC-TESTNET`),
  seller logged `[settled]`.

Transfers from the agent wallet need the ERC-20 explicitly:
`circle wallet transfer 0xTO --amount 0.05 --token 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 --address 0x974f... --chain BASE`
(omitting `--token` targets the native balance and fails with insufficient funds).

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
