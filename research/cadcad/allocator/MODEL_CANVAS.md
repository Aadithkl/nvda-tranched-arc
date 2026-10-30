# Allocator cadCAD model — canvas

Status: built and tested (76 tests). Scenario: 45 days, 1,080 hourly steps, from
1,264,342 V3 USDG/NVDA 0.05% swaps and 30,650 V4 USDG/NVDA 0.30% swaps.

Source of truth: `scripts/keeper/allocator.mjs`, `scripts/keeper/index.mjs`,
`scripts/keeper/stats.mjs`, `src/hook/PoolGuardHook.sol`,
`src/adapters/MorphoLoopAdapter.sol`, `src/adapters/MorphoBlueLendAdapter.sol`.
The model is a port, not a parallel design.

## 1. Purpose

Decide whether the current allocator adds value over simply holding Book A or
Book B, and whether the user assumption of **3% USDG + 3% NVDA + 3% borrow** in
Morpho/Spiral is realistic.

In scope: the hourly risk/decision/move loop, Book A/Book B fee and IL
accounting, guard pulls and re-arms, the Morpho USDG lend arm, the Spiral/NVDA
collateral/borrow arm, arm caps, LTV/health factor, gas, and a HODL benchmark.

Out of scope: transaction-level execution, MEV, price impact of our own swaps,
the vault/controller timelocks, Chainlink depeg calibration, and a full Morpho
rate history. Those are scenario parameters or caveats.

## 2. Boundary and time

- Time step: 1 hour, matching `KEEPER_ALLOCATOR_INTERVAL_SECONDS=3600`.
- Horizon: 45 days = 1,080 steps. The last 20 days = 480 steps is a second
  window.
- Within one step: market mark → book/arm income → risk scan → allocator
  decision → one action → NAV.
- The exogenous market row is the hour's swap tape: price/tick, volume, pool
  active liquidity, minute fee moments, 5-minute moves, and 36-minute risk
  stats.

## 3. Actors and roles

| Actor | Model representation | Objective / constraint |
|---|---|---|
| Vault / NAV | `portfolio` + `nav` | Maximise net of fees, IL, arm carry, gas; keep LTV < 30% at borrow |
| Keeper / allocator | `p_decision` | One action per hour; risk high → arms; risk normal → book |
| Book A | `books[0]` | V4 0.05% fee book; V3 0.05% tape proxy |
| Book B | `books[1]` | V4 0.30% fee book |
| PoolGuardHook | `book.base_*`, `book.guard_*`, `guard_present` | Base ±6,000 ticks, guard ±600 ticks, guard pull on >200 bps 5-min move |
| Morpho USDG lend arm | `arm.usdg_lent` | Supply APY; capped by absolute and relative caps |
| Spiral/NVDA arm | `arm.nvda`, `arm.debt` | Collateral/borrow; target 29.375% LTV, hard 30% at borrow |
| Morpho market | `borrow_liquidity_usd`, rates | Borrow liquidity, borrow APY, supply APY |

## 4. Environment (exogenous)

Per hour and per book:

- `price`, `tick`, `sqrtP`: Book A's close (highest-frequency tape); Book B uses
  its own risk ticks for its own IL.
- `volumeUsd`, `volOverL = Σ volume/L_pool`, `volOverL2 = Σ volume/L_pool²`.
- `poolLMean`, `poolLLast`, `poolLiquidityUsd = 2L/sqrtP` (virtual active value,
  used only for the thin-pool gate).
- `minutes`: 60 minute-level `{tick, volume, volOverL, volOverL2}` rows.
- `fiveMinMoves`: 12 five-minute absolute price moves (bps) for the guard.
- `risk`: trailing 36-minute volume, volatility, tick first/last, fee moments,
  pool liquidity.
- `depegProxy`: pool-price-vs-30m-TWAP dislocation proxy; depeg is exogenous and
  off by default.
- Arm rates and borrow liquidity: scenario parameters (user / live / stress).

## 5. Mechanisms

1. **Fee share.** The book's share is `L_book/(L_pool+L_book)`, expanded to
   second order:
   `fee = fee_pips/1e6 × (L×V1 − L²×V2)`.
   The minute path splits guard-in, base-only, and out-of-range minutes, so a
   pulled or out-of-range guard earns nothing while the base keeps earning.
   For large books (`fee_share_mode="exact"`), the model uses the exact
   `fee = rate × volume × L/(poolL+L)` with `poolL = volume/volOverL`, because
   the expansion is unsafe once `L_book/poolL` is more than ~5–10%.
2. **IL.** The book's actual base range is used for the risk scan; the accounting
   is mark-to-market of the base and guard token amounts. There is no separate
   IL cash flow.
3. **Guard.** A 5-minute move above the `guard_pull_threshold_bps` **proxy**
   (not the `.env` re-arm band) pulls the guard: its tokens return to idle,
   `guard_present=false`, and the allocator sees the guard-absent signal. After
   `guard_rearm_delay_hours` the guard is re-armed around the current tick with
   the target L, scaled to available tokens.
4. **Allocator.** Risk HIGH if depeg, guard absent, volatility ≥ 300 bps, or
   volume < $10k. The keeper's `>2 GuardPulled` event check is modelled, but with
   one pull per hour it is unreachable in the model; the guard-absent check is
   binding. HIGH recalls the book and deploys to the arms; normal risk may hold,
   switch, or return. One action per allocator interval (default 1h; 2h/4h/8h
   are modelled as the same tape with fewer decisions).
5. **Arm entry.** USDG first (80% target), NVDA in 10% slices, then borrow at
   29.375% LTV, then allocate borrowed USDG. Caps: 20% relative and $10k
   absolute per arm in the baseline. The book's guard share is 50/50 by default;
   0/25/75% guard mixes are modelled. 30% and 35% absolute LTV arm cases are
   modelled for the Spiral sensitivity.
6. **Arm exit.** Repay debt first, withdraw NVDA in 25% slices, deallocate USDG
   in 25% slices, then fund the book with 90% of idle.
7. **Switch.** Atomic recall of the old book and funding of the new book; one
   hour dwell, 0 bps switch cost by default.
8. **Liquidation.** If HF < 1.0, a liquidation repays debt and seizes collateral
   at a bonus; the vault keeps residual collateral, and any shortfall beyond the
   lend arm is carried as `bad_debt` (a liability). A sentinel repays 10% of debt
   per tick when HF < `min_health_factor` or the borrow APR exceeds
   `max_borrow_apr_bps`.
9. **Funding mode.** `scale` (default) uses what both idle balances allow and
   leaves the excess idle. `swap` fills a one-sided deficit at `swap_cost_bps`
   (default 0; tested 10/30/50) so the book can be fully funded. The swap cost is
   reflected in the token balances and recorded in `cum.swap_cost`.
10. **Inventory skew.** `base_skew_mode="inventory"` shifts the base centre by up
    to `base_skew_max_ticks` to match the recalled token ratio, maximizing the
    deployed book value without a swap. The guard stays centred on the market.
    The shift is chosen at funding time; it is a static range, not a continuous
    inventory optimizer.
11. **Re-center.** If `recenter_threshold_bps>0` and price has moved that far from
    `entry_tick`, `RECENTER_BOOK` recalls and re-funds the book at the current
    tick in one composite action (2× gas). This realizes IL; the 500 bps case is
    worse on the tape and 1,000 bps never triggers.
12. **Fee/IL gate.** `risk_fee_il` holds the book only while `fee_APR −
    fee_il_hurdle×|IL_APR| ≥ fee_il_buffer_bps`, using a `fee_il_window_hours`
    rolling window and `fee_il_confirm_hours` hysteresis. `guard_rule="fee_il"`
    can pull the guard on the guard's own sleeve fee/IL; it churns on this tape.
    `rearm_gate` delays re-arming the guard until the book-level gate recovers.
13. **Net-of-borrow NVDA APR.** If `nvda_apr_is_net=True`, the 3% is treated as
    APR after borrowing cost. The effective NVDA rate is
    `nvda_apr + LTV×borrow_apr`, then borrow cost is subtracted, so the net NVDA
    contribution is the stated 3% APR of collateral.
14. **Surplus sweep.** `surplus_sweep=True` keeps a reserve
    (`inventory_reserve_usd` or `inventory_reserve_pct×NAV`) of both tokens for the
    next 50/50 re-add. Excess NVDA is pushed to the Spiral collateral arm, then
    borrowed at the LTV target, then excess USDG is lent. One action per run; the
    book is never swapped or force-balanced. On this tape the reserve/50-50 part
    helps but the sweep is neutral-to-negative at 20% caps.

## 6. State

| State | Type | Units | Initial | Writer |
|---|---|---|---|---|
| `step` | int | hour index | 0 | `s_step` |
| `env` | dict | scenario row | row 0 | `s_env` |
| `portfolio` | dict | USD / token units | see below | `s_portfolio_income`, `s_portfolio_execute` |
| `book_metrics` | list[dict] | bps / USD | `[]` | `s_book_metrics` |
| `decision` | dict | action | `INIT` | `s_decision` |
| `nav` | float | USD | initial NAV | `s_nav` |
| `hodl_nav` | float | USD | initial NAV | `s_hodl_nav` |
| `peak_nav` | float | USD | initial NAV | `s_peak_nav` |
| `metrics` | dict | mixed | `{}` | `s_metrics` |
| `last_events` | list[dict] | event log | `[]` | `s_last_events` |
| `event_count` | int | count | 0 | `s_event_count` |

`portfolio`:
`active_book`, `books[2]`, `idle_usdg`, `idle_nvda`, `arm{nvda,debt,usdg_lent,bad_debt}`,
`mode`, `last_action`, `last_reason`, `last_events`, `last_costs`,
`nav_before`, `nav_after`, `hodl{usdg,nvda}`, `cum{fees, guard_fees,
arm_interest, borrow_cost, nvda_yield, gas, switch_cost, swap_cost,
liquidation_loss, guard_pulls, actions}`.

`book`:
`deployed`, `base_L`, `guard_L`, `base_lo/hi`, `guard_lo/hi`, `entry_tick`,
`base_skew_ticks`, `fees`, `guard_present`, `last_pull_step`, `target_base_L`,
`target_guard_L`, `cum_fees`.

## 7. Policies and SUFs

| PSUB | Policy | SUF(s) | Reads | Writes |
|---|---|---|---|---|
| 1 market | `p_market` | `s_env` | `step`, scenario | `env` |
| 2 income | — | `s_portfolio_income` | `env`, `portfolio`, `step` | `portfolio` |
| 3 marks | `p_marks` | `s_book_metrics` | `portfolio`, `env` | `book_metrics` |
| 4 decision | `p_decision` | `s_decision` | `book_metrics`, `portfolio`, `env` | `decision` |
| 5 execute | — | `s_portfolio_execute` | `portfolio`, `env`, `decision` | `portfolio` |
| 6 nav | — | `s_nav`, `s_hodl_nav`, `s_peak_nav` | `portfolio`, `env` | `nav`, `hodl_nav`, `peak_nav` |
| 7 metrics | — | `s_metrics`, `s_last_events`, `s_event_count`, `s_step` | `portfolio`, `env`, `book_metrics`, `decision`, `nav`, `peak_nav` | `metrics`, `last_events`, `event_count`, `step` |

Policies never mutate state. SUFs deep-copy the portfolio before writing. Two
SUFs never write the same variable in the same PSUB.

## 8. Equations

- Position value: `x = L(1/√P − 1/√Pb)`, `y = L(√P − √Pa)`,
  `value = (x + y/P)/1e6`.
- Liquidity for value: `L = value / position_value_usd(1, …)`.
- IL: `IL = LP_value/HODL_value − 1` on the actual tick range, in bps.
- Fee APR: `fee_window × (365×24/(36/60)) / book_value × 10,000`.
- Net APR: `fee_apr_bps − fee_il_hurdle×|il_apr_bps|` (hurdle default 1.0).
- Net-of-borrow NVDA APR: `nvda_apr_eff = nvda_apr + LTV×borrow_apr`; the
  subsequent borrow-cost subtraction makes the net NVDA contribution `nvda_apr`.
- Fee share: expansion `rate × (L×V1 − L²×V2)`; exact
  `rate × volume × L/(poolL+L)`, `poolL = volume/volOverL`.
- Book fee APR: `cum_fees / initial_nav × 8760 / steps × 100`.
- Surplus reserve: `max(inventory_reserve_usd, inventory_reserve_pct×NAV)`.
- Borrow: `debt = collateral_value × min(ltv_bps, max_ltv_bps, 3000)/10,000`.
- Arm interest: hourly `lent × (1 + lend_apr/8760)`, `debt × (1 +
  borrow_apr/8760)`, `nvda × (1 + nvda_apr/8760)`.
- LTV: `debt/(nvda×price)`. HF: `LLTV/LTV`.
- NAV: `idle_usdg + idle_nvda×price + Σ book_value + arm.nvda×price +
  arm.usdg_lent − arm.debt`.
- HODL: `initial_usdg + initial_nvda×price`.
- Net carry: `fees + arm_interest + nvda_yield − borrow − gas − switch − swap`.
- Rewards identity: `net_vs_hodl = net_carry − liquidation_loss + il_vs_hodl`,
  where `il_vs_hodl` is the LP mark/timing residual (not a pure static IL).
- Swap: sell value `V` at `c` bps, receive `V(1−c)`; NAV falls by `Vc`.
- Inventory skew: choose `offset ∈ [−max_skew, +max_skew]` maximizing
  `scale×(x_req + y_req×price)` at funding, tie-break to `offset=0`.

## 9. Invariants

1. Row count `1 + T × 7`.
2. `NAV_after = NAV_before − gas − switch_cost` for a move; fees/interest add;
   liquidation subtracts.
3. All balances non-negative.
4. Debt at borrow ≤ 30% of collateral; continuous LTV can drift with price.
5. Arm collateral and lend balances ≤ min(absolute cap, relative cap × NAV).
6. Guard positions earn only while in range and present; a pull returns tokens
   to idle and sets `guard_present=false`.
7. `step` increments exactly once per hour; the scenario is not mutated.
8. Deterministic replay for the same scenario and parameters.
9. Swap funding reduces NAV by exactly the recorded `cum.swap_cost` (no hidden
   value creation); inventory skew only changes the range, not the token value.
10. `net_vs_hodl = cum_net_carry − cum_liquidation_loss + cum_il_vs_hodl` holds
    to float precision.

## 10. Experiments

- **Validation**: static `always_a` / `always_b`, no guard pulls, zero gas,
  against `research/out/v3-usdg-nvda-005-fee500-45d.json` and
  `...v4-usdg-nvda-030-fee3000-45d.json`.
- **Baseline**: 34 configurations × 45d and 20d: HODL, always A/B, always arms,
  as-built allocator, fixed allocator, risk-only A/B, live/stress arm rates,
  caps, guard thresholds, volume floors, unwind steps, strict LTV.
- **Sweep**: one-at-a-time over arm rates, caps, risk thresholds, guard
  threshold, unwind step, gas, capital, allocator interval, guard share, LTV.
- **Optimize**: 25 variants × 45d/20d over funding mode (scale/swap), inventory
  skew, re-center thresholds, fee/IL gate, base/guard widths, guard share,
  funding bps, and no-swap reserve + surplus-NVDA-to-arm sweep.
- **Monte Carlo**: 30 fixed-length moving 24-hour block-bootstrap paths of the
  45-day tape, paired risk-only vs always-A (10k and 15k volume floors).
- **Optimize MC**: 20 paired paths × 45d and last-20d for the 1h baseline, A, C,
  D, and always-A; reports median, p05, and paired win rate.
- **Large NAV**: 5 caps ($100k–$2M) × 5 configs × 45d/20d with exact fee shares,
  scaled absolute arm caps, and live $15k borrow liquidity.
- **Scenario lab**: 10 market presets × 6 strategies, a 27-row interval/guard/skew
  grid, a 3×3 width grid, and a $10k–$2M scaling tab; all runs are precomputed.
- **Tests**: 76 pytest tests covering ported keeper vectors, LP math, scenario
  fees, row count, determinism, conservation on synthetic and real tapes,
  liquidation/bad debt, execute-layer caps, 90% funding, borrow-APR deleverage,
  guard event/fee timing, guard share/base-only, allocator interval, 35% LTV,
  swap funding cost, inventory skew, re-center, net-of-borrow NVDA APR,
  surplus-NVDA sweep/reserve, exact fee-share mode, rewards identity, HODL,
  return-to-book, ETH/USDG decomposition, the dashboard/scenario-lab builds, and
  real-tape fee reproduction.
- **ETH/NVDA vs USDG/NVDA**: `eth_compare.py` decomposes fee APR + IL + HODL
  price + total for the V3/V4 WETH/NVDA sims and the USDG books, with an ETH/USD
  translation and breakeven.
- **Dashboard**: `build_dashboard.py` writes a self-contained
  `out/dashboard.html` with the NAV paths, policy/interval/guard/LTV tables, the
  ETH quote comparison, and the ETH/USD slider.
- **Presentation dashboard**: `build_scenario_dashboard.py` writes
  `out/scenario_dashboard.html`, a light-theme single-pool vs allocator page with
  Book A/B/arm cards, the rewards waterfall, scenarios, scaling, bootstrap risk,
  and validation.
- **Scenario lab**: `build_scenario_lab.py` writes `out/scenario_lab.html` with
  market presets (volume/fee/vol/Book B/arm), a 27-row interval/guard/skew grid,
  a 3×3 width grid, and a $10k–$2M scaling tab. All runs are precomputed by the
  model; the browser only selects them.
- **Simple comparison**: `run_recommended_100k.py` + `run_comparison_100k.py` +
  `build_simple_dashboard.py` write `out/simple_dashboard.html`: 0.05 pool,
  0.30 pool, deploy-to-us, hold NVDA and hold USDG at $100k, with the real price
  and a 0.05/0.30/Morpho timeline.

## 11. Results

### Static validation

| Book | Model fees | Research fees | Diff | Model net vs HODL | Research net |
|---|---:|---:|---:|---:|---:|
| A (V3 0.05% proxy) | $245.65 | $245.19 | +0.19% | +$148.45 | +$147.02 |
| B (V4 0.30%) | $278.25 | $276.26 | +0.72% | +$181.05 | +$179.62 |

The $1.43 net difference is the model's fee cash timing plus the minute-level
share approximation; it is inside 1.0% of the research result.

### 45 days

| Policy | Final NAV | Net vs HODL | Max DD | Fees | Arm interest | Gas | Arms hours | Actions |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| HODL | $9,683.01 | $0.00 | −6.7% | $0 | $0 | $0 | 0 | 0 |
| Always A | $9,831.46 | +$148.45 | −5.7% | $245.65 | $0 | $0 | 0 | 0 |
| Always B | $9,864.06 | +$181.05 | −5.7% | $278.25 | $0 | $0 | 0 | 0 |
| Always arms | $9,695.88 | +$12.87 | −6.6% | $0 | $7.54 | $1.68 | 1,080 | 84 |
| Allocator as built | $9,676.37 | −$6.64 | −7.1% | $7.07 | $7.38 | $1.56 | 1,056 | 78 |
| Fixed, net-APR gate | $9,663.30 | −$19.71 | −7.3% | $5.38 | $7.37 | $6.36 | 1,067 | 318 |
| **Risk-only A** | **$9,874.05** | **+$191.04** | **−5.2%** | **$187.92** | **$1.11** | **$5.52** | **269** | **276** |
| Risk-only B | $9,689.36 | +$6.35 | −6.6% | $0.09 | $7.53 | $6.28 | 1,079 | 314 |
| Risk-only A, live arm | $9,873.19 | +$190.18 | −5.2% | $187.92 | $0.38 | $5.52 | 269 | 276 |
| Risk-only A, stress arm | $9,908.52 | +$225.51 | −4.8% | $170.05 | $39.08 | $5.54 | 271 | 277 |
| Risk-only A, caps 50% | $9,889.26 | +$206.25 | −5.1% | $190.51 | $1.87 | $5.60 | 274 | 280 |
| **Risk-only A, volume 15k** | **$9,997.14** | **+$314.13** | **−4.3%** | **$231.89** | **$1.35** | **$6.86** | **341** | **343** |
| **Best: 2h/15k/75%** | **$10,114.37** | **+$431.36** | **−4.4%** | **$280.40** | **$1.56** | **$4.20** | **408** | **210** |
| **C: 3k/500/2.5k skew** | **$10,195.07** | **+$512.06** | **−4.5%** | **$338.07** | **$1.54** | **$4.18** | **406** | **209** |

### Last 20 days (NVDA −9.6%)

| Policy | Final NAV | Net vs HODL | Max DD | Fees | Arms hours |
|---|---:|---:|---:|---:|---:|
| HODL | $9,497.15 | $0.00 | −6.5% | $0 | 0 |
| Always A | $9,350.93 | −$146.21 | −7.9% | $62.44 | 0 |
| Always B | $9,346.01 | −$151.13 | −7.9% | $57.52 | 0 |
| Always arms | $9,502.12 | +$4.97 | −6.5% | $0 | 480 |
| Allocator as built | $9,501.20 | +$4.06 | −6.5% | $0.02 | 479 |
| Fixed, net-APR gate | $9,496.69 | −$0.46 | −6.5% | $0.41 | 476 |
| **Risk-only A** | **$9,391.53** | **−$105.62** | **−7.6%** | **$71.59** | **222** |
| Risk-only B | $9,499.75 | +$2.60 | −6.5% | $0.08 | 479 |
| Risk-only A, live arm | $9,391.06 | −$106.09 | −7.7% | $71.59 | 222 |
| Risk-only A, caps 50% | $9,487.71 | −$9.44 | −6.9% | $128.88 | 225 |
| **Risk-only A, volume 15k** | **$9,525.37** | **+$28.23** | **−6.6%** | **$125.20** | **275** |
| **Best: 2h/15k/75%** | **$9,544.09** | **+$46.94** | **−6.7%** | **$148.99** | **342** |
| **C: 3k/500/2.5k skew** | **$9,578.91** | **+$81.76** | **−6.7%** | **$207.69** | **338** |

### Cadence, guard share, LTV

| Case | 45d net | 20d net | Actions 45/20 |
|---|---:|---:|---:|
| 1h / 10k / 50% (current) | +$191.04 | −$105.62 | 276 / 229 |
| 2h / 10k / 50% | +$325.65 | +$29.59 | 167 / 160 |
| 4h / 10k / 50% | +$204.83 | −$130.04 | 97 / 97 |
| 8h / 10k / 50% | +$225.07 | −$57.04 | 41 / 41 |
| 1h / 10k / 0% guard | +$44.45 | −$13.91 | 268 / 226 |
| 1h / 10k / 75% guard | +$273.69 | −$127.14 | 274 / 230 |
| **2h / 15k / 75%** | **+$431.36** | **+$46.94** | **210 / 177** |

The 2h check is the in-sample best; 4h/8h are too slow in the 20d. The 75% guard
is a fee/vol bet; it only turns positive in the 20d with the 2h and 15k filters.
Always-arms 30% LTV: +$12.87 / +$4.97, max LTV 34.4%; 35% LTV: +$12.82 / +$4.96,
max LTV 40.1%. The extra 5% debt is carry-neutral at 3%/3% but adds LTV drift and
liquidation risk; keep the 29.375%/30% target.

### Rewards: book vs arm

| Run | Window | Book fees | Arm USDG | NVDA yield | Borrow+gas+swap | Net carry | LP mark/timing | Net vs HODL |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Risk-only 1h/10k/50 | 45d | $187.92 | $1.11 | $0.15 | $5.52 | $183.66 | +$7.38 | +$191.04 |
| Risk-only 1h/10k/50 | 20d | $71.59 | $0.47 | $0.18 | $4.58 | $67.65 | −$173.27 | −$105.62 |
| A: 2h/15k/75 | 45d | $280.40 | $1.56 | $0.13 | $4.20 | $277.89 | +$153.47 | +$431.36 |
| A: 2h/15k/75 | 20d | $148.99 | $0.74 | $0.18 | $3.54 | $146.36 | −$99.42 | +$46.94 |
| C: 3k/500/skew | 45d | $338.07 | $1.54 | $0.11 | $4.18 | $335.54 | +$176.53 | +$512.06 |
| C: 3k/500/skew | 20d | $207.69 | $0.73 | $0.13 | $3.52 | $205.03 | −$123.26 | +$81.77 |
| Always A | 45d | $245.65 | $0 | $0 | $0 | $245.65 | −$97.20 | +$148.45 |
| Always arms | 45d | $0 | $7.54 | $9.88 | $3.99 | $13.43 | −$0.56 | +$12.87 |

The identity is `net = net_carry − liquidation + LP mark/timing`. The arm is
~$1.65 of a $338 book in C; always-arms earns ~$13.43 net carry (1.1% on NAV,
3% on collateral).

### Inventory, swap, and fee/IL

| Case | 45d net | 20d net | 45d fees | 20d fees | 45d end idle | 20d end idle |
|---|---:|---:|---:|---:|---:|---:|
| Baseline (no swap) | +$191.04 | −$105.62 | $187.92 | $71.59 | $3,397 | $2,036 |
| Swap-to-fund 10 bps | +$186.96 | −$102.35 | $274.79 | $78.62 | $1,077 | $922 |
| Inventory skew 2,000 (base 6k) | +$175.56 | −$114.85 | $199.27 | $78.75 | $2,076 | $977 |
| Re-center 500 bps | +$62.54 | −$87.57 | $185.67 | $90.17 | $5,561 | $5,047 |
| A: 2h/15k/75 | +$431.36 | +$46.94 | $280.40 | $148.99 | $4,906 | $2,265 |
| B: A + 3k base + 2.5k skew | +$460.60 | +$69.13 | $316.45 | $175.96 | $3,579 | $965 |
| **C: B + 500 guard** | **+$512.06** | **+$81.76** | **$338.07** | **$207.69** | **$4,655** | **$1,002** |
| D: C + 80% guard | +$536.60 | +$75.78 | $339.39 | $207.29 | $5,357 | $1,521 |

Swap-to-fund raises fees but lowers net: the extra capital buys IL. Inventory
skew uses the recalled token and raises net in-sample, but it moves the
depreciated NVDA into the vault and adds tail risk. Re-centering at 500 bps
realizes IL; 1,000 bps never triggers. Fee/IL gate (24h, 250 bps, 8h confirm):
+$302.11 / +$19.47, DD −4.4%/−6.7%; it improves the 1h baseline but does not beat
A/C. A guard-specific fee/IL pull is a churn failure (−$9.26/−$30.55).

The no-swap 50/50 re-add with a reserve works, but the surplus-NVDA-to-arm sweep
does not pay at $10k: A + sweep is +$430.73/+$46.87 vs A +$431.36/+$46.95; C
no-skew + sweep is +$496.84/+$50.72 vs C +$512.06/+$81.77. The 20% arm cap is
full and the 3% net yield is too small; raising caps to 50% gives
+$517.07/−$70.34. Keep the reserve and the skew; leave the excess idle.

### Optimisation MC, 20 paths

| 20 paths | 45d median | 45d p05 | 45d win vs A | 20d median | 20d p05 | 20d win vs A |
|---|---:|---:|---:|---:|---:|---:|
| Risk-only 1h/10k/50 | +$168.19 | −$473.37 | 30% | +$64.42 | −$78.37 | 25% |
| A: 2h/15k/75 | +$185.59 | −$552.51 | 30% | +$47.47 | −$133.92 | 35% |
| C: 3k/500/skew | +$220.62 | **−$607.47** | 45% | +$68.43 | **−$158.65** | 50% |
| D: C + 80% guard | +$218.04 | **−$626.16** | 55% | +$71.37 | **−$161.64** | 50% |
| Always A | +$214.16 | −$506.67 | — | +$79.33 | −$85.01 | — |

C/D win slightly more often but have much worse p05 and a lower mean (C
+$12.5/+$44.5 vs always-A +$27.2/+$49.1). Always-A has the best mean and p05; the
1h risk-only has a slightly better p05 but lower mean. The in-sample ranking is
not the risk-adjusted ranking.

### Large NAV, exact fee share

| NAV | Always A 45d net / APR | Always B 45d net / APR | C 45d net / APR | C 20d net / APR | Book B L/pool |
|---|---:|---:|---:|---:|---:|
| $100k | +$1,451 / 11.8% | +$1,511 / 12.3% | +$4,248 / 34.5% | −$690 / −12.6% | 2.1% |
| $500k | +$6,579 / 10.7% | +$3,608 / 5.9% | +$20,679 / 33.6% | −$10,208 / −37.3% | 10.7% |
| $1M | +$11,742 / 9.5% | +$2,473 / 2.0% | +$40,164 / 32.6% | −$21,155 / −38.6% | 21.3% |
| $2M | +$19,036 / 7.7% | **−$3,726 / −1.5%** | +$76,349 / 31.0% | **−$44,405 / −40.5%** | 42.7% |

Book A scales (~1–2% of its pool at $1M/$2M). Book B does not: its L is 21%/43%
of the pool, the exact share saturates, and always-B turns negative at $2M. C
stays positive over 45d but the 20d is negative at $1M/$2M; the $10k 20d +$81.77
does not scale. 20/50/100% arm caps give nearly the same 1M/2M C 45d result; the
arm is <$1k. Cap Book B around $250k–$500k; Book A at $1M–$2M only with a
fresh-tape/tail test.

### ETH/NVDA vs USDG/NVDA

| Book | Quote | Fee APR | IL APR | Net APR | NVDA price | HODL APR | Total APR | Guard |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| USDG V3 0.05% | USDG | 19.9% | −8.0% | 11.9% | −6.37% | −25.8% | −13.9% | 91.4% |
| USDG V4 0.30% | USDG | 22.4% | −7.8% | 14.6% | −6.32% | −25.7% | −11.1% | 92.0% |
| USDG V4 0.01% | USDG | 11.5% | −2.2% | 9.3% | −3.25% | −14.2% | −4.9% | 70.1% |
| ETH V3 0.05% | WETH | 40.4% | −1.8% | 38.7% | −3.03% | −12.3% | 26.3% | 68.5% |
| ETH V3 0.30% | WETH | 39.5% | −1.7% | 37.8% | −2.93% | −11.9% | 26.0% | 74.9% |
| ETH V4 0.05% | WETH | 30.3% | −1.8% | 28.5% | −3.08% | −12.5% | 16.0% | 66.0% |

`total = fee + IL + HODL`. The ETH book's NVDA price fell ~3% in ETH vs ~6.3% in
USDG; its fees are ~2× and its IL ~4× smaller, so its total is +2.0 to +3.3% in
ETH vs −1.4 to −1.7% in USDG. The ETH book wins in ETH unless ETH/USD falls more
than ~4.8% (V3 0.05 pair); the ETH/USD series is not in the tape. The standalone
dashboard (`build_dashboard.py`) shows the slider and breakevens.

### Monte Carlo, 30 block-bootstrap paths

| Metric | Risk-only 10k | Risk-only 15k | Always A |
|---|---:|---:|---:|
| Net vs HODL median | +$68.06 | +$75.52 | +$46.17 |
| Net vs HODL p05 / p95 | −$512.61 / +$249.44 | −$512.90 / +$252.71 | −$525.70 / +$327.85 |
| Mean net | −$16.10 | −$11.38 | +$8.93 |
| Max DD median | −7.92% | −7.80% | −7.90% |
| Max DD p05 | −17.20% | −17.13% | −17.68% |
| Paired diff vs always A | median −$28.32 [−$166.63, +$81.55] | median −$32.30 [−$173.14, +$144.09] | — |
| Paired win rate | **36.7%** | **40.0%** | — |

The in-sample +$191.04 / +$314.13 is not a robust alpha. Across resampled paths
from the same tape, the risk-only allocator wins only 36.7% (10k) / 40.0% (15k)
of paired runs against always-A and has a worse mean and heavier left tail. The
45d/20d outperformance is a regime-timing result, not a reliable edge.

## 12. Findings

1. **As-built allocator one-way door.** `tickAllocator` checks
   `!guardPresent` before `decidePoolSwitch`. After the book is recalled, the
   hook's guard is absent, so `current.risk` is HIGH and the allocator calls
   `deployToArms` forever. `returnToBooks` is unreachable. The model reproduces
   this: 1,056 of 1,080 hours in arms (23 funded) in the 45d; 479 of 480 hours in
   the 20d. The 20d net is +$4.06, essentially always-arms; the 45d is −$6.64
   after the transition.
2. **Net-APR gate churn.** The allocator header says "no APR comparison and no
   min-carry rule", but `tickAllocator` runs `decidePoolSwitch` on a trailing
   36-minute, annualized net APR. The annualization multiplies small IL by
   14,600, so the book alternates between "great" and "uninvestable". The fixed
   variant makes 318/158 actions and loses $19.71 (45d) / $0.46 (20d). The
   documented risk-only design is the coherent policy.
3. **Risk-only is the coherent design, but not a robust alpha.** The production
   floor earns +$191.04 (45d) / −$105.62 (20d), better than always-A in both
   windows but negative vs HODL in the 20d. The $15k floor earns +$314.13 /
   +$28.23, but the block bootstrap still wins only 40% of paired runs against
   always-A.
4. **The $15k volume floor is the strongest single lever.** At $10k the risk-only
   earns +$191.04 / −$105.62 and keeps $187.92 of 45d fees; at $15k it earns
   +$314.13 / +$28.23 and keeps $231.89. The 15k floor selects high-volume,
   high-fee hours; the thin/low-fee hours are where the book loses. Test
   `KEEPER_RISK_MIN_VOLUME_USD=15000` (or a rolling 6h volume) in a bull regime
   before changing production.
5. **Book B is too thin for either floor.** Its 36-minute volume is usually
   ~$700. Risk-only B funds 0 hours in the 20d and makes +$6.35 / +$2.60; the
   $1k-floor B variant is −$48.57 / −$3.73 with 756/326 actions. Always-B is
   +$181.05 in the 45d but −$151.13 in the 20d: the fee tier is not a substitute
   for volume.
6. **The `.env.example` 50 bps is not a pull threshold.** `STATIC_RECHECK_MAX_DEV_BPS`
   is the maximum pool-oracle deviation allowed when `recheckGuard` re-deploys;
   the pull itself is EV-simulator based. The model's 50/100/200/300 settings are
   5-minute move proxies, not the env parameter. The proxy is non-monotone:
   50 bps is −$13.00 / +$19.45, 100 bps is +$134.74 / −$130.42, 200 bps is
   +$191.04 / −$105.62. The model cannot test the 50 bps re-arm band without a
   Chainlink/oracle series; review the env value against the hook's EV/recheck
   logic and keep 200 as the deploy default.
7. **3% USDG is plausible; 3% NVDA is a Spiral total-yield assumption, not a
   native Morpho collateral APR.** The 3% NVDA is **APR after borrowing cost**:
   the model grosses it up by LTV×borrow APR and subtracts borrow, so the net NVDA
   contribution is 3% APR. In the risk-only A, the NVDA line is $0.15 over 45d; in
   the full always-arms loop it is $9.88 grossed up, and the whole arm nets
   +$12.87. The 3% USDG lends add $3.76 over 0%; the live-vs-user difference is
   $0.86. The risk-only arm is mostly the USDG lend arm; the full Spiral/NVDA loop
   is held only in the always-arms benchmark. See [`ARM_REALISM.md`](ARM_REALISM.md).
8. **The 20% arm caps leave ~55% idle in risk-off.** Raising both relative caps
   to 50% gives +$206.25 / −$9.44; 100% is +$206.15 / −$9.44. The 20d improvement
   is mostly book/arm timing and extra fee hours, not the 3% arm yield. The 15k
   floor is the stronger lever; combining 15k + 50% caps is +$306.33 / +$16.47,
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
    always-arms benchmark earns $7.54 on the same $10k.
12. **The 1h check is not optimal on this tape, but the bootstrap does not
    validate 2h.** 2h: +$325.65 / +$29.59 with 167/160 actions vs +$191.04 /
    −$105.62 at 1h; 4h/8h too slow in the 20d. 2h + 15k + 75% guard: +$431.36 /
    +$46.94 in-sample, but its bootstrap p05 is −$552.51 / −$133.92 vs baseline
    −$473.37 / −$78.37. Test 2h on a fresh tape; the guard still rechecks every
    5 minutes.
13. **The guard is a fee/IL trade-off, not IL prevention.** Guard share
    0/25/50/75%: +$44.45 / +$112.68 / +$191.04 / +$273.69 (45d);
    −$13.91 / −$61.70 / −$105.62 / −$127.14 (20d). The 75% case only turns
    positive in the 20d with the 2h and 15k filters, and that combo has a worse
    bootstrap p05. The 5-minute pull proxy is a stress, not the `.env` re-arm band.
14. **30% LTV beats 35% under the 3% net + 3% + 3% assumptions.** Full-arm
    always-arms: +$12.87 at 30% vs +$12.82 at 35%; max LTV 34.4% vs 40.1%. The
    extra 5% debt is carry-neutral at a 3% borrow / 3% lend spread but adds LTV
    drift and liquidation risk. Keep the 29.375%/30% target and add a continuous
    30% LTV sentinel if the rule is hard.
15. **ETH/NVDA is the better book in its own quote, but it is a different
    quote.** ETH books: fee 30.3–40.4%, IL −1.7 to −1.8%, net 28.5–38.7% ETH,
    total +2.0 to +3.3% ETH. USDG books: fee 19.9–22.4%, IL −7.8 to −8.0%, net
    11.9–14.6%, total −1.4 to −1.7% USDG. ETH wins in ETH unless ETH/USD falls
    more than ~4.8%; it is not the allocator's USDG arm.
16. **The book is the business; the arm is small.** C earns $338.07 of book fees
    and $1.65 of arm+NVDA over 45d. Always-arms earns $17.42 gross but only
    $13.43 net carry (1.1% on NAV, 3% on collateral) after borrow/gas. The 3%
    NVDA is a Spiral total-yield assumption, net of borrow, not a native
    collateral yield.
17. **Swap-to-fund is worse than leaving the excess idle.** Fees rise $188 → $275
    but net falls $191 → $187 because the extra capital buys IL (LP mark/timing
    +$7 → −$82). The under-funded book is an accidental inventory buffer.
18. **Inventory skew is a real in-sample lever with a tail.** Base 3k + guard 500
    + 2.5k skew earns +$512.06 / +$81.76 and cuts idle, but the 20-path bootstrap
    p05 is −$607 / −$159 vs always-A −$507 / −$85. The NVDA depreciation is now
    concentrated in the vault; it wins more often and loses more in bad paths.
    Re-centering at 500 bps is worse (+$63); 1,000 bps never triggers.
19. **Fee/IL needs a hurdle and hysteresis, not a raw trigger.** 24h window,
    250 bps buffer, 8h confirmation: +$302.11 / +$19.47, DD -4.4%/-6.7% vs
    baseline +$191/−$106. A guard-specific fee/IL pull is a churn failure
    (−$9/−$31, 136–225 pulls, fees collapse to $50–60).
20. **Risk-adjusted ranking: always-A > 1h/10k/50 risk-only > in-sample best.**
    Always-A has the best bootstrap mean (+$27.2/+$49.1) and p05 (−$507/−$85).
    The 1h/10k/50 risk-only has a slightly better p05 than always-A but lower mean
    (−$5.0/+$34.7). C/D have higher win rates but much worse p05. Do not deploy
    C/D as a return strategy without a tail hedge or a smaller skew.
21. **Large NAV: Book A scales, Book B does not.** At $1M/$2M with exact fee
    shares: Always-A +$11.7k/+$19.0k, Always-B +$2.5k/−$3.7k, C +$40.2k/+$76.3k
    over 45d but −$21.2k/−$44.4k over the 20d. Book B is 21%/43% of its pool;
    cap it at ~$250k–$500k. Book A is ~1–2%; $1M–$2M is feasible in-sample only
    with a fresh-tape/tail test. 20/50/100% arm caps give nearly the same 1M/2M
    C result; the arm is <$1k. Do not linearly extrapolate $10k.

### Review corrections

The first pass reported risk-only A at +$213.65 / +$42.89. The independent
review found material issues; the corrected model now uses one tick mark for
every book, carries liquidation bad debt as a liability, clips BORROW/WITHDRAW at
the execute layer, funds 90% of idle on re-entry, applies the keeper's
borrow-APR deleverage, counts guard pulls as events (one per hour), and has no
warmup. The corrected 20d result at the production volume floor is −$105.62, not
+$42.89. The $15k floor is the only variant positive in both windows; the 50%
caps is nearly flat in the 20d (−$9.44). Neither is a confirmed edge.

## 13. Caveats

- **Book A is a proxy.** No V4 USDG/NVDA 0.05% pool exists in the downloaded
  set. The V3 0.05% tape supplies the price/volume/liquidity shape and the 500
  pips fee. A real V4 0.05% pool will have a different L distribution.
- **Guard pull proxy.** The model pulls on a 5-minute move above a proxy
  threshold, not the hook's EV simulator / `recheckGuard` oracle deviation. The
  `.env.example` 50 bps is a re-arm deviation band, not a pull threshold; the
  model's 50/100/200/300 cases are pull-proxy sensitivities and cannot test the
  env value without an oracle series. The 200 bps deploy default is retained.
- **Risk-window fee estimate.** The model uses the minute-level in-range fee
  moments, not the keeper's current `bookShare` × window fees. This is a more
  accurate estimate of what the book actually earned, but it can differ from the
  keeper's scan when the guard was out of range. The `risk_only` decision does
  not use the fee APR; the as-built/fixed net-APR variants do.
- **Fee-share expansion.** `L/(poolL+L) = L/poolL − (L/poolL)² + …` is valid for
  the observed `L_book/L_pool < 0.02`; `max(0, …)` masks the breakdown if a future
  book is comparable in size to the pool. Use the exact per-minute share if that
  regime matters.
- **Depeg is exogenous.** No Chainlink `AnswerUpdated` history or ETH/USD
  conversion. The `depegProxy` is pool-price vs 30m TWAP, not a true depeg; the
  baseline is off.
- **Arm rates are scenarios.** Morpho's API gives current market state, not a
  45-day rate history. The user/live/stress rates are assumptions; the borrow
  liquidity is a current snapshot.
- **Fixed sleeve.** The book's target L is set from the initial capital; a
  re-fund uses 90% of idle (`KEEPER_FUND_BOOK_BPS=9000`) and scales down to
  available tokens by default. The swap/skew variants model the alternatives; the
  swap assumes 10 bps and no price impact, and the skew is a static range shift,
  not a continuous inventory optimizer.
- **Re-center is composite.** `RECENTER_BOOK` is recall + fund in one model
  action with 2× gas; the keeper would need two runs or a composite adapter.
- **Fee/IL gate approximation.** The 24h window applies the current L/range to
  the whole window; the guard fee/IL pull uses the guard sleeve and churns.
- **Large NAV needs exact fee share.** The second-order expansion is safe only
  while `L_book/poolL` is small. At $1M/$2M, Book B is 21%/43% of its pool and
  the expansion understates its fee share; `fee_share_mode="exact"` is required.
  Book A is ~1–2% of its pool at $1M/$2M and is nearly linear.
- **Book B does not scale to $1M/$2M.** Always-B is +$2.5k at $1M and −$3.7k at
  $2M with exact shares; cap Book B around $250k–$500k. C is positive over 45d
  but the 20d is negative at $1M/$2M; the $10k 20d result does not scale.
- **Arm caps do not fix scale.** 20/50/100% relative caps give nearly the same
  1M/2M C 45d result; the arm is <$1k at those sizes. Do not size the arm for
  the 3% net yield.
- **20-path optimization MC.** Small sample; p05 is the relevant tail statistic,
  not a precise estimate. The 30-path baseline MC is separate.
- **One global mark for both books.** Book B is marked at Book A's tick. B's own
  close differs by −44..+42 ticks; the B position value differs by up to 0.28%
  on $10k. The B/A ranking is unchanged; a per-book mark is a future refinement.
- **No bull regime in the data.** Both the 45-day and 20-day windows are down.
  The block bootstrap preserves the same regime. The model does not prove the
  strategy works in a bull market; it may sit in the arm and miss upside. The
  2h/15k/75% best is an in-sample down-regime result, not a proven edge.
- **ETH/NVDA is a quote comparison, not the allocator.** The ETH books are
  WETH-quoted; the allocator and its arms are USDG. The ETH/USD series is not in
  the swap tapes, so the USD translation is a slider/assumption; the breakevens
  are ~−3.6% to −4.8% ETH/USD for the three pairs.
- **35% LTV is above the 30% rule.** The full-arm always-arms case drifts to
  40.1% max LTV at a 35% target; the extra 5% debt costs $0.44 because the 20%
  USDG lend cap is full. The 29.375%/30% target is the better risk/return.
- **Guard share is a fee/IL trade-off.** 75% guard is a fee/vol bet; it only
  turns positive in the 20d with the 2h/15k filters. The 5-minute pull proxy is
  not the `.env` recheck/re-arm band.
- **Gas and execution.** $0.02 per action; no MEV, slippage, price impact, or
  failed transactions. At $0.50/action the risk-only net falls from +$191.04 to
  +$75.41.
- **Caps and controller.** The model applies module caps but not the controller's
  per-call bounds, timelocks, or `KEEPER_ALLOCATOR_EXECUTE` flag. It assumes the
  allocator executes.

## 14. Contract → model map

| Contract / keeper function | Model |
|---|---|
| `assessBookRisk` | `allocator.assess_book_risk` |
| `decideByRisk` | not called by `tickAllocator`; `policy="risk_only"` is the documented equivalent |
| `borrowSize` | `allocator.borrow_size` |
| `planArmEntry` | `allocator.plan_arm_entry` |
| `planBookReturn` | `allocator.plan_book_return` |
| `chooseBook` | unused; the cross-pool path uses `decidePoolSwitch` |
| `decidePoolSwitch` | `allocator.decide_pool_switch`; used by as-built and fixed |
| `summarizeBook` / `marketStats` / `ilBpsForTicks` | `lp.py`, `model.book_fee_parts`, `_candidate` |
| `deployToArms` | `_deploy_to_arms_action` + execute |
| `returnToBooks` | `_return_to_books_action` + execute |
| `switchBook` | `SWITCH_BOOK` action |
| `PoolGuardHook` base/guard | `book` dict, pull/re-arm in `s_portfolio_income` |
| `MorphoLoopAdapter` / `MorphoBlueLendAdapter` | `arm` dict, interest/LTV/liquidation |
| `KEEPER_MAX_GUARD_PULLS=2` | `max_guard_pulls` |
| `KEEPER_STATS_LOOKBACK_BLOCKS=21600` × 0.1s | 36-minute risk window |
| `SPIRAL_NVDA_TARGET_LTV_OF_LLTV_BPS=4700` | `ltv_bps=2937` on 62.5% LLTV |
