# Fee-first pool allocator (cadCAD)

A cadCAD model of a $100k book split between the 0.05%, 0.15% and 0.30%
pools. **Fees are the driver**; volume is a secondary input used to
reverse-calculate the volume multiple that would make a sleeve pay, and to gate
the 0.30 sleeve on pool risk.

The model answers:

- How much can sit in the 0.30 pool before the 5% pool-share cap?
- Is a 15% or 30% piece in 0.15/0.30 profitable after fees and the 0.30 risk
  gate?
- What volume multiple does each piece need for $0 / $250 / $500 of extra P&L?

## What changed

The move rule is now **fee-only** and the 0.30 sleeve has a **risk gate**:

- `fee_switch_edge` no longer subtracts the risk-only return. The edge is
  0.30 fees minus 0.05 fees minus the switch cost (5 bps + gas) and the $25
  buffer. The switch cost is execution cost, not a return hurdle.
- `hurdle_total` / `H = $1,696.47` survives only as a reporting benchmark
  ("gain vs risk-only"); it is not subtracted from the edge.
- `pool_b_risk` blocks or de-risks 0.30 on volume, volatility, guard, depeg and
  the 5% share cap. A positive fee edge no longer enters on HIGH risk.
- The volume check is a **3-hour trailing average** of
  `bookB.risk.volumeUsd * vol30_mult`, clamped to the rows available. The
  previous one-hour check was too noisy: a single thin hour blocked a healthy
  pool.
- The static sweep is unchanged. It remains a **sizing analysis**, not the move
  rule.

## Files

```
fee_allocator/
  MODEL_CANVAS.md      purpose, state, policies, PSUBs, invariants
  model.py             cadCAD state / policies / SUFs / PSUBs / run_model
  run.py               baseline, 504-case sweep, reverse table, time split
  dashboard.py         builds out/dashboard.html
  tests/test_model.py  11 tests
  out/sweep.csv        504 static cases
  out/dashboard.html   self-contained verification dashboard
```

## Run

```powershell
$py = "research\cadcad\allocator\.venv\Scripts\python.exe"
& $py research\cadcad\fee_allocator\run.py baseline
& $py research\cadcad\fee_allocator\run.py sweep
& $py research\cadcad\fee_allocator\run.py time
& $py research\cadcad\fee_allocator\dashboard.py
# open research\cadcad\fee_allocator\out\dashboard.html
```

Tests:

```powershell
cd research\cadcad\fee_allocator
& ..\allocator\.venv\Scripts\python.exe -m pytest -q tests
```

## Model

- One step = one hour; 45-day tape (1,080 steps).
- State: `weights` (p05/p15/p30), `fees`, `cum_costs`, `cum_il`, `nav`,
  `market`, `metrics`.
- Policy `p_targets`: static weights, corner cases, or the direct `fee_check`
  rule. The rule compares the fees the cap-safe sleeve would earn in 0.30
  against the fees the same capital would earn in 0.05, subtracts switching cost
  and a $25 buffer (fee-only edge), and requires the 0.30 risk gate to be
  NORMAL. The volume leg of that gate is a 3-hour trailing average. On HIGH the
  sleeve is cut by one `move_step` per rebalance and never added to.
- SUFs: move weights and charge switching cost; accrue fees with exact
  `capital / (capital + capacity)` share; accrue common IL; update NAV; record
  metrics.
- PSUBs: market -> weights/costs -> fees/IL -> NAV -> metrics.

The 0.15 pool has no native tape. It uses the 0.30 hourly fee shape at half the
fee rate and `vol15_mult`. Default `vol15=2` makes its fee revenue equal to
0.30 at the same depth.

## Key results (45 days, $100k)

The benchmark is the risk-only engine; `H = $1,696.47` is what it earns above
all-0.05. It is a reporting benchmark only: the move rule does not subtract it.
The table below is the static sizing analysis, not the live move rule.

| Case | Fee gain vs all-0.05 | Gain vs risk-only | 0.30 share |
|---|---:|---:|---:|
| 15% in 0.30, 1.5× | +$408 | **+$154** | 2.7% (cap-safe) |
| 20% in 0.30, 1.5× | +$532 | **+$193** | 3.6% (cap-safe) |
| **28% in 0.30, 1.5×** | **+$719** | **+$244** | **4.94% (cap-safe)** |
| 30% in 0.30, 1.5× | +$763 | **+$254** | 5.27% (above 5%) |
| 30% in 0.30, 2.0× | +$1,392 | **+$883** | 5.27% |
| 15% in 0.15, 2.0× | +$87 | **−$167** | 0% |
| 15% in 0.15, 5.0× | +$1,053 | **+$798** | 0% |
| 15% in each, 1.5× | +$493 | **−$16** | 2.7% |
| 15% in each, 2.0× | +$815 | **+$306** | 2.7% |

- The **28% 0.30 sleeve is the cap-safe sweet spot**: +$244 at 1.5× and
  4.94% of the pool. The 30% piece adds only +$10 more but breaches the 5% cap.
- A **15% 0.30 sleeve** is the smaller cap-safe piece: +$154 at 1.5×,
  break-even around 1.26×.
- The **0.15 pool is not competitive at 2× volume**: its fee rate is half of
  0.30, so at the same depth it needs >2× the volume just to match 0.30, and
  about **2.6×** to clear the fee-only edge. At 15% and 2× it is −$167; at
  5× it is +$798. The risk-only figure is a benchmark, not the switch rule.
- Adding a 0.15 sleeve on top of a 0.30 sleeve lowers P&L at 1.5× (−$16 for
  15% each). At 2× the pair is +$306, still below the 0.30-only sleeve.

## Direct live fee check

The keeper does not need a 4×/10× volume estimate. At each rebalance it reads
the live pool fees, our live share, and the 0.30 risk inputs:

```
F_A, F_B   = live pool fees over the evaluation window
s_A        = C / (C + capacity_A)
s_B(w)     = wC / (wC + capacity_B)
Y_A        = w * F_A * s_A
Y_B        = F_B * s_B(w)

edge = Y_B - Y_A - switch_cost - buffer
enter if edge > 0 AND risk gate NORMAL
```

The move rule is **fee-only**: `switch_cost` is the 5 bps + gas execution cost,
`buffer` is the $25 anti-borderline margin, and no return hurdle is subtracted.
The risk-only benchmark `H` is reported separately for comparison. The
equivalent live volume threshold is:

```
V_B* = [w * f_A * V_A * s_A + switch_cost + buffer]
       / [f_B * s_B(w)]
```

On the 45-day tape the direct check ends at about 15% in 0.30 at 1.5× (+$22 vs
the risk-only benchmark), about 22% at 2× (+$527), and about 20% at 10×
(+$8,666). At 1× it ends out of 0.30 with a +$12 fee gain. The risk-only gain is
reported for comparison and is not part of the move edge.

### 0.30 risk gate

`pool_b_risk` is a pure function of the scenario row, NAV, params and current
0.30 weight. It returns HIGH with one or more reason tags:

| Tag | Trigger | Default |
|---|---|---|
| `volume` | 3h trailing average of `bookB.risk.volumeUsd * vol30_mult` below floor | $2,000 |
| `volatility` | `bookB.risk.volatilityBps` above ceiling | 300 bps |
| `guard` | `bookB.max5mMoveBps` above threshold, or `bookB.guardPulls` above max | 200 bps / 2 pulls |
| `depeg` | `bookB.depegProxy` above threshold, or `depeg_paused` on the row | 200 bps |
| `share-cap` | current share above 5%, or no cap-safe target | 5% |

Every rebalance calls the gate. On HIGH the policy cuts the 0.30 sleeve by one
`move_step` (0.05), keeps 0.15, and puts the rest in 0.05. It never enters on
HIGH, even when the fee edge is positive. On NORMAL the fee-only edge decides:
enter at the cap-safe target when the edge is positive, exit one step when it is
negative.

The volume check uses a trailing 3-hour average (including the rebalance hour,
clamped to the rows available), not the hour alone. The 0.30 tape is spiky —
$4,357 mean, $698 median — so a single thin hour would otherwise block a
healthy pool and make the sleeve flicker. Volatility, guard, depeg and the
share cap are still current-hour checks.

Results of `run.py baseline` with the **3-hour volume gate**:

| Case | Fees | Fee gain vs all-0.05 | Gain vs risk-only | End 0.30 |
|---|---:|---:|---:|---:|
| fee_check 1.0× | $3,675 | +$12 | +$12 | 0.0% |
| fee_check 1.5× | $3,940 | +$276 | +$22 | 15.0% |
| fee_check 2.0× | $4,572 | +$908 | +$527 | 22.4% |
| fee_check 10× | $12,675 | +$9,011 | +$8,666 | 20.3% |

The fee-only edge enters at 1.5×. The 3-hour volume average removes isolated
thin hours, so the gate no longer blocks a healthy pool on a single low-volume
hour: 1.5× spends 41.3% of state time in 0.30 with 73.3% any exposure, and 2×
reaches 54.6% / 95.6%. The 1-hour version of the gate was noisy and cut 0.30
state time / exposure to 8.9% / 15.6% at 1.5×, capturing only part of the
static sleeve's gain. At 1.0× the sleeve ends at 0.0% with a +$12 fee gain, so
the rule stays out. Gain vs risk-only is a benchmark, not the rule: the live
edge subtracts switch cost and the $25 buffer only.

## Time split after the fee-check rule

Run:

```powershell
& $py research\cadcad\fee_allocator\run.py time
```

The fee-check model itself has no ARM; the ARM hours are the existing
risk-only/Morpho timeline (442h of 1,080 = 40.9%). If the ARM risk-off pulls the
whole book, the mutually exclusive time split is:

**3-hour gate**:

| 0.30 volume | ARM | 0.30 state | 0.05 state | Any 0.30 exposure | Capital in 0.30 |
|---:|---:|---:|---:|---:|---:|
| 1.0× | 40.9% | 0.0% | 59.1% | 11.1% | 0.0% |
| 1.5× | 40.9% | 41.3% | 17.8% | 73.3% | 5.9% |
| 2.0× | 40.9% | 54.6% | 4.4% | 95.6% | 10.9% |
| 10× | 40.9% | 59.1% | 0.0% | 100% | 13.4% |

“Any 0.30 exposure” counts every hour with a non-zero sleeve, including hours
that later go to ARM. The state split gives ARM precedence. Capital in 0.30 is
the average sleeve weight over the 45 days, not the time.

The 3-hour gate restores exposure. It now sits above the old hurdle-rule
benchmark (1.5×: 14.6% of hours in 0.30 and 55.6% exposure; 2×: 52.4% /
93.3%). The 1-hour gate was the binding constraint: it fired on isolated thin
hours, and most 1.0–2.0× hours were below the $2,000 floor. With the 3-hour
average, 1.5× and 2× land closer to the old hurdle figures because a single
thin hour no longer blocks a healthy window. The old hurdle figures are a
benchmark, not the current rule.

If the 0.30 sleeve is **not** pulled during ARM, then the exposure time is the
“any 0.30 exposure” column (73.3% at 1.5×, 95.6% at 2×, 100% at 10×), and ARM
applies only to the remaining capital.

## Dashboard

`out/dashboard.html` lets you select the 0.15/0.30 sleeve and each pool's
volume. It shows:

- fee gain vs all-0.05 and net vs risk-only,
- the 0.30 pool share and a red outline when above 5%,
- a heatmap of every 0.30 sleeve at 1.0–5.0× volume,
- a reverse-calculated volume multiple for $0/$250/$500 of extra P&L.

## Caveats

- Volume multiples are relative to each pool's own base: 1× 0.30 is 1.3% of
  the 0.05 pool's volume, not 1× of 0.05. The 0.30 total fee pool only exceeds
  0.05 when its volume exceeds 1/6 of 0.05 (≈12.9× its current volume).
- 0.15 is synthetic; only its fee ratio to 0.30 is modeled.
- Volume multiples hold depth fixed; real volume attracts liquidity.
- Sleeves are passive: no re-centering, no skew. IL is a common overlay.
- 45-day in-sample tape; the risk-only benchmark is a parameter, not a full
  Morpho simulation. Fees are reinvested, so the all-0.05 fee total is ~1.8%
  above the non-compounding passive run.
