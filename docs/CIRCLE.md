# Circle Integration

Everything below is used *because it does a job in the product*, not for coverage.

**Payment rail policy:** every paid call in the product settles through **Circle Gateway batched
settlement (nanopayments)**. Raw x402 paths are legacy (`x402-ai.mjs`) and are not used in
production flows.

## Tranche stack deployment (Arc testnet, 2026-09-12)

| Contract | Address |
|---|---|
| TrancheJITHook (v3, USDC/NVDA JIT live) | `0x5C374e0B4F3646705839BE9D2b45F6753EAC6aC0` |
| HookShareToken (ERC-7575) | `0x9341fA835A44A225E7f36a245A149794239c221A` |
| TranchePipeModule | `0x04614f09DfC7D66B5072FB9B745C9B1b9503bA5e` |
| TrancheAccountant | `0x8c0FACD06b0bB540F82817ee5731eDA9D8E75Ce3` |
| SeniorVault (ERC-7540) | `0x2b9Bc484b5De5ffd96e0aD37a05D0ff1B4380266` |
| JuniorVault (ERC-7540) | `0xdBEAaAc8281459510E871aBdE4bf88C8AC530F8a` |
| PoolId (dynamic fee, JIT) | `0x93b8dfd381ccd69e771c70fb0dc6fc19ab9b031d60197032372e46000fa67292` |

Deployed in two steps (`--slow`) to avoid a solc pragma clash between v4-core (0.8.26) and ERC-7540
(^0.8.27): `DeployTrancheHookV3` (fresh controller+agent, pipe, pool init) then `DeployTrancheStack`
with `HOOK_ADDRESS` + `PIPE_ADDRESS`. Wiring verified onchain; 23 hook-routed swaps produced JIT
episodes with toxic surge fees. Manifest: `deployments/arc-testnet.json` → `stack`; see
`docs/DEPLOYMENTS.md`.


## What is integrated

| Circle product | Where | Status |
|---|---|---|
| **Arc + USDC** | Contracts, gas, accounting (tranches, lending fork, JIT hook, NVDA pool) | live on Arc testnet |
| **Agent Marketplace (Discovery API)** | `scripts/agent-market.mjs --search` picks the LLM service by network/price/rails | working (no auth) |
| **Nanopayment for AI reasoning** | `scripts/agent-market.mjs` pays the selected LLM service per call from the agent wallet (Gateway) with the Graph snapshot | working — BlockRun verified (Polygon); needs a funded agent wallet |
| **Circle Wallets (modular/passkey)** | `frontend/` — Create provisions a passkey smart account; Unlock signs in an existing passkey (injected-wallet fallback) | implemented; set `VITE_CLIENT_KEY` + Console passkey domain to go live |
| **Paymaster / Gas Station** | `frontend/` userOps submit with `paymaster: true` (testnet sponsorship) | implemented; automatic on testnet once the client key is set |
| **CCTP / Bridge Kit** | optional funding flow (Base→Arc) | not started (optional) |
| StableFX | permissioned institutional product — documented as unavailable | n/a |
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
  `recommendedMaxDeployUsdc=9600`, saved with `snapshotHash` to `agent/.cache/reasoning.json`. Schema
  v2 adds `paramOverrides`, `auditOverrides` and `rebalance`; legacy fields still work.
- AIsa (`api.aisa.one`, 90 models) is listed but its server enforces exact requirement equality
  (`maxTimeoutSeconds 604900`) while the Circle CLI signs `2592000` → `payment_requirements_mismatch`
  (no funds moved). Workaround: pay via `@circle-fin/x402-batching` `GatewayClient` once a Gateway
  balance is held by a local (non-custodial) key — needs mainnet gas for the deposit.
- Arc-native nanopayments settle through the Gateway client (testnet facilitator); no
  public push or seller endpoints remain in the repo.

Transfers from the agent wallet need the ERC-20 explicitly:
`circle wallet transfer 0xTO --amount 0.05 --token 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 --address 0x974f... --chain BASE`
(omitting `--token` targets the native balance and fails with insufficient funds).

## Passkey wallets + Paymaster (Arc testnet) — frontend

- `frontend/` (`frontend/src/wallet.ts`) connects an injected browser wallet or a Circle passkey
  smart account (`@circle-fin/modular-wallets-core`); userOps submit with `paymaster: true`
  (gasless, testnet sponsorship).
- Flows: **Create** registers a passkey (username required) and provisions its smart account;
  **Unlock** signs back in with an existing passkey (username optional). Same passkey ⇒ same
  smart-account address; operations are gasless userOps.
- Env: repo-root `.env` → `VITE_CLIENT_KEY` (Console → Keys → Client Key; Vite reads the root
  `.env` via `envDir: ".."`), optional `VITE_CLIENT_URL`. The Pages workflow injects the
  `VITE_CLIENT_KEY` repository secret for the hosted site
  (<https://aadithkl.github.io/nvda-tranched-arc/>).
- Precondition (hosted): the client key's **allowed domain** and the **Wallets → Modular Wallets →
  Passkey domain** must both be `aadithkl.github.io`. Passkeys are RP-ID/domain-bound — create the
  passkey on the hosted domain; a passkey from another domain cannot unlock here (local dev needs
  its own key + passkey pair).
- App surface: vault deposit, redeem request, keeper fulfill and claim; oracle price + market
  session; hook quote state and strategy bounds reads; contract registry. See
  `docs/FRONTEND_INTEGRATION.md`.

### Passkey troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot find the entity config in the system` | Passkey domain not configured | Console → **Wallets → Modular Wallets → Passkey** → set it to `aadithkl.github.io` |
| `Invalid credentials` (HTTP 401) | Client key isn't linked to this origin | Console → **Keys** → set the key's allowed domain to `aadithkl.github.io` (or create a key for it). The localhost-linked key gets 401 on the Pages domain |
| `NotAllowedError` / prompt never appears | No passkey for this domain, or the user cancelled | Create once on `aadithkl.github.io` — a passkey created on `localhost` cannot unlock on the Pages domain |
| `SecurityError` | Passkey belongs to a different origin | Create a passkey on this domain instead |
| `InvalidStateError` / already registered | Passkey already exists for that username | Use **Unlock** |

These messages surface verbatim from Circle's RPC (`modular-sdk.circle.com`); the app maps them to
actionable toasts in `frontend/src/wallet.ts`.

## Notes / risks

- Circle Agent Marketplace has **no Arc listings** (`network=eip155:5042002` → 0), so the paid
  reasoning step settles on Base mainnet; Arc remains the execution/valuation chain.
- Gateway is `arcTestnet`-only for Arc, so mainnet nanopayments use Base USDC via the agent wallet.
- `CIRCLE_ACCEPT_TERMS=1` is set in `.env` by us; it records acceptance of the Circle CLI Terms of Use
  on behalf of the project owner (you can unset it to decline).
