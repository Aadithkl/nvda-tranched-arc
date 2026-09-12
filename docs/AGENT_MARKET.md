# Agent Market Model — NVDAc pool perception (Graph-only)

The agent's market perception answers one question per pool: **are fees worth the impermanent loss
right now, and at what range width and size?** All data comes from The Graph gateway — no CEX APIs,
no GeckoTerminal, no static fixtures in the live path.

## Pool registry (locked)

| # | Pool | Quote | Fee | Venue | Status |
|---|---|---|---|---|---|
| 1 | `USDC/NVDAc` `0x60661b31…d33b` | USDC | 0.3% | Uniswap v3 Base | live |
| 2 | `WETH/NVDAc` `0x8e740d5f…4f70` | WETH | 0.3% | Uniswap v3 Base | live |
| 3 | `NVDAc/USDC` `0x853f5f1b…7ab9` | USDC | 0.105% | Aerodrome Slipstream | tracked (not indexed yet) |
| 4 | `NVDAc/WETH` `0x20e5fad2…b62d` | WETH | 0.016% | Aerodrome Slipstream | tracked |
| 5 | `NVDAc/USDC` `0xb21769…8a18` | USDC | 0.99% | Uniswap v4 Base | tracked (v4 indexer down) |

USDC-quoted pools are primary (direct USD pricing); WETH-quoted pools are secondary cross-checks and
the fallback set. Tracked pools auto-activate when their subgraphs index them — no code changes.

Data sources (gateway, `GRAPH_API_KEY`):
`uniswap-v3-base` `43Hwfi3d…`, `aerodrome-slipstream-base` `GENunSHW…`, `uniswap-v4-base` `HNCFA9Ty…`.

## Pipeline

```
pools.json ──> gateway ──> pool state + 336h hourly + 30d daily
          ──> metrics ──> volatility profile ──> range sweep (fees vs IL) ──> verdict
```

- **Pool state**: `feeTier`, `tick`, `liquidity`, `sqrtPrice` (Q96), TVL, lifetime volume/fees, token
  decimals; USD token prices solved from TVL + token amounts + tick price.
- **Windows**: 3h trigger (is there flow now?), 14d hourly calibration, 30d daily sanity.

## Definitions

| Metric | Formula |
|---|---|
| `effectiveFeeBps` | `feesUSD / volumeUSD × 10⁴` (realized LP fee capture, per pool) |
| `feeApr` | `feesUSD_window / tvlUsd × (8760 / hours)` |
| `feePerHourPerUsd` | `feesUSD_window / hours / tvlUsd` |
| `σ3h`, `σ14d` | zero-mean RMS of hourly log returns, last 3h / full window |
| `σewma` | EWMA(λ=0.94) of hourly returns; `σannual = σ_h × √8760` |
| `activeTvlUsd` (**rewarded TVL**) | value of liquidity in the active tick-spacing band, from raw `liquidity` + current `sqrtPrice` + token USD prices |
| `activeShare` | `activeTvlUsd / tvlUsd` (share of TVL that is in range and earning) |
| `pInRange` | `2Φ(k) − 1`, `k = ln(1+band) / (σ·√H)` |
| `E[IL]` | Monte Carlo (5,000 seeded paths, lognormal) of the exact concentrated-liquidity payoff vs 50/50 HODL, in bps of notional |
| `E[fee]` | `feePerHourPerUsd × tvlUsd/(notional + activeTvlUsd) × H × pInRange × 10⁴` — only in-range (rewarded) value competes, so a small in-range share raises per-dollar yield and size dilutes it |
| `netEdgeBps` | `E[IL] + E[fee]` (IL is negative); daily view = `× 24/H` |
| **`var95Bps`** | 5th percentile of the simulated IL distribution — loss not exceeded with 95% confidence (**IL VaR**) |
| **`cvar95Bps`** | mean of the worst 5% of paths (**expected shortfall**) |
| **`pIlExceedsFees`** | share of paths where fees fail to cover IL (loss probability) |
| **`requiredFeeBps` / `breakevenFeePerHourPerUsd`** | fee level needed to exactly offset expected IL over the horizon |
| **`expectedTimeInRange`** | probability-weighted fraction of time the price stays inside the band |
| **`ilShocks`** | deterministic IL table: ±1/2/5/10% price moves and ±1/2/3σ moves |
| verdict | `worthLp = netEdgeBps ≥ minEdgeBps && pInRange ≥ minPInRange && pIlExceedsFees ≤ maxPIlExceedsFees` |
| suggested params | `bucketTicks = bandToTicks(bestBand)`, `maxDeployPerSwap ≈ netEdge × 1000` USDC (capped at controller bound), `baseFee` reference = median primary `effectiveFeeBps` |

Risk gates: `AGENT_MIN_EDGE_BPS` (0.2), `AGENT_MIN_P_IN_RANGE` (0.6), `AGENT_MAX_P_IL_EXCEEDS_FEES` (0.35).
If the best band breaches the IL-risk gate the verdict is `no-LP` with reason `il_risk_too_high`.

Conservative choices: σ uses `max(σ3h, σ14d)`; fee share is band-independent (under-credits tighter
ranges, so chosen bands err wide/safe); 1h horizon approximates a JIT episode plus margin.

## Usage

```bash
npm run market                 # table
npm run market:json            # cached JSON snapshot (agent reads this)
node agent/market.mjs --pool uni-v3-usdc-nvdac --no-cache
```

Cache: `agent/.cache/market.json`, TTL `AGENT_MARKET_CACHE_TTL` (default 900s). The agent reads the
cache each tick and overlays it on the regime decision: `worthLp=false` disables quoting;
`worthLp=true` applies `bucketTicks` and `maxDeployPerSwap` inside `StrategyController` bounds.

## x402-paid AI reasoning (model selectable)

`scripts/x402-ai.mjs` takes the market snapshot (`agent/.cache/market.json`) and calls the
**metered model gateway** at `agent402.tools` (`POST /v1/metered/chat/completions`), paying per call in
USDC over x402. The model is explicit, never random:

| Tier | Endpoint | Example models |
|---|---|---|
| `v1-chat-nano` | metered | `openai/gpt-5-nano`, `openai/gpt-5.6-luna`, `google/gemini-2.5-flash-lite`, `meta-llama/llama-3.2-3b`, `mistralai/ministral-8b`, `qwen/qwen-2.5-7b`, `deepseek/deepseek-chat`, `poolside/laguna-s-2.1` |
| `v1-chat` (default) | metered | `openai/gpt-4o-mini`, `openai/gpt-4.1-mini`, `anthropic/claude-haiku-4.5`, `google/gemini-2.5-flash`, `google/gemini-3.5-flash-lite`, plus `deepseek/*`, `meta-llama/*`, `mistralai/*`, `qwen/*` |
| `v1-chat-pro` | metered | `openai/gpt-4.1`, `anthropic/claude-sonnet-5`, `google/gemini-2.5-pro`, `google/gemini-3.1-pro-preview`, `google/gemini-3.6-flash`, `x-ai/grok-4.6` |
| `v1-chat-premium` | metered | `openai/gpt-5`, `openai/gpt-5.6-sol`, `openai/gpt-5.6-terra`, `openai/o3`, `openai/o4-mini`, `anthropic/claude-opus-5` |
| `v1-chat-auto` | metered | server picks the model (eval-ranked) — the only non-deterministic routing |
| `v1-chat-grounded` | metered | grounded in a live web search |

Live-verified `2026-09-12`: 58 models across 10 tiers; no `gpt-5.5-luna` — the Luna line is
`gpt-5.6-luna` (nano), with `gpt-5.6-sol` / `gpt-5.6-terra` in premium. Re-check anytime with
`npm run ai:models` (`GET /v1/models` is free; the response ETag signals changes).

- Allowlist + per-tier limits: `GET /v1/models` (`npm run ai:models`).
- Billing: the 402 quotes exact input + `max_tokens` at the model price × 1.15 (from $0.001, cap $2);
  pay `exact` or authorize as a ceiling with `upto` and settle actual usage.
- Usage:

```bash
npm run market                 # refresh the snapshot the model reads
npm run agent:refresh          # paid verdict only if older than AGENT_LLM_REFRESH_SECONDS (6h)
npm run ai:reason              # default openai/gpt-4o-mini, cap $0.02
npm run ai:reason -- --model anthropic/claude-haiku-4.5 --max-tokens 700
npm run ai:reason -- --dry-run # prompt preview, no payment
```

- Output: `agent/.cache/reasoning.json` — `{ model, usage, payment, snapshotHash, content, reasoning }`
  where `reasoning` is the parsed JSON verdict `{decision, confidence, paramOverrides, auditOverrides,
  rebalance, rationale, risks}` and `snapshotHash = sha256(compactMarket(market))`. The daemon only
  trusts it while the hash matches the market cache it is acting on.
- **Manager cadence:** `agent/refresh.mjs` runs the paid call only when the verdict is older than
  `AGENT_LLM_REFRESH_SECONDS` (6h). Audit overrides stay usable for `AGENT_REASONING_MAX_AGE_SECONDS`
  (12h); rebalance calls for `AGENT_REBALANCE_MAX_AGE_SECONDS` (6h).
- **Funding:** agent402 accepts USDC on Base, Polygon, Arbitrum, Monad, Avalanche, Sei, Optimism,
  Celo, Robinhood chain, Solana, Stellar, Algorand. Circle Gateway batching is **not** available for
  this seller (`--gateway-check` returns unsupported), so the payer wallet must hold USDC on one of
  those chains (Base costs $0.001/call).
- **Authority:** `paramOverrides` may set any hook param (JIT range/size, dynamic fees, deviation band,
  TTL, quoting on/off) within `PARAM_CLAMPS` ∩ controller bounds; `auditOverrides` may steer the
  economic-audit thresholds within `AUDIT_CLAMPS` (bounded both ways); `rebalance` picks buy/sell/hold
  and size within the hard rails (oracle, escrow, 75% equity cap, min/max USD). See `agent/README.md`.
- The deterministic agent loop stays authoritative over the hard gates: per-swap onchain checks and the
  per-tick `economicAudit` run unchanged while the model is stale, missing, or wrong.

## Latest live snapshot (2026-09-12)

| Pool | TVL | Vol 24h | Fee APR | Active TVL | σ3h | σ14d | Best band | E[IL] | E[fee] | Edge | pLoss | VaR95 | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| USDC/NVDAc | $57.4k | $50.6k | 54.6% | $2.6k (4%) | 3.0 bps/h | 30.4 bps/h | 500 bps | −0.5 | +10.0 | **+9.6 bps/h** | 0.00 | −1.8 bps | LP |
| WETH/NVDAc | $43.8k | $18.9k | 256% | $1.4k (3%) | 30.3 bps/h | 52.8 bps/h | 500 bps | −1.4 | +53.2 | **+51.8 bps/h** | 0.00 | −5.4 bps | LP |

Aggregate σ14d ≈ 34.0 bps/h (≈ 32% annualized), reference fee 30 bps. `pLoss = pIlExceedsFees`,
`VaR95 = var95Bps`. The full JSON also carries `cvar95Bps`, `ilP99Bps`, `ilWorstBps`,
`requiredFeeBps`, `expectedTimeInRange` and the `ilShocks` table (±1/2/5/10%, ±1/2/3σ) per band.

## Known limitations

- Two live pools only; Aerodrome/v4 slots are tracked and activate when indexed.
- Thin pools: hourly volumes are spiky ($0.1–$3.6k); the 3h trigger + 14d calibration + confidence
  flags exist for this.
- The fee-share model is value-based (uses rewarded TVL) and does not yet credit narrower ranges for
  capital efficiency; this makes the sweep conservative.
- Realized validation (backtest vs `JitDeployment.seed` → `JitRemoval.claim0/1`) lands once the
  JIT-enabled hook is live on Arc.

## Economic audit gate

`economicAudit` in `agent/model.mjs` turns the market model into a hard go/no-go checklist the daemon
runs every tick before submitting params. It decomposes yield into exogenous (Aave base) and endogenous
(JIT fees), applies IL + swap costs, and checks the first-loss structure:

- disable quoting when the oracle is invalid, the senior escrow is unfunded, or the junior buffer is
  below 5% of the senior claim;
- hold when net edge after IL/swap costs is not positive, p(IL > fees) > 0.35, or VaR95 is worse than
  −500 bps (1h);
- cap `maxDeployPerSwap` at 50% of the junior claim.

Thresholds are env-tunable (`AGENT_AUDIT_*`, see `agent/README.md`) and the fresh LLM verdict may
override them within hard clamps (`AUDIT_CLAMPS` in `agent/model.mjs`): the model can tighten or loosen
each field inside its bounds, but the structural checks (oracle validity, escrow funding) and the
onchain per-swap gates are never overridable. The same checklist is embedded in the x402/LLM system
prompt (`agent/ai-prompt.mjs`) together with the current effective thresholds from
`agent/.cache/policy.json`.
