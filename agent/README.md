# Tranche Agent (LLM strategy manager + deterministic intern)

Offchain control plane for `TrancheJITHook`. A paid LLM acts as the slow **strategy manager** (default
every 6h): it owns hook params (JIT range/size, dynamic fees, deviation band, TTL), the economic-audit
thresholds and rebalancing. Deterministic code is the fast **intern**: it clamps every LLM field,
re-runs the audit each 10-minute tick and enforces the hard gates on every swap. It acts through the
whitelisted `StrategyAgent` contract and can never mint/burn shares, move funds to arbitrary
addresses, or change roles.

```
                      ┌──────────────────────── slow loop (6h) ─────────────────────────┐
Graph market ─────────┤ agent/market.mjs ──► scripts/x402-ai.mjs (paid) ──► reasoning.json │
                      └────────────────────────────────┬────────────────────────────────┘
oracle + hook + accountant ──► agent/index.mjs ─────────┘──► StrategyAgent ──► StrategyController ──► hook params
      (RPC / The Graph)     regime + clamps + audit          (whitelisted)      (hard bounds)
```

## Run modes

| Mode | Command |
|---|---|
| Local dry run | `node agent/index.mjs --once` |
| Local submit | `node agent/index.mjs --once --submit` |
| Local loop (default 600s) | `node agent/index.mjs --loop --interval 600 --submit` |
| HTTP bridge for the frontend "Run agent check" button | `npm run agent:serve` (add `-- --submit` to broadcast); `POST /tick`, `GET /health` on `AGENT_HTTP_PORT` (default 8787, dry-run unless `--submit`) |
| Refresh paid verdict (only if > `AGENT_LLM_REFRESH_SECONDS` old) | `node agent/refresh.mjs` |
| Force a refresh | `node agent/refresh.mjs --force` |
| Push oracle price now (also runs on load/each tick) | `npm run oracle:refresh` (`--force`, `--dry`) |
| GitHub Actions heartbeat | `.github/workflows/agent-heartbeat.yml` (cron every 10 min, `workflow_dispatch` for manual) |
| EigenCompute (later) | containerized daemon (`Dockerfile` to be added when key custody matters) |

## Regimes (policy)

| Regime | Condition | Base fee | Deviation band | TTL | Max deploy |
|---|---|---|---|---|---|
| calm | deviation ≤ 50 bps | 0.30% | 300 bps | 3600s | 1 USDC |
| elevated | ≤ 150 bps | 0.50% | 250 bps | 1800s | 0.5 USDC |
| turbulent | > 150 bps | 0.80% | 150 bps | 900s | 0.1 USDC |
| closed | oracle invalid / market closed | — | — | — | quoting **off** |
| unfunded | senior escrow not funded | — | — | — | quoting **off** |

The `StrategyController` enforces hard bounds on every submitted param, so a compromised or wrong agent
can only shrink/reshape activity within those limits. Fees are uncapped apart from the 100% protocol
maximum — the manager may price extreme markets up to seven figures (70%+).

## Automatic price rail

The agent owns the oracle: before every submitted tick (`agent/price.mjs`) it checks `getPrice()`, and
when the price is stale it walks the seller list (`ORACLE_PRICE_SELLERS`) until one returns a quote —
every paid call settles **only through Circle Gateway nanopayments** (x402 sellers; no external oracle
provider is integrated). The quote is mapped to the US/Eastern session and pushed with
`updatePrice(...)` from the agent wallet. The oracle only accepts the seeded writer (the agent
operator), so no one else can publish a price. Closed markets and fresh prices are skipped (no gas, no
payment). Disable with `AGENT_PRICE_PUSH=0`; `ORACLE_PRICE_USD` is an offline override,
`ORACLE_PRICE_FALLBACK_URL` an optional last resort. Local dry-runs (`--once` without `--submit`)
never push; run it manually with `npm run oracle:refresh`.

### LLM manager layer

When a fresh, snapshot-hash-matched verdict exists, the paid model overlays the deterministic table:

| Field | Authority | Hard clamp (`model.mjs`) |
|---|---|---|
| `paramOverrides.*` | any hook param: `quotingEnabled`, `baseFee`, `maxDeviationBps`, `toxicityMultiplierBps`, `minEvBps`, `cooldownSeconds`, `ttl`, `gracePeriod`, `maxDeployPerSwap`, `bucketTicks` | `PARAM_CLAMPS` ∩ live `StrategyController.bounds()` |
| `auditOverrides.*` | economic-audit thresholds | `AUDIT_CLAMPS` (bounded both ways) |
| `rebalance` | buy/sell/hold + size in USD | `validateRebalanceProposal` (oracle, escrow, 75% equity cap, min/max size) |
| `decision` | deploy/reduce/hold/disable | structural disables re-applied by the audit |

Stale verdict, hash mismatch, or a missing file means the deterministic path continues unchanged — the
LLM is never in the per-swap path and never blocks a tick. Freshness: overrides live
`AGENT_REASONING_MAX_AGE_SECONDS` (default 2× the refresh interval), rebalance calls only
`AGENT_REBALANCE_MAX_AGE_SECONDS` (default one interval).

### LLM prompt contract

Source of truth: `agent/ai-prompt.mjs` (`SYSTEM_PROMPT`, `compactMarket`, `compactPolicy`); the paid
call is `agent/refresh.mjs` → `scripts/x402-ai.mjs`, which binds the verdict to a sha256 of
`compactMarket(market)`.

**What is sent** (user message = `{ market, policy }`):
- `market.aggregate` — pooled σ14d, reference fee bps, best band, `worthLp`, suggested max deploy, executed pool.
- `market.ownPool` — our deployed Arc USDC/NVDA venue: `{ poolId, usdPerNvda, swapCount, volumeUsd, feesUsd, feeApr, lpValueUsd, spanHours }` (realized volume/fees; `feeApr` is a short-window run-rate).
- `market.effective` — blended fee source: Arc realized daily fee bps and the Base run-rate averaged at `blendWeight`; while `spanHours < AGENT_OWN_POOL_MIN_SPAN_HOURS` (6h) the Arc weight drops to 0 (Base carries, `lowConfidence=true`).
- `market.pools[]` — per live NVDAc pool: TVL, 24h volume/fees, fee APR, effective fee bps, active TVL/share, σ3h/σ14d, and the band verdict (`worthLp`, `netEdgeBps`, `expectedIlBps`, `var95Bps`, `pIlExceedsFees`, `suggestedMaxDeployUsdc`).
- `policy` — current hook params, effective audit thresholds, risk (`oracleValid`, `quoteState`, `deviationBps`, escrow, senior/junior claims) and book composition.

**Questions the model must answer**: (1) is JIT/LP worth it now (edge after IL + costs > 0)?
(2) which `bucketTicks` band and `maxDeployPerSwap`? (3) fee schedule / quoting / TTL / deviation band?
(4) which audit thresholds to tighten or loosen? (5) rebalance buy/sell/hold + size within the 75%
equity cap? (6) what invalidates this (`risks`)?

**Expected answer** (strict JSON, no markdown): `{ decision, confidence, paramOverrides?,
auditOverrides?, rebalance?, rationale, risks[] }` — every field except `decision` optional; all
overrides clamped by `model.mjs` and the live `StrategyController.bounds()`.

## Environment

```
ARC_RPC_URL=
AGENT_HOOK=        # TrancheJITHook address
AGENT_MODULE=      # TranchePipeModule address (exits + rebalancing; falls back to AGENT_HOOK)
AGENT_ORACLE=      # price oracle address
AGENT_ADDRESS=     # StrategyAgent address (whitelisted on the controller)
AGENT_KEEPER=      # TrancheAccountant address (optional; for fulfillRedeem/rebalance)
AGENT_OPERATOR_PRIVATE_KEY=  # operator key ONLY (never the deployer key), local .env / GitHub secret
AGENT_CADENCE_SECONDS=600
PARAMS_TTL_SECONDS=3600
# Paid x402 strategy manager (agent/refresh.mjs refreshes the verdict when older than this)
AGENT_LLM_REFRESH_SECONDS=21600
AGENT_REASONING_MAX_AGE_SECONDS=43200
AGENT_REBALANCE_MAX_AGE_SECONDS=21600
AGENT_POLICY_CACHE=agent/.cache/policy.json
AGENT_REASONING_URL=
# Rebalancing is LLM-owned; deterministic validates the hard rails only (max 75% equity onchain)
AGENT_REBALANCE_ENABLED=1
AGENT_REBALANCE_MIN_USD=1
AGENT_REBALANCE_MAX_USD=500
AGENT_REBALANCE_SLIPPAGE_BPS=50
AGENT_REBALANCE_DEADLINE_SECONDS=300
# Economic audit gate (model.mjs `economicAudit`); env defaults, LLM may override within clamps
AGENT_AUDIT_MIN_NET_EDGE_BPS=0.2
AGENT_AUDIT_MIN_BUFFER_BPS=500
AGENT_AUDIT_MAX_DEPLOY_OF_JUNIOR_BPS=5000
AGENT_AUDIT_MAX_VAR95_BPS=500
AGENT_AUDIT_MAX_PIL_EXCEEDS_FEES=0.35
```

## Dual-token rebalancing (LLM-owned)

Each tick the daemon reads `assetComposition()` (USDC/equity values + `equityBps` and the pipe's
`hardMaxEquityBps`) and passes it to the LLM manager in `agent/.cache/policy.json`. The model's
`rebalance` proposal (`buy` / `sell` / `hold` + `sizeUsd`) is the only source of direction; the
deterministic intern (`validateRebalanceProposal`) only validates the hard rails:

| Rail | Rule |
|---|---|
| oracle | must be valid |
| funding | buys require `escrowFunded` |
| equity cap | post-trade `equityBps <= hardMaxEquityBps` (onchain default 75%, re-checked in `TranchePipeModule`) |
| size | clamped to `[AGENT_REBALANCE_MIN_USD, AGENT_REBALANCE_MAX_USD]` and the remaining cap room |
| freshness | verdict age ≤ `AGENT_REBALANCE_MAX_AGE_SECONDS` and the snapshot hash must match |
| venue | never the hook's own JIT pool; `unwrapProportional` remains the oracle-free exit |

Translations are computed from the oracle mid with `AGENT_REBALANCE_SLIPPAGE_BPS`; the hook rejects
anything looser than its own oracle anchor, and the controller enforces the per-call cap and cooldown.
Each rebalance carries a deadline (`AGENT_REBALANCE_DEADLINE_SECONDS`, default 300s) that the
controller and module enforce. No fresh LLM verdict means no trade — the params path still runs.

## Economic audit (hard gate)

Every tick the daemon runs `economicAudit` (`agent/model.mjs`) before submitting anything. Effective
thresholds = env defaults overridden by the fresh LLM verdict (`auditOverrides`), clamped per field by
`clampAuditOverrides`/`AUDIT_CLAMPS` (bounded both ways; structural disables are never overridable).
The audit is the agent's yield/cost/first-loss checklist; the verdict is enforced onchain-safe (the
controller still bounds everything):

| Check | Threshold (env default) | On failure |
|---|---|---|
| oracle valid | — | disable quoting |
| senior escrow funded | — | disable quoting |
| junior buffer ≥ 5% of senior claim | `AGENT_AUDIT_MIN_BUFFER_BPS` | disable quoting |
| net edge after IL + swap costs > 0.2 bps | `AGENT_AUDIT_MIN_NET_EDGE_BPS` | hold |
| p(IL > fees) ≤ 0.35 | `AGENT_AUDIT_MAX_PIL_EXCEEDS_FEES` | hold |
| VaR95 ≥ −500 bps (1h) | `AGENT_AUDIT_MAX_VAR95_BPS` | hold |
| deploy ≤ 50% of the junior claim | `AGENT_AUDIT_MAX_DEPLOY_OF_JUNIOR_BPS` | cap `maxDeployPerSwap` |

The audit also logs the yield decomposition (exogenous Aave base yield vs endogenous JIT fees vs
incentives = 0) and its `invalidationTriggers`. The x402/LLM path receives the same checklist plus the
current effective thresholds (`agent/.cache/policy.json`) so the model can steer them within the hard
clamps, and the deterministic audit stays the final gate.

## x402 strategy manager (paid, 6h)

`scripts/x402-ai.mjs` sends the Graph snapshot plus the deterministic policy state
(`agent/.cache/policy.json`) to the metered model gateway (`agent402.tools`, `AGENT_AI_URL`), pays per
call in USDC over x402 (`X402_PAYER_PRIVATE_KEY`, per-call cap `AGENT_AI_MAX_PAYMENT_USDC`), and writes
the verdict to `agent/.cache/reasoning.json` bound to `sha256(compactMarket(market))`.

`agent/refresh.mjs` runs it only when the verdict is older than `AGENT_LLM_REFRESH_SECONDS` (6h).
Verdict schema (strict JSON, `agent/ai-prompt.mjs`): `decision` (deploy/reduce/hold/disable),
`paramOverrides`, `auditOverrides`, `rebalance` (action/sizeUsd), `rationale`, `risks`. Legacy
`recommendedBucketTicks`/`recommendedMaxDeployUsdc` fields still work.

Failure is safe: missing, stale or hash-mismatched verdict → deterministic regime table + env
thresholds, and the tick proceeds unchanged.

## GitHub Actions

`.github/workflows/agent-heartbeat.yml` runs every 10 minutes and on manual dispatch. Each run restores
`agent/.cache` (actions/cache), calls `node agent/refresh.mjs` (paid LLM only when the verdict is > 6h
old; needs `GRAPH_API_KEY`, optional `X402_PAYER_PRIVATE_KEY`), runs the deterministic tick, then saves
the cache back. The protocol is safe if the agent stops: params expire and the hook moves
`ACTIVE → DEGRADED → REST`, with capital resting in Aave.

## Market model (Graph-only)

`agent/market.mjs` + `agent/model.mjs` compute, from The Graph gateway only:

- **volatility** per pool (3h trigger, 14d calibration, EWMA, annualized),
- **fees** (`effectiveFeeBps`, `feeApr`, `fee per hour per $`),
- **TVL** and **active/rewarded TVL** (in-range liquidity value and share),
- **range sweep**: fees vs impermanent loss per band, with the fee share diluted by rewarded TVL,
- a verdict with suggested `bucketTicks` / `maxDeployPerSwap` inside controller bounds.

```bash
npm run market        # live table
npm run market:json   # cache snapshot (read by the agent tick)
```

Full definitions: `docs/AGENT_MARKET.md`. The agent tick reads `agent/.cache/market.json`, overlays the
verdict on the regime decision (`worthLp=false` disables quoting), and writes the policy snapshot the
LLM manager reads (`agent/.cache/policy.json`).
