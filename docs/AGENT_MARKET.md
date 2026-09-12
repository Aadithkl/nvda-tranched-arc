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
| verdict | `worthLp = netEdgeBps ≥ minEdgeBps && pInRange ≥ minPInRange` |
| suggested params | `bucketTicks = bandToTicks(bestBand)`, `maxDeployPerSwap ≈ netEdge × 1000` USDC (capped at controller bound), `baseFee` reference = median primary `effectiveFeeBps` |

Conservative choices: σ uses `max(σ3h, σ14d)`; fee share is band-independent (under-credits tighter
ranges, so chosen bands err wide/safe); 1h horizon approximates a JIT episode plus margin.

## Usage

```bash
npm run market                 # table
npm run market:json            # cached JSON snapshot (agent reads this)
node agent/market.mjs --pool uni-v3-usdc-nvdac --no-cache
npm run test:agent             # offline math tests
```

Cache: `agent/.cache/market.json`, TTL `AGENT_MARKET_CACHE_TTL` (default 900s). The agent reads the
cache each tick and overlays it on the regime decision: `worthLp=false` disables quoting;
`worthLp=true` applies `bucketTicks` and `maxDeployPerSwap` inside `StrategyController` bounds.

## Latest live snapshot (2026-09-12)

| Pool | TVL | Vol 24h | Fee APR | Active TVL | σ3h | σ14d | Best band | E[IL] | E[fee] | Edge | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| USDC/NVDAc | $57.4k | $55.4k | 54.6% | $2.6k (4%) | 8.4 bps/h | 30.5 bps/h | 500 bps | −0.0 | +10.0 | **+10.0 bps/h** | LP |
| WETH/NVDAc | $43.8k | $19.2k | 256% | $1.4k (3%) | 38.5 bps/h | 52.9 bps/h | 500 bps | −0.8 | +53.3 | **+52.5 bps/h** | LP |

Aggregate σ14d ≈ 33.9 bps/h (≈ 32% annualized), reference fee 30 bps.

## Known limitations

- Two live pools only; Aerodrome/v4 slots are tracked and activate when indexed.
- Thin pools: hourly volumes are spiky ($0.1–$3.6k); the 3h trigger + 14d calibration + confidence
  flags exist for this.
- The fee-share model is value-based (uses rewarded TVL) and does not yet credit narrower ranges for
  capital efficiency; this makes the sweep conservative.
- Realized validation (backtest vs `JitDeployment.seed` → `JitRemoval.claim0/1`) lands once the
  JIT-enabled hook is live on Arc.
