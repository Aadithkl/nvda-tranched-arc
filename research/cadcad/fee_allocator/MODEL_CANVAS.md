# Model canvas — fee-first pool allocator

## 1. Purpose

Decide how much of a $100k book should sit in the 0.05%, 0.15% and 0.30% fee
pools. The decision metric is **fees**. Volume is only an input used to
reverse-calculate the volume multiple that would make a sleeve profitable, and
to gate the 0.30 sleeve on pool risk.

Out of scope: exact Uniswap tick math, re-centering, Morpho borrowing, and a
live keeper. The common IL drag is exogenous and identical across pools because
all sleeves use the same ranges.

## 2. Boundary and time

- One step = one hour.
- Horizon = the 45-day tape (1,080 hours), optionally the last 20 days.
- Inside: the book's capital weights, fee accrual, switching cost, common IL.
- Outside: price path, pool volumes/fees, pool depth.

## 3. Actors

- **Allocator**: moves capital between pools from observed fees, subject to the
  0.30 risk gate.
- **Pools**: 0.05 (deep), 0.15 (mid), 0.30 (thin). They produce fees; they do
  not react to our capital.
- **Risk-only engine**: an incumbent **benchmark**, not a hurdle. Its return
  above all-0.05 (`H = $1,696.47`) is reported as "gain vs risk-only" for
  comparison; it is not subtracted from the move edge.

## 4. Environment (exogenous)

Per hour, from the historical tape:

- `fee_rev[p]`: pool fee revenue in USD (`bookA.poolFeesUsd`, `bookB.poolFeesUsd`).
- `capacity[p]`: dollar-denominated effective pool depth. Calibrated so
  `capital / (capital + capacity)` reproduces the observed fee share.
- `il_rate`: common IL per dollar per hour.
- `hurdle_rate`: risk-only return per dollar per hour (reporting only).
- `bookB.risk.volumeUsd`: 0.30 pool volume for the hour.
- `bookB.risk.volatilityBps`: 0.30 volatility proxy for the hour.
- `bookB.max5mMoveBps`, `bookB.guardPulls`: 0.30 guard-pull inputs.
- `bookB.depegProxy`, `depeg_paused`: 0.30 depeg inputs.

The 0.15 pool has no native tape. Its fee revenue is
`fee_rev_30 * (0.0015 / 0.003) * vol15_mult`; its depth is a parameter.

## 5. State

| Name | Type | Meaning |
|---|---|---|
| `step` | int | current hour |
| `weights` | dict | capital weights p05/p15/p30, sum 1 |
| `targets` | dict | last policy target |
| `fees` | dict | cumulative fees per pool |
| `cum_costs` | float | switching + gas |
| `cum_il` | float | common IL drag (reporting overlay) |
| `nav` | float | fee equity: initial + fees − costs |
| `market` | dict | current fee revenue, capacity, rates |
| `metrics` | dict | observables for the run |

## 6. Policies

- `p_market`: reads the hourly scenario row and writes `market`.
- `p_targets`:
  - `static`: fixed weights from params.
  - `all_05`, `all_15`, `all_30`: corner cases.
  - `fee_check`: direct live comparison, fee-only. At a rebalance hour the
    policy averages the last `eval_hours` (168h, clamped) of pool fees and
    computes, for the cap-safe target sleeve `w`:

    ```
    s_A      = nav / (nav + cap_A)
    s_B(w)   = w * nav / (w * nav + cap_B)
    fees_a   = w * F_A * s_A * eval_hours
    fees_b   = F_B * s_B(w) * eval_hours
    cost     = w * nav * switch_bps / 10_000 + gas      (gas only if w > 0)
    edge     = fees_b - fees_a - cost - buffer
    ```

    `F_A` and `F_B` are mean hourly fees; `F_B` is scaled by `vol30_mult`.
    The switch cost is execution cost and the $25 buffer is an anti-borderline
    margin; there is no return hurdle in `edge`.

    `w_target = min(weight_cap["p30"], share_cap["p30"] * cap_B /
    (nav * (1 - share_cap["p30"])))`, or 0 when `nav = 0`.

    Decision:

    - risk gate HIGH: `target_p30 = max(0, w - move_step)`; never add.
    - risk gate NORMAL and `edge(w_target) > 0`: `target_p30 = w_target`.
    - risk gate NORMAL and `edge(w) < 0` with `w > 0`: `target_p30 = max(0, w - move_step)`.
    - otherwise hold.

    `p15` is held constant; `p05 = 1 - p15 - p30`, then the targets are
    normalized.

- `pool_b_risk`: pure gate on the 0.30 sleeve. Returns `HIGH` with one or more
  reason tags, else `NORMAL`:

  ```
  volume      mean(volumeUsd[idx-2 .. idx]) * vol30_mult < risk_min_volume_usd
  volatility  volatilityBps > risk_max_volatility_bps
  guard       max5mMoveBps > risk_guard_pull_threshold_bps
              or guardPulls > risk_max_guard_pulls
  depeg       depegProxy > risk_depeg_bps or depeg_paused
  share-cap   w*nav / (w*nav + cap_B) > share_cap["p30"]
              or the cap-safe target is not positive
  ```

  The volume window is `risk_volume_window_hours = 3`, including the current
  row and clamped to the rows available. Volatility, guard and depeg are
  current-hour checks. A single thin hour inside a healthy 3-hour average does
  not fire the volume tag; three thin hours do.

## 7. SUFs and PSUBs

1. `p_market` -> `s_market`
2. `p_targets` -> `s_weights`, `s_costs`
3. `s_fees`, `s_il`
4. `s_nav`
5. `s_metrics`

Dependency order: market -> targets/weights -> fees/IL -> NAV -> metrics.

## 8. Observables

- weights over time
- cumulative fees, costs, IL, NAV
- fee gain vs all-0.05
- gain vs the risk-only benchmark (reporting only)
- fee ratio `fee_rev_15 / fee_rev_05`, `fee_rev_30 / fee_rev_05`
- required volume multiple for a target margin
- pool share `capital / (capital + capacity)`
- time split: ARM / 0.30 / 0.05 hours and average capital in each

## 9. Experiments

- Baseline: all-0.05, all-0.15, all-0.30.
- Static sleeves: 15% and 30% in each pool, plus combinations.
- Direct fee-check allocator at 1.0×, 1.5×, 2.0× and 10× 0.30 volume.
- Sweep 0.15/0.30 volume multiples and sleeve sizes (static sizing analysis;
  unchanged by the live gate).
- Reverse-calculate required volume for margins $0, $250, $500.
- Time split against the risk-only ARM timeline.

## 10. Invariants

- weights sum to 1 (tolerance 1e-9)
- weights bounded [0, 1]
- fees and costs non-negative
- `nav = initial + fees − costs`; `net_after_il = nav − initial − IL`
- on HIGH risk the 0.30 target never increases: `target_p30 <= current_p30`
- the cap-safe 0.30 target share is ≤ 5% (`share_cap["p30"]`), with a relative
  tolerance so the at-cap sleeve is not flagged by float noise
- the volume tag uses the trailing 3-hour average, not the current hour alone
- deterministic replay for the same scenario and params

## 11. Tests

`tests/test_model.py` (11 tests):

- `test_row_count_and_schema` — 1 genesis row + `T * 5` rows.
- `test_weights_sum_to_one_and_nav_identity` — weight and NAV identities.
- `test_fee_switch_edge_sign` and `test_fee_switch_edge_is_fee_only` — the edge
  has no hurdle input and matches `fees_b - fees_a - cost - buffer`.
- `test_pool_b_risk_reasons` — each reason tag fires, share cap included.
- `test_volume_gate_uses_trailing_three_hour_average` — one thin hour in a
  healthy window does not fire; three thin hours do; early rows clamp.
- `test_fee_check_enters_at_high_volume_only` — fee edge decides entry.
- `test_risk_gate_blocks_entry_even_when_fee_positive` — HIGH blocks a positive
  fee edge.
- `test_risk_gate_exits` — HIGH cuts the sleeve back to zero.
- `test_fee_check_respects_share_cap` — target stays under the 5% cap.
- `test_deterministic_replay` — identical results on a second run.

## 12. What changed

- The move rule is **fee-only**: `fee_switch_edge` no longer subtracts the
  risk-only return. `edge = fees_b - fees_a - switch_cost - buffer`, and the
  risk-only figure is a benchmark only.
- `p_targets` on HIGH risk reduces the 0.30 target by one `move_step` and never
  enters, even when the fee edge is positive.
- The volume gate is now a **3-hour trailing average** of
  `bookB.risk.volumeUsd * vol30_mult` against `risk_min_volume_usd = $2,000`,
  not the current hour alone. The one-hour check was too noisy: the 36-month
  0.30 tape has a $4,357 mean but a $698 median, so isolated thin hours blocked
  a healthy pool.
- Volatility (300 bps), guard (200 bps / 2 pulls), depeg (200 bps) and the 5%
  share cap are unchanged and remain current-hour checks.
- The static sweep and dashboard are a sizing analysis and are unchanged.
