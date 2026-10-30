# NVDA allocator cadCAD model

Hour-by-hour simulation of the NVDA tranched-vault allocator: Book A (V4 0.05%),
Book B (V4 0.30%), the Morpho USDG lend arm, the Spiral/NVDA collateral arm, and
the keeper's one-action-per-hour move logic. Built from the downloaded 45-day
Uniswap swap tapes.

The model is a port of `scripts/keeper/allocator.mjs` and
`scripts/keeper/index.mjs`, not a parallel design. The `allocator` policy is the
literal code; `allocator_fixed` adds the guard/hypothetical fixes but keeps the
net-APR gate; `risk_only` is the documented risk-only design. The other
behavioural choices (90% funding, no warmup, event-based guard pulls, 30% LTV
sentinel, borrow-APR deleverage) now mirror the keeper.

Read next:

- [`MODEL_CANVAS.md`](MODEL_CANVAS.md) — state, PSUBs, equations, invariants.
- [`ARM_REALISM.md`](ARM_REALISM.md) — 3% USDG + 3% NVDA in Morpho/Spiral, with
  live market data and the model's arm-rate results. The 3% NVDA is APR net of
  borrowing cost.
- [`IMPROVEMENT_PLAN.md`](IMPROVEMENT_PLAN.md) — prioritized handoff plan for the
  next agent: correctness, no-swap inventory, fee/IL rule, widths/skew, tail test.

## Layout

```
research/cadcad/allocator/
  model.py       cadCAD state / policies / SUFs / PSUBs / run_model
  allocator.py   port of scripts/keeper/allocator.mjs
  lp.py          concentrated-liquidity math (stats.mjs / simulate_hook.mjs)
  scenario.py    scenario load + block bootstrap
  run.py         validation, baseline, sweep, optimize, Monte Carlo, export
  eth_compare.py ETH/NVDA vs USDG/NVDA fee/IL/price/total decomposition
  build_dashboard.py  standalone HTML dashboard
  build_scenario_dashboard.py  light presentation dashboard (single pools vs allocator)
  build_simple_dashboard.py  public comparison: 0.05/0.30 pools vs us vs HODL
  run_recommended_100k.py  run + export the $100k recommended timeline
  run_comparison_100k.py  export 0.05/0.30/us/HODL paths at $100k
  run_pool030_cases.py  0.30-pool case sweep: volume, share cap, rule, capital
  run_split_cases.py  two-sleeve 0.05/0.30 split sweep and optimal-weight rule
  run_fee_break_even.py  fee-ratio break-even map and check/move function
  build_scenario_lab.py  interactive scenario lab (market presets + strategy grid)
  tests/         76 tests
  data/          scenario_45d.json (generated, local-only)
  out/           validation.json, baseline_*, sweep_*, optimize_*, mc_*, dashboard.html (generated)
```

## Build the scenario

The scenario is generated from the local swap tapes and is intentionally not
committed (the raw data is ~1 GB):

```powershell
node scripts/research/build_allocator_scenario.mjs --guard-bps 200
# writes research/cadcad/allocator/data/scenario_45d.json (1,080 hours, ~6 MB)
```

Book A is the V3 USDG/NVDA 0.05% tape used as a fee-equivalent proxy because the
downloaded set has no V4 USDG/NVDA 0.05% pool. Book B is the real V4 USDG/NVDA
0.30% pool. The extractor stores, per book and hour: price/tick, volume, pool
fee moments `Σ volume/L` and `Σ volume/L²`, 60 minute rows, 12 five-minute
moves, and the trailing 36-minute risk stats.

## Environment

```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\klaad\.config\opencode\skills\cadcad-simulation\scripts\setup.ps1 -ProjectDir research\cadcad\allocator
```

Or install the pinned set directly:

```powershell
research\cadcad\allocator\.venv\Scripts\python.exe -m pip install -r research\cadcad\allocator\requirements.txt
```

The verified environment is cadCAD 0.5.3, Python 3.12.10, pandas 3.1.0,
numpy 2.5.4, pytest 9.1.1.

## Run

```powershell
$py = "research\cadcad\allocator\.venv\Scripts\python.exe"

# tests
& $py -m pytest -q research\cadcad\allocator\tests

# static validation against the prior research sim
& $py research\cadcad\allocator\run.py validate

# 34 policies x 45d and last 20d
& $py research\cadcad\allocator\run.py baseline

# one-at-a-time sensitivity (arm rates, caps, risk, interval, guard, LTV, gas, capital)
& $py research\cadcad\allocator\run.py sweep

# inventory/swap/recenter/width/fee-IL optimisation table (45d and 20d)
& $py research\cadcad\allocator\run.py optimize

# $100k-$2M scaling check with exact fee shares
& $py research\cadcad\allocator\run.py large

# 20-path bootstrap of the baseline vs the in-sample best configs (45d and 20d)
& $py research\cadcad\allocator\run.py mc-optimize --opt-paths 20

# 30 paired block-bootstrap paths (10k floor; repeat with --risk-min-volume 15000)
& $py research\cadcad\allocator\run.py mc --mc-paths 30
& $py research\cadcad\allocator\run.py mc --mc-paths 30 --risk-min-volume 15000

# ETH/NVDA vs USDG/NVDA decomposition and the standalone dashboard
& $py research\cadcad\allocator\eth_compare.py --eth-usd-change 0
& $py research\cadcad\allocator\build_dashboard.py
& $py research\cadcad\allocator\build_scenario_dashboard.py
& $py research\cadcad\allocator\run_recommended_100k.py
& $py research\cadcad\allocator\run_comparison_100k.py
& $py research\cadcad\allocator\build_simple_dashboard.py
& $py research\cadcad\allocator\build_scenario_lab.py
# open research\cadcad\allocator\out\dashboard.html
# open research\cadcad\allocator\out\scenario_dashboard.html
# open research\cadcad\allocator\out\simple_dashboard.html
# open research\cadcad\allocator\out\scenario_lab.html

# everything except the dashboard; ~15 minutes
& $py research\cadcad\allocator\run.py all --mc-paths 30
```

Outputs land in `out/`:

- `validation.json` / `.csv` — static fee and net reproduction.
- `baseline_summary.csv`, `baseline_paths.csv`, `baseline.json` — 45d/20d policy
  comparison and per-hour NAV paths.
- `sweep_summary.csv` — one-at-a-time sensitivities.
- `optimize_summary.csv`, `optimize_paths.csv` — inventory/swap/recenter/width/fee-IL
  table and paths.
- `large_nav_summary.csv`, `large_nav.json` — $100k–$2M exact-fee-share scaling.
- `optimize_mc.json` — 20-path bootstrap of baseline vs the in-sample best configs.
- `mc_summary.json` / `.csv` — paired block-bootstrap distribution.
- `scenario_dashboard.html` — light presentation page: single pools, Book A/B/arm,
  allocator scenarios, scaling, risk, validation.
- `simple_dashboard.html` — public 3-block page: Pool 1 vs Pool 2, Our Strategy,
  Morpho Plan. No Book A/B or V3/V4 jargon.
- `recommended_100k_path.csv`, `recommended_100k_summary.json` — $100k timeline
  data for the simple page.
- `comparison_100k_paths.csv`, `comparison_100k_summary.json` — 0.05/0.30/us/HODL
  paths and totals for the full comparison page.
- `pool030_cases.csv`, `pool030_cases.json`, `pool030_cases.html` — 0.30-pool
  volume/cap/rule/capital sweep and the “would it have paid?” report.
- `split_pool_cases.csv`, `split_pool_cases.json`, `split_pool_cases.html` —
  two-sleeve 0.05/0.30 split curves and the optimal-weight rule.
- `fee_break_even.csv`, `fee_break_even.json`, `fee_break_even.html` — fee-ratio
  break-even map, 1.0–2.0× fine grid, and the check/move function.
- `scenario_lab.html` + `scenario_lab_data.json` — interactive market presets,
  strategy grid, width grid, single pools, book+arm, risk.

## Validation

Static always-A / always-B, no guard pulls, zero gas, against
`research/out/v3-usdg-nvda-005-fee500-45d.json` and
`research/out/v4-usdg-nvda-030-fee3000-45d.json`:

| Book | Model fees | Research fees | Diff | Model net | Research net |
|---|---:|---:|---:|---:|---:|
| A (V3 0.05% proxy) | $245.65 | $245.19 | +0.19% | +$148.45 | +$147.02 |
| B (V4 0.30%) | $278.25 | $276.26 | +0.72% | +$181.05 | +$179.62 |

The $1.43 net difference is fee-cash timing plus the minute-level share
approximation. The model is reproducing the same LP economics, not a different
book.

## Headline results

45 days, $10k NAV, user arm case 3% USDG / 3% NVDA / 3% borrow, 200 bps pull
proxy, no warmup, 90% funding:

| Policy | Final NAV | Net vs HODL | Max DD | Fees | Arm interest | Arms hours | Actions |
|---|---:|---:|---:|---:|---:|---:|---:|
| HODL | $9,683.01 | $0.00 | −6.7% | $0 | $0 | 0 | 0 |
| Always A | $9,831.46 | +$148.45 | −5.7% | $245.65 | $0 | 0 | 0 |
| Always B | $9,864.06 | +$181.05 | −5.7% | $278.25 | $0 | 0 | 0 |
| Always arms | $9,695.88 | +$12.87 | −6.6% | $0 | $7.54 | 1,080 | 84 |
| **Allocator as built** | $9,676.37 | **−$6.64** | −7.1% | $7.07 | $7.38 | 1,056 | 78 |
| Fixed, net-APR gate | $9,663.30 | −$19.71 | −7.3% | $5.38 | $7.37 | 1,067 | 318 |
| **Risk-only A** | **$9,874.05** | **+$191.04** | **−5.2%** | **$187.92** | **$1.11** | **269** | **276** |
| Risk-only B | $9,689.36 | +$6.35 | −6.6% | $0.09 | $7.53 | 1,079 | 314 |
| Risk-only A, live arm | $9,873.19 | +$190.18 | −5.2% | $187.92 | $0.38 | 269 | 276 |
| Risk-only A, caps 50% | $9,889.26 | +$206.25 | −5.1% | $190.51 | $1.87 | 274 | 280 |
| **Risk-only A, volume 15k** | **$9,997.14** | **+$314.13** | **−4.3%** | **$231.89** | **$1.35** | **341** | **343** |
| **Risk-only A, 2h/15k/75%** | **$10,114.37** | **+$431.36** | **−4.4%** | **$280.40** | **$1.56** | **408** | **210** |
| **C: 3k base / 500 guard / 2.5k skew** | **$10,195.07** | **+$512.06** | **−4.5%** | **$338.07** | **$1.54** | **406** | **209** |

Last 20 days (NVDA −9.6%):

| Policy | Net vs HODL | Max DD | Arms hours |
|---|---:|---:|---:|
| HODL | $0.00 | −6.5% | 0 |
| Always A | −$146.21 | −7.9% | 0 |
| Always B | −$151.13 | −7.9% | 0 |
| Always arms | +$4.97 | −6.5% | 480 |
| Allocator as built | +$4.06 | −6.5% | 479 |
| Fixed, net-APR gate | −$0.46 | −6.5% | 476 |
| **Risk-only A** | **−$105.62** | **−7.6%** | **222** |
| Risk-only B | +$2.60 | −6.5% | 479 |
| Risk-only A, live arm | −$106.09 | −7.7% | 222 |
| Risk-only A, caps 50% | −$9.44 | −6.9% | 225 |
| **Risk-only A, volume 15k** | **+$28.23** | **−6.6%** | **275** |
| **Risk-only A, 2h/15k/75%** | **+$46.94** | **−6.7%** | **342** |
| **C: 3k base / 500 guard / 2.5k skew** | **+$81.76** | **−6.7%** | **338** |

The risk-only A 20d result is **negative** at the production $10k volume floor.
The earlier first-pass +$42.89 was not keeper-matching: it used a 6-hour warmup,
100% funding on re-entry, and mixed price/tick marks. The corrected model uses
no warmup, 90% of idle on re-entry, one tick mark, event-based guard pulls, and
the liquidation/bad-debt and borrow-APR rules. The $15k volume floor is the one
setting that is positive in both windows. C is the in-sample best, but its
20-path bootstrap p05 is −$607/−$159 vs always-A −$507/−$85; it is a tail-risk
trade, not a robust improvement. See “Optimisations and bootstrap” below.

The in-sample 45d result is not a robust alpha. In a 30-path fixed-length block
bootstrap of the same 45-day tape, the production-floor risk-only A beats
always-A in only **36.7%** of paired paths (median paired difference **−$28.32**,
mean **−$25.03**), and its p05 drawdown is slightly better (−17.20% vs −17.68%).
The 15k-floor variant improves the median and win rate but still loses to
always-A in 60% of paths:

| Metric | Risk-only 10k | Risk-only 15k | Always A |
|---|---:|---:|---:|
| Net vs HODL median | +$68.06 | +$75.52 | +$46.17 |
| Net vs HODL p05 / p95 | −$512.61 / +$249.44 | −$512.90 / +$252.71 | −$525.70 / +$327.85 |
| Mean net | −$16.10 | −$11.38 | +$8.93 |
| Paired diff vs always A, median [p05, p95] | −$28.32 [−$166.63, +$81.55] | −$32.30 [−$173.14, +$144.09] | — |
| Paired win rate vs always A | 36.7% | 40.0% | — |
| Max DD median / p05 | −7.92% / −17.20% | −7.80% / −17.13% | −7.90% / −17.68% |

## Does the 1-hour check stand?

| Cadence | 45d net | 20d net | 45d DD | 45d gas | Actions 45/20 |
|---|---:|---:|---:|---:|---:|
| 1h (current) | +$191.04 | −$105.62 | −5.2% | $5.52 | 276 / 229 |
| 2h | +$325.65 | +$29.59 | −4.1% | $3.34 | 167 / 160 |
| 4h | +$204.83 | −$130.04 | −4.9% | $1.94 | 97 / 97 |
| 8h | +$225.07 | −$57.04 | −4.6% | $0.82 | 41 / 41 |
| 2h + 15k + 75% guard | **+$431.36** | **+$46.94** | −4.4% | $4.20 | 210 / 177 |

The 1h check is defensible but not optimal on this tape. 2h reduces churn and improves both
windows in-sample; 4h/8h are too slow in the 20d. The guard still rechecks every 5 minutes; only
the allocator decision cadence changes. The 2h/15k/75% combination is the in-sample best. Test 2h
on a fresh tape before changing production.

## Guard share: fees vs IL

| Guard share | 45d net | 20d net | 45d DD | 20d DD |
|---|---:|---:|---:|---:|
| 0% (all base) | +$44.45 | −$13.91 | −6.3% | −6.7% |
| 25% | +$112.68 | −$61.70 | −5.8% | −7.2% |
| 50% (production) | +$191.04 | −$105.62 | −5.2% | −7.6% |
| 75% | +$273.69 | −$127.14 | −4.5% | −7.9% |
| 75% + 2h + 15k | **+$431.36** | **+$46.94** | −4.4% | −6.7% |

The guard does **not** prevent IL. It concentrates fees in the narrow band; more guard means more
45d fees and worse 20d drawdown in a down move. The 75% guard only works in the 20d when combined
with the 2h and $15k filters. The 5-minute pull proxy is a separate stress: 50 bps is
−$13.00 / +$19.45, 100 bps +$134.74 / −$130.42, 200 bps +$191.04 / −$105.62, 300 bps +$191.04 (45d;
no 20d row). The `.env` 50 bps is a `recheckGuard` re-arm band, not this pull proxy; the actual
hook EV pull is not observable from the tape.

## Spiral arm: 30% vs 35% LTV

| Arm / LTV | 45d net | 20d net | 45d max LTV | 20d max LTV | 45d NVDA yield | 45d USDG interest | 45d borrow |
|---|---:|---:|---:|---:|---:|---:|---:|
| Risk-only 29.375% | +$191.04 | −$105.62 | 29.4% | 29.4% | $0.15 | $1.11 | $0.00 |
| Risk-only 30% | +$191.04 | −$105.62 | 30.0% | 30.0% | $0.15 | $1.11 | $0.00 |
| Risk-only 35% | +$191.04 | −$91.44 | 35.0% | 35.0% | $0.15 | $1.11 | $0.00 |
| Always arms 29.375% | +$12.87 | +$4.97 | 33.7% | 32.0% | $9.88 | $7.54 | $2.31 |
| Always arms 30% | +$12.87 | +$4.97 | 34.4% | 32.6% | $9.88 | $7.54 | $2.31 |
| Always arms 35% | +$12.82 | +$4.96 | 40.1% | 38.1% | $9.88 | $7.54 | $2.75 |

The 3% NVDA is a Spiral **total** yield on the collateral, **APR after borrowing cost**, not a
native Morpho yield. The model grosses it up by LTV×borrow APR and subtracts borrow, so the net
NVDA contribution is 3% APR. The full always-arms loop earns ~$9.88 of grossed-up NVDA and ~$7.54
of USDG interest; after $2.31 borrow and $1.68 gas, net carry is ~$13.43 and net vs HODL is
**+$12.87**. The risk-only allocator holds the collateral only briefly, so its NVDA contribution is
~$0.15. At 35% LTV the extra 5% debt is roughly carry-neutral at a 3% borrow / 3% lend spread but
drifts max LTV to **40.1%** and adds liquidation risk without lifting the net NVDA yield. Keep the
29.375%/30% target and add a continuous 30% LTV sentinel if the "<30%" rule is hard.

## ETH/NVDA vs USDG/NVDA

Same NVDA, different quote. The ETH/NVDA books are a separate quote-asset comparison, not the
USDG allocator (whose arms are USDG).

| Book | Quote | Fee APR | IL APR | Net APR | NVDA price (window) | HODL basket APR | Total APR | Total (window) | Guard in range |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| USDG V3 0.05% | USDG | 19.9% | −8.0% | 11.9% | −6.37% | −25.8% | −13.9% | −1.72% | 91.4% |
| USDG V4 0.30% | USDG | 22.4% | −7.8% | 14.6% | −6.32% | −25.7% | −11.1% | −1.37% | 92.0% |
| USDG V4 0.01% | USDG | 11.5% | −2.2% | 9.3% | −3.25% | −14.2% | −4.9% | −0.56% | 70.1% |
| ETH V3 0.05% | WETH | 40.4% | −1.8% | 38.7% | −3.03% | −12.3% | 26.3% | +3.25% | 68.5% |
| ETH V3 0.30% | WETH | 39.5% | −1.7% | 37.8% | −2.93% | −11.9% | 26.0% | +3.20% | 74.9% |
| ETH V4 0.05% | WETH | 30.3% | −1.8% | 28.5% | −3.08% | −12.5% | 16.0% | +1.97% | 66.0% |

The identity is `total = fee + IL + HODL`, with IL negative. The ETH book's **NVDA price fell
only ~3% in ETH** vs ~6.3% in USDG, and its **fees are ~2×** the USDG book; its IL is ~4× smaller.
That is why the ETH book's total is +2.0 to +3.3% in ETH while the USDG book is −1.4 to −1.7% in
USDG. The ETH book wins in ETH unless ETH/USD falls more than the breakeven: about **−4.8%** for
the V3 0.05 pair, −4.4% for V3 0.30 vs V4 0.30, −3.6% for V4 0.05 vs the USDG 0.05 proxy. The
ETH/USD series is not in the swap tapes; the dashboard has a slider for the translation.

## Rewards: book vs arm

The P&L identity is `net = book fees + arm USDG + NVDA yield − borrow − gas − swap −
liquidation + LP mark/timing`.

| Run | Window | Book fees | Arm USDG | NVDA yield | Borrow+gas+swap | Net carry | Book fee APR | Carry APR | LP mark/timing | Net vs HODL |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Risk-only 1h/10k/50 | 45d | $187.92 | $1.11 | $0.15 | $5.52 | $183.66 | 15.2% | 14.9% | +$7.38 | +$191.04 |
| Risk-only 1h/10k/50 | 20d | $71.59 | $0.47 | $0.18 | $4.58 | $67.65 | 13.1% | 12.4% | −$173.27 | −$105.62 |
| A: 2h/15k/75 | 45d | $280.40 | $1.56 | $0.13 | $4.20 | $277.89 | 22.7% | 22.5% | +$153.47 | +$431.36 |
| A: 2h/15k/75 | 20d | $148.99 | $0.74 | $0.18 | $3.54 | $146.37 | 27.2% | 26.7% | −$99.42 | +$46.95 |
| C: 3k/500/skew | 45d | $338.07 | $1.54 | $0.11 | $4.18 | $335.54 | 27.4% | 27.2% | +$176.53 | +$512.06 |
| C: 3k/500/skew | 20d | $207.69 | $0.73 | $0.13 | $3.52 | $205.03 | 37.9% | 37.4% | −$123.26 | +$81.77 |
| Always A | 45d | $245.65 | $0 | $0 | $0 | $245.65 | 19.9% | 19.9% | −$97.20 | +$148.45 |
| Always A | 20d | $62.44 | $0 | $0 | $0 | $62.44 | 11.4% | 11.4% | −$208.65 | −$146.21 |
| Always arms | 45d | $0 | $7.54 | $9.88 | $3.99 | $13.43 | 0.0% | 1.1% | −$0.56 | +$12.87 |
| Always arms | 20d | $0 | $3.33 | $4.20 | $2.30 | $5.23 | 0.0% | 0.95% | −$0.25 | +$4.97 |

The book is 99%+ of carry. The 3% NVDA is **APR after borrowing cost**: the model grosses it up by
LTV×borrow APR and then subtracts borrow, so the net NVDA contribution is 3% APR. The arm adds only
~$1.7 over 45d in the risk-only allocator; the full always-arms loop earns ~$17.4 gross but only
~$13.4 net carry after borrow/gas and the collateral mark. The 3% NVDA is not the driver.

## Inventory, swaps, and re-centering

After a recall the book re-funds only **$6.1k–$6.8k of ~$10k** because the
recalled token ratio no longer matches the LP. There are three ways to handle it:

| Case | 45d net | 20d net | 45d fees | 20d fees | 45d end idle | 20d end idle |
|---|---:|---:|---:|---:|---:|---:|
| Baseline 1h/10k/50 (no swap) | +$191.04 | −$105.62 | $187.92 | $71.59 | $3,397 | $2,036 |
| Swap-to-fund, 10 bps | +$186.96 | −$102.35 | $274.79 | $78.62 | $1,077 | $922 |
| Swap-to-fund, 30 bps | +$184.52 | −$102.64 | $274.79 | $78.62 | $1,075 | $922 |
| Inventory skew 2,000 (base 6k) | +$175.56 | −$114.85 | $199.27 | $78.75 | $2,076 | $977 |
| Re-center at 500 bps | +$62.54 | −$87.57 | $185.67 | $90.17 | $5,561 | $5,047 |
| A: 2h/15k/75 | +$431.36 | +$46.94 | $280.40 | $148.99 | $4,906 | $2,265 |
| B: A + base 3k + skew 2.5k | +$460.60 | +$69.13 | $316.45 | $175.96 | $3,579 | $965 |
| C: B + guard 500 | **+$512.06** | **+$81.76** | $338.07 | $207.69 | $4,655 | $1,002 |
| D: C + 80% guard | +$536.60 | +$75.78 | $339.39 | $207.29 | $5,357 | $1,521 |

**Swap-to-fund does not make it better.** It deploys the idle cash and raises fees
$188 → $275, but net falls $191 → $187: the extra capital buys IL (the LP
mark/timing residual goes from +$7 to −$82). **Inventory skew** uses the recalled
token without swapping and raises fees to $338 and net to $512/$82 in-sample. It
does not eliminate price risk; it moves the depreciated NVDA into the vault's
inventory, so the NAV still moves with NVDA. **Re-centering at 500 bps is worse**
(+$63) because it realizes IL and churns; 1,000 bps never triggers on this tape.
The existing risk-based recall/re-fund is the better readjust trigger.

### No-swap 50/50 re-add + surplus NVDA sweep

The direct “re-add 50/50 with what we have, keep a reserve, push excess NVDA to the arm”
case is modelled as `surplus_sweep=True`:

| Case | 45d net | 20d net | 45d fees | 20d fees | 45d arm+NVDA | 20d arm+NVDA | 45d end idle | 20d end idle |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| A: 2h/15k/75 | +$431.36 | +$46.95 | $280.40 | $148.99 | $1.70 | $0.93 | $4,906 | $2,265 |
| A + surplus sweep | +$430.73 | +$46.87 | $280.40 | $148.99 | $1.87 | $0.99 | $4,906 | $1,776 |
| C: skew + guard 500 | +$512.06 | +$81.77 | $338.07 | $207.69 | $1.65 | $0.86 | $4,655 | $1,002 |
| C + surplus sweep | +$511.42 | +$81.77 | $338.07 | $207.69 | $1.83 | $0.86 | $4,655 | $1,002 |
| **C no-skew + sweep (50/50 re-add)** | **+$496.84** | **+$50.72** | **$307.95** | **$174.26** | **$1.82** | **$1.03** | **$5,927** | **$1,927** |
| C + sweep + 50% caps | +$517.07 | −$70.34 | $342.17 | $43.23 | $3.48 | $2.62 | $4,630 | $9,417 |

The **reserve/no-swap 50/50 re-add works**, but the **surplus-to-arm sweep does not pay at
$10k**: the 20% arm cap is already full, the 3% net NVDA yield is too small to compensate
for holding NVDA through a down move, and raising caps to 50% collapses the 20d
(−$70.34). The sweep adds actions without net. Keep the reserve and the skew; leave the
excess idle rather than force it into the arm. The sweep becomes interesting only at
larger capital or a higher verified Spiral yield, with a tail hedge.

## Fee/IL rule

The binary “fee > IL” check is not the binding constraint on this tape; the
5-minute guard never pulls at 200 bps. A **fee/IL hurdle with a longer window,
buffer and hysteresis** is better than a raw trigger:

- 24h fee/IL window, 250 bps buffer, 8h confirmation: 45d **+$302.11**, 20d
  **+$19.47**, DD -4.4%/-6.7% (vs baseline +$191/-$106, DD -5.2%/-7.6%).
- It does **not** beat the 2h/15k/75 combo (+$431/+$47) or C (+$512/+$82).
- Pulling the guard on a guard-specific fee/IL signal is worse (−$9/−$31): it
  churns 136–225 pulls and collapses fees to $50–60. The 5-minute move guard is
  better on this tape.
- The practical equation is `fee_APR_24h > k·|IL_APR_24h| + buffer` with `k=1–1.5`,
  `buffer≈250 bps`, confirmed for several hours, plus gas/re-arm cost. Do not
  lower it to a raw one-hour `fee > IL` check.

## Optimisations and bootstrap

In-sample the biggest fee levers are **base width 3,000** (vs 6,000), **guard
width 500** (vs 600), **guard share 75–80%**, and the **inventory skew**. C is
the in-sample best: +$512.06 / +$81.76, same DD as A (−4.5%/−6.7%).

But the 20-path block bootstrap says this is a tail-risk trade, not alpha:

| 20 paths | 45d median | 45d p05 | 45d win vs A | 20d median | 20d p05 | 20d win vs A |
|---|---:|---:|---:|---:|---:|---:|
| Risk-only 1h/10k/50 | +$168.19 | −$473.37 | 30% | +$64.42 | −$78.37 | 25% |
| A: 2h/15k/75 | +$185.59 | −$552.51 | 30% | +$47.47 | −$133.92 | 35% |
| C: 3k/500/skew | +$220.62 | **−$607.47** | 45% | +$68.43 | **−$158.65** | 50% |
| D: C + 80% guard | +$218.04 | **−$626.16** | 55% | +$71.37 | **−$161.64** | 50% |
| Always A | +$214.16 | −$506.67 | — | +$79.33 | −$85.01 | — |

C/D have a similar median and a higher win rate than always-A, but a much worse
p05 and a lower mean (C +$12.5/+$44.5 vs always-A +$27.2/+$49.1). That is the
inventory/tail-risk cost: more NVDA in the vault wins more often but loses more in
bad paths. **Always-A has the best mean and p05.** The 1h/10k/50 risk-only has a
slightly better p05 than always-A but a lower mean; it is a defensive allocation,
not an alpha strategy. Do not deploy C/D as a return optimization without a
tail hedge or a smaller inventory skew.

## Large NAV: $100k / $250k / $500k / $1M / $2M

At large books the second-order fee share is no longer safe. The model now has
`fee_share_mode="exact"`:

```
fee = rate × volume × L/(poolL+L),  poolL = volume/volOverL
```

`run.py large` runs always-A, always-B, risk-only, A, and C at $100k–$2M with
scaled absolute arm caps, live $15k borrow liquidity, and exact fee shares.

| NAV | Always A 45d net / APR | Always B 45d net / APR | C 45d net / APR | C 20d net / APR | Book B L/pool |
|---|---:|---:|---:|---:|---:|
| $100k | +$1,451 / 11.8% | +$1,511 / 12.3% | +$4,248 / 34.5% | −$690 / −12.6% | 2.1% |
| $500k | +$6,579 / 10.7% | +$3,608 / 5.9% | +$20,679 / 33.6% | −$10,208 / −37.3% | 10.7% |
| $1M | +$11,742 / 9.5% | +$2,473 / 2.0% | +$40,164 / 32.6% | −$21,155 / −38.6% | 21.3% |
| $2M | +$19,036 / 7.7% | **−$3,726 / −1.5%** | +$76,349 / 31.0% | **−$44,405 / −40.5%** | 42.7% |

Annualized: 45d ×8.111, 20d ×18.25.

- **Book A scales.** At $1M/$2M it is ~1–2% of its pool; book fee APR holds at
  ~17.4%/15.6% vs 19.9% at $10k. Always-A stays positive.
- **Book B does not scale.** At 21%/43% of the pool, the exact share saturates;
  always-B turns negative at $2M. Cap Book B around $250k–$500k.
- **C is positive over 45d but negative over the 20d** at $1M/$2M. The $10k 20d
  +$81.77 does not scale.
- **Arm caps are not the driver.** 20/50/100% caps give nearly the same 1M/2M C
  45d result; the arm is <$1k. Raising caps does not fix scale.
- **Exact fee share is required for Book B**, not for Book A.

## Simple dashboard

For a non-technical audience, use `build_simple_dashboard.py`:

```powershell
$py = "research\cadcad\allocator\.venv\Scripts\python.exe"
& $py research\cadcad\allocator\run_recommended_100k.py
& $py research\cadcad\allocator\run_comparison_100k.py
& $py research\cadcad\allocator\build_simple_dashboard.py
# open research\cadcad\allocator\out\simple_dashboard.html
```

It is a full $100,000 comparison on the same 45-day tape:

1. **Do it yourself** — passive LP in the 0.05 pool and the 0.30 pool.
2. **Deploy to us** — the fee-check strategy at 2× the 0.30 pool's base
   volume: 0.05 / 0.30 / Morpho, with the 0.30 sleeve active 52.4% of hours.
3. **HODL** — hold NVDA and hold USDG for the same $100,000.
4. **Timeline** — real NVDA/USDG price lined up above the value chart, with
   0.05 pool / 0.30 pool / Morpho bands, the strategy’s transitions, fees, IL,
   drawdown and time in each state.
5. **Interactive charts** — drag or scroll to pan, `+`/`−` (or Ctrl/⌘ + wheel)
   to zoom up to 12×, and a right-hand % axis: % vs $100,000 on the value chart,
   % vs the start price on the price chart. Hover/tap for a day-by-day tooltip
   with each path’s value and gain. Deep links: `?zoom=4&at=25`.

No 10k sample, no baseline/improved/aggressive variants, no Book A/B, V3/V4,
ETH, tranche or arm jargon.

## Would the 0.30 pool have paid?

A separate case sweep answers whether allowing the 0.30 pool ever beats staying out:

```powershell
$py = "research\cadcad\allocator\.venv\Scripts\python.exe"
& $py research\cadcad\allocator\run_pool030_cases.py
# open research\cadcad\allocator\out\pool030_cases.html
```

It runs 160 cases: 0.30-pool volume 1–10×, share cap 5–50%, two timing rules,
$50k/$25k volume floors, and $10k–$250k capital. Every case is compared with the
same run that never uses the 0.30 pool. Outputs: `out/pool030_cases.csv`,
`out/pool030_cases.json`, `out/pool030_cases.html`.

Result: on the actual tape no case beats staying out. At 10× volume with a 25%
cap, the 2h rule adds +$4,920 over 45 days and +$258 over the last 20 days; the
4h rule adds +$5,588 but −$38 over the last 20 days. At 1–5× volume, every entry
loses money.

## Should we split between the pools?

The all-or-nothing move self-dilutes the thin pool. A two-sleeve simulation asks
how much should sit in the 0.30 pool at the same time as the 0.05 book:

```powershell
$py = "research\cadcad\allocator\.venv\Scripts\python.exe"
& $py research\cadcad\allocator\run_split_cases.py
# open research\cadcad\allocator\out\split_pool_cases.html
```

160+ two-sleeve runs: 0.30 weight 0–100%, volume 1–10×, 45d and 20d, with exact
fee share `L/(poolL+L)`. Outputs: `out/split_pool_cases.csv`,
`out/split_pool_cases.json`, `out/split_pool_cases.html`.

Result: pool-only, a partial sleeve beats both extremes. On the actual tape the
best split is 43% in the 0.30 pool (+$189 vs all-0.05); 100% 0.30 is −$25 because
it dilutes its own fee share. Against the risk-only strategy, the sleeve is
negative at 1×, breaks even around 1.3× for a 28% sleeve, and adds +$264 at 1.5×
and +$10,064 at 10× (the 28% is the most allowed by the 5% pool-share cap). A
100% sleeve is only 15.6% of the pool, not 100% ownership.

## Fee break-even

The volume gate is a proxy. The direct trigger is the fee ratio:

```powershell
$py = "research\cadcad\allocator\.venv\Scripts\python.exe"
& $py research\cadcad\allocator\run_fee_break_even.py
# open research\cadcad\allocator\out\fee_break_even.html
```

It simulates 1.0–2.0× in 0.1 steps plus 2.5/3/5/10×, and reports the break-even
fee ratio for each sleeve. The 0.30 pool earns 7.77% of the 0.05 pool's fees; a
28% sleeve beats all-0.05 at 6.79%, but needs 9.99% (≈1.29× volume) to beat the
risk-only engine. At 1.5× (11.66%) the 28% sleeve adds +$264, the 43% sleeve
+$318, and 100% only +$65. The check function is
`Delta(w) = m*F_B*s(w) - w*(F_A + H)`, with `H` the risk-only return you give up.

## Presentation dashboard

For a simpler, light-theme display, use `build_scenario_dashboard.py`:

```powershell
$py = "research\cadcad\allocator\.venv\Scripts\python.exe"
& $py research\cadcad\allocator\build_scenario_dashboard.py
# open research\cadcad\allocator\out\scenario_dashboard.html
```

It has six public-facing sections:

1. Every single pool over the 45 days: fees, IL, price/HODL, net, total P&L,
   fee APR, net APR, guard-in-range.
2. Book A vs Book B vs the arm: volume, pool fees, liquidity, single-pool net,
   and the arm’s small contribution.
3. Where the money comes from: book fees + arm − borrow/gas = net carry, then the
   LP mark/timing residual.
4. Allocator scenarios: HODL, always A/B, as-built, baseline, improved
   2h/15k/75%, recommended C skew 1k, aggressive C 2.5k, always arms; 45d/20d.
5. Scaling: $10k–$2M net APR and book fee APR, with Book B saturation.
6. Risk and validation: 20-path bootstrap median/p05/win, fee-match cards, 76 tests.

The existing dark dashboard (`dashboard.html`) remains the full research view.

## Scenario lab (interactive)

For live what-if exploration, use `build_scenario_lab.py`:

```powershell
$py = "research\cadcad\allocator\.venv\Scripts\python.exe"
& $py research\cadcad\allocator\build_scenario_lab.py
# open research\cadcad\allocator\out\scenario_lab.html
# --reuse rebuilds the HTML from out/scenario_lab_data.json without re-running the model
```

It has six tabs:

1. **Market scenarios** — base, volume 2×/3×, fee tier 2×, volume+fee, more arm
   (vol 150), more book (vol 500), Book B volume 10×, arm yield 5%+5%, arm stress.
   Choose a market and strategy; the page shows 45d/20d net, fees, book fee APR,
   drawdown, arm contribution, idle capital, a NAV chart, and a full matrix.
2. **Strategy lab** — allocator interval (1/2/4h), guard share (50/75/80%),
   inventory skew (0/1k/2.5k), with a 27-row grid and a 3×3 width grid
   (base 3k/4k/6k × guard 500/600/900).
3. **Scaling** — $10k–$2M net APR and book fee APR; Book A scales, Book B saturates.
4. **Single pools** — the seven-pool fee/IL/total table and chart.
5. **Book + arm** — Book A/B/arm cards and the rewards waterfall.
6. **Risk & validation** — 20-path bootstrap and the fee-match/test cards.

All runs are precomputed by the cadCAD model; the browser only selects them.
The market multipliers are hypothetical and in-sample. Volume/fee changes are
applied to the tape, not re-downloaded; Book B 10× is a volume-only stress, not
a deeper pool.

## Dashboard

The standalone dashboard is generated from the model outputs:

```powershell
$py = "research\cadcad\allocator\.venv\Scripts\python.exe"
& $py research\cadcad\allocator\eth_compare.py --eth-usd-change 0
& $py research\cadcad\allocator\build_dashboard.py
# open research\cadcad\allocator\out\dashboard.html
```

It includes the NAV simulation, rewards waterfall, inventory/swap/recenter table,
optimisation table, 20-path bootstrap, policy table, interval/guard/LTV tables,
ETH/NVDA decomposition, ETH/USD slider and breakeven. It is self-contained (no
CDN/server).

## What the model found

1. **The as-built allocator has a one-way door into the arms.** The safe-harbor
   check is `!guardPresent` before `decidePoolSwitch`. Once the book is recalled,
   the guard is absent, so the allocator keeps calling `deployToArms` and never
   reaches `returnToBooks`. 1,056 of 1,080 hours in arms (23 funded) in the 45d;
   479 of 480 hours in the 20d. The 20d net is +$4.06, essentially the always-arms
   result; the 45d is −$6.64 after the transition.
2. **The net-APR gate churns.** `allocator.mjs` says “no APR comparison and no
   min-carry rule”, but `tickAllocator` runs `decidePoolSwitch` on a 36-minute
   net APR annualized by 14,600. The fixed variant makes 318/158 actions and
   loses $19.71 (45d) / $0.46 (20d). The documented risk-only design is the
   coherent policy.
3. **The empty-book scan uses a different range than the real book.** The keeper
   scans an empty book with a ±10% hypothetical range and full NAV; the real
   book is ±6,000-tick base / ±600-tick guard. The empty book's annualized IL is
   much larger, so it looks uninvestable. `fix_hypothetical_range` uses the
   actual target sleeve.
4. **The $10k volume floor is too permissive for this tape.** Book A's 36-minute
   volume is usually ~$158k, but the thin/low-fee hours are where the book loses.
   At a **$15k floor** the risk-only A earns **+$314.13 / +$28.23** and keeps
   **$231.89** of 45d fees; at $10k it earns +$191.04 / −$105.62. The 15k variant
   also improves the block-bootstrap median and win rate. This is the strongest
   single lever in the model, but it is still not a proven edge.
5. **Book B is too thin for either floor.** Its 36-minute volume is usually
   ~$700. Risk-only B funds 0 hours in the 20d and is +$6.35 / +$2.60; the
   $1k-floor B variant is −$48.57 / −$3.73 with 756/326 actions. Always-B is
   +$181.05 in the 45d but −$151.13 in the 20d: the fee tier is not a substitute
   for volume.
6. **The `.env.example` 50 bps is not a pull threshold.** `STATIC_RECHECK_MAX_DEV_BPS`
   is the maximum pool-oracle deviation allowed when `recheckGuard` re-deploys;
   the pull itself is EV-simulator based. The model's 50/100/200/300 settings are
   **5-minute move proxies**, not the env parameter. The proxy is non-monotone:
   50 bps is −$13.00 / +$19.45, 100 bps is +$134.74 / −$130.42, 200 bps is
   +$191.04 / −$105.62. The model cannot test the 50 bps re-arm band without a
   Chainlink/oracle series; review the env value against the hook's EV/recheck
   logic and keep 200 as the deploy default.
7. **3% USDG is plausible; 3% NVDA is a Spiral total-yield assumption, not native
   Morpho.** The 3% NVDA is **APR after borrowing cost**: the model grosses it up
   by LTV×borrow APR and subtracts borrow, so the net NVDA contribution is 3% APR.
   In the risk-only A, the NVDA line is **$0.15** over 45d; in the full always-arms
   loop it is **$9.88** grossed up, and the whole arm nets $12.87. The 3% USDG lends
   add **$3.76** over 0%; the live-vs-user difference is $0.86. The risk-only arm
   is mostly the USDG lend arm; the full Spiral/NVDA loop is held only in the
   always-arms benchmark. See [`ARM_REALISM.md`](ARM_REALISM.md).
8. **The 20% arm caps leave ~55% idle in risk-off.** Raising both relative caps
   to 50% gives +$206.25 / −$9.44; 100% is +$206.15 / −$9.44. The 20d improvement
   is mostly book/arm timing and extra fee hours, not the 3% arm yield; the 15k
   floor is the stronger lever. Combining 15k + 50% caps is +$306.33 / +$16.47,
   worse than 15k alone.
9. **The 25% unwind is the robust default.** 2,500 bps: +$191.04 / −$105.62;
   5,000: +$189.08 / −$129.93; 10,000: +$190.88 / −$128.46. The fast unwind
   re-enters the book before the down move and does not help the 20d.
10. **30% LTV is a borrow-time cap, not a continuous cap.** Risk-only A's max LTV
    is 29.37%, so a strict 30% sentinel changes nothing there. Always-arms and the
    as-built allocator drift to 33.68% as NVDA falls. `min_health_factor=2.083`
    (30% LTV) caps the as-built at 30.0% and costs $1.13 (45d) / $0.86 (20d); it
    is the right setting if "<30%" is a continuous rule.
11. **The book, not the arm, is the return engine.** Static always-A earns
    $245.65 of fees and always-B $278.25; risk-only A's arm earns $1.11; even the
    always-arms benchmark earns $7.54 on the same $10k. The best C config earns
    $338.07 of book fees and ~$1.64 of arm+NVDA.
12. **The 1h check is not optimal on this tape, but the bootstrap does not
    validate 2h.** 2h gives +$325.65 / +$29.59 vs +$191.04 / −$105.62 at 1h, with
    167/160 actions vs 276/229 and $3.34 vs $5.52 gas. 4h/8h are too slow in the
    20d. The 2h/15k/75% combination is +$431.36 / +$46.94 in-sample. But its
    bootstrap p05 is −$552.51 / −$133.92 vs baseline −$473.37 / −$78.37; test 2h
    on a fresh tape, do not treat it as proven.
13. **The guard is a fee/IL trade-off, not IL prevention.** Guard share 0/25/50/75
    gives +$44.45 / +$112.68 / +$191.04 / +$273.69 in the 45d and
    −$13.91 / −$61.70 / −$105.62 / −$127.14 in the 20d. The 75% guard only turns
    positive in the 20d when combined with the 2h and $15k filters, and that
    combination has a worse bootstrap p05. The 5-minute pull proxy is a stress,
    not the `.env` re-arm band.
14. **30% LTV beats 35% under the 3% net + 3% + 3% assumptions.** Full-arm
    always-arms: +$12.87 at 30% vs +$12.82 at 35%; max LTV 34.4% vs 40.1%. The
    extra 5% debt is carry-neutral at a 3% borrow / 3% lend spread but adds LTV
    drift and liquidation risk. Keep the 29.375%/30% target and add a continuous
    30% LTV sentinel if the rule is hard.
15. **ETH/NVDA is the better book in its own quote, but it is a different
    quote.** ETH books: fee 30.3–40.4%, IL −1.7 to −1.8%, net 28.5–38.7% ETH,
    total +2.0 to +3.3% ETH. USDG books: fee 19.9–22.4%, IL −7.8 to −8.0%, net
    11.9–14.6%, total −1.4 to −1.7% USDG. The ETH book wins in ETH unless ETH/USD
    falls more than ~4.8%; it is not directly the allocator's arm.
16. **The arm is small; the book is the business.** C earns $338.07 of book fees
    and $1.65 of arm+NVDA over 45d. Always-arms earns $17.42 gross but only $13.43
    net carry (1.1% on NAV, 3% on collateral) after borrow/gas. The 3% NVDA is a
    Spiral total-yield assumption, APR net of borrow, not a native collateral
    yield; at $10k with 20% caps it cannot move the result.
17. **Swap-to-fund is worse than leaving the excess idle.** Fees rise $188 → $275
    but net falls $191 → $187 because the extra capital buys IL (LP mark/timing
    +$7 → −$82). The under-funded book is an accidental inventory buffer.
18. **Inventory skew is a real in-sample lever with a tail.** Base 3k + guard 500 +
    2.5k skew earns +$512.06 / +$81.76 and cuts idle, but the 20-path bootstrap
    p05 is −$607 / −$159 vs always-A −$507 / −$85. The NVDA price depreciation is
    now concentrated in the vault, so it wins more often and loses more in bad
    paths. Re-centering at 500 bps is worse (+$63); 1,000 bps never triggers.
19. **Fee/IL needs a hurdle and hysteresis, not a raw trigger.** 24h window,
    250 bps buffer, 8h confirmation: +$302.11 / +$19.47, DD −4.4%/−6.7% vs
    baseline +$191/−$106. A guard-specific fee/IL pull is a churn failure
    (−$9/−$31, 136–225 pulls, fees collapse to $50–60).
20. **Risk-adjusted ranking: always-A > 1h/10k/50 risk-only > in-sample best.**
    Always-A has the best bootstrap mean (+$27.2/+$49.1) and p05 (−$507/−$85).
    The 1h/10k/50 risk-only has a slightly better p05 than always-A but lower mean
    (−$5.0/+$34.7); it is defensive. C/D have higher win rates but much worse p05.
    Do not deploy C/D as a return strategy without a tail hedge or a smaller skew.
21. **Large NAV: Book A scales, Book B does not.** At $1M/$2M with exact fee
    shares: Always-A +$11.7k/+$19.0k (9.5%/7.7% net APR), Always-B +$2.5k/−$3.7k,
    C +$40.2k/+$76.3k over 45d (32.6%/31.0%) but −$21.2k/−$44.4k over the 20d.
    Book B is 21%/43% of its pool at 1M/2M; cap it at ~$250k–$500k. Book A is
    ~1–2% of its pool; $1M–$2M is feasible in-sample only with a fresh-tape/tail
    test. 20/50/100% arm caps give nearly the same 1M/2M C result; the arm is
    <$1k. Do not linearly extrapolate $10k.

## Model corrections from the independent review

The first pass reported risk-only A at +$213.65 / +$42.89. The independent
`cadcad-reviewer` found six material issues; the corrected model now:

- marks every book at its integer tick, so `NAV_after = NAV_before − costs`
  holds on the real tape (max error <$0.01);
- carries liquidation bad debt as a liability instead of forgiving it, and uses
  a liquidation bonus rather than seizing the whole position;
- clips BORROW at the hard LTV cap in the SUF, gates WITHDRAW on the health
  floor, refuses to withdraw while debt is outstanding, and closes a target book
  before switching onto it;
- funds 90% of idle on re-entry, matching `KEEPER_FUND_BOOK_BPS=9000`;
- applies the keeper's borrow-APR ceiling (`KEEPER_MAX_BORROW_APR_BPS=3000`) and
  10% deleverage step, so the 107% stress market is not a free carry;
- counts one guard pull per hour (the hook emits one `GuardPulled` event) and
  prorates guard fees from the first triggering 5-minute bin;
- removes the 6-hour warmup, which the keeper does not have.

The corrected 20d result is negative at the production volume floor. The $15k
floor is the only setting that stays positive in both windows; the 50% caps is
nearly flat in the 20d (−$9.44). Neither survives the block bootstrap as a
reliable edge.

## Caveats

- Book A is a V3 0.05% proxy; no V4 USDG/NVDA 0.05% pool exists in the
  downloaded set. A real V4 pool will have a different L distribution.
- Both books are marked at the global Book A tick. Book B's own close differs by
  −44..+42 ticks; the B position value differs by up to 0.28% on $10k. The B/A
  ranking is unchanged; a per-book mark is a future refinement.
- Guard pulls are proxied from 5-minute moves, not the hook's EV simulator /
  `recheckGuard` oracle deviation. The 50/100/200/300 cases are pull-proxy
  sensitivities; the `.env` 50 bps re-arm band is untested without an oracle
  series.
- The risk-window fee APR uses minute-level in-range fee moments, not the
  keeper's current `bookShare` × window fees. This is a more accurate estimate
  of what the book earned and reproduces the static research sim, but it can
  differ from the keeper's scan when the guard was out of range. The risk-only
  decision does not use the fee APR; the net-APR variants do.
- Depeg is exogenous; no Chainlink `AnswerUpdated` history. The baseline has
  depeg off; the `depegProxy` is pool-price vs 30m TWAP, not a true depeg.
- Arm rates are scenarios, not a 45-day rate history. Morpho's API is current
  state; the user/live/stress cases are assumptions.
- Both windows are down regimes. The block bootstrap preserves the same regime;
  the model does not prove the strategy works in a bull market.
- The book's target L is fixed from the initial capital; re-funding uses 90% of
  idle and scales down to available tokens by default. The `funding_mode="swap"`
  and `base_skew_mode="inventory"` variants model the rebalance alternatives; the
  swap case assumes 10 bps and no price impact, and the skew is a static range
  shift, not a continuous inventory optimizer.
- The re-center action is a composite of recall + fund with 2× gas; the keeper
  would need two runs or a composite adapter. Re-centering at 500 bps is worse on
  this tape; 1,000 bps never triggers.
- The fee/IL gate uses a 24h rolling window with the current L/range applied to
  the whole window (an approximation). The guard fee/IL pull uses the guard's own
  sleeve; it is a churn failure on this tape and should not be deployed as-is.
- The 20-path optimization MC is a small sample; its p05 is the relevant tail
  statistic, not a precise estimate. The 30-path MC for the baseline is separate.
- Gas $0.02/action; no MEV, slippage, price impact, or failed transactions. At
  $0.50/action the risk-only net falls from +$191.04 to +$58.56.
- The model assumes the allocator executes (`KEEPER_ALLOCATOR_EXECUTE=true`)
  and applies module caps, not the controller's per-call bounds/timelocks.

## Tests

```
76 passed (the real-tape tests skip if data/scenario_45d.json is absent)
```

Coverage: ported keeper vectors, LP position/liquidity/IL math, scenario shape
and fee reproduction, row count/schema, determinism, no input mutation, NAV
conservation on synthetic and real tapes, liquidation bad-debt/no-NAV-creation,
execute-layer LTV/health-floor caps, 90% funding, borrow-APR deleverage, guard
pull/re-arm event semantics and fee timing, guard share/base-only, allocator
interval, 35% LTV cap, HODL, always-arms caps, risk-only return-to-book, ETH/USDG
decomposition, swap funding cost, inventory skew, re-center action, net-of-borrow
NVDA APR, surplus-NVDA sweep/reserve, exact fee-share mode, the rewards identity,
the dashboard and scenario-lab builds, and static fee reproduction on the real
tape.
