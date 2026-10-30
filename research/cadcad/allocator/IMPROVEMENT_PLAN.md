# NVDA tranched-vault allocator — improvement plan for the next agent

Status: research model built, 76 tests passing. This plan is the handoff for
turning the research findings into a production-safe change. It is deliberately
ordered: correctness first, then no-swap inventory, then the fee/IL rule, then
width/skew tuning, then out-of-sample validation.

## 1. What the model says (do not re-litigate)

- The **book is the business**. At $10k, 45d risk-only A: book fees **$187.92**;
  the arm is **$1.11 USDG + $0.15 NVDA**. The best C config: book fees
  **$338.07**, arm **$1.54 + $0.11**. The 3% NVDA is a Spiral total yield, APR
  after borrowing cost; it is not a native Morpho collateral yield.
- **Always-A is the risk-adjusted benchmark** on this tape: 20-path bootstrap
  mean **+$27.2 / +$49.1**, p05 **−$507 / −$85**. The 1h/10k/50 risk-only is the
  defensive alternative: p05 **−$473 / −$78**, mean **−$5.0 / +$34.7**.
- **In-sample best C** (base 3k, guard 500, 2.5k skew, 2h/15k/75): **+$512 /
  +$82**, but bootstrap p05 **−$607 / −$159**. It is a tail-risk trade, not free
  alpha. Do not ship C as a return strategy without a tail hedge or a smaller
  skew.
- **Swap-to-fund is worse than leaving the excess idle.** Fees rise $188 → $275,
  net falls $191 → $187; the extra capital buys IL.
- **No-swap 50/50 re-add with a reserve works.** The direct case (C no-skew +
  sweep) is +$496.84 / +$50.72 vs C +$512.06 / +$81.77. The reserve/50-50 part is
  the useful part.
- **Pushing excess NVDA to the arm does not pay at $10k with 20% caps.** A + sweep
  is +$430.73 / +$46.87 vs A +$431.36 / +$46.95. C + sweep is +$511.42 / +$81.77.
  Raising caps to 50% gives +$517.07 / −$70.34. The 20% cap is already full and
  3% net does not compensate for holding NVDA through a down move.
- **`fee > IL` needs a hurdle + hysteresis + gas**, not a raw trigger. 24h
  window, 250 bps buffer, 8h confirmation: +$302.11 / +$19.47, DD −4.4%/−6.7% vs
  baseline +$191 / −$106. A guard-specific fee/IL pull is a churn failure
  (−$9.26 / −$30.55, 136–225 pulls, fees collapse to $50–60).
- **30% LTV beats 35%.** Always-arms 30% +$12.87 vs 35% +$12.82, but 35% drifts
  max LTV to 40.1% vs 34.4%. The extra debt is carry-neutral at 3%/3% but adds
  liquidation risk. Keep 29.375%/30%.

## 2. P0 — correctness before optimization

### P0.1 Fix the oracle mismatch

`research/.env.example` (or the repo's env example) points
`SPIRAL_NVDA_ORACLE` at the high-utilization NetNet market `0x8b16...9c3e` while
`MORPHO_MARKET_ORACLE` points at the lower-utilization market `0xf5ff...b6e4`.
Fix the mismatch, then re-check:

- `SPIRAL_NVDA_ORACLE` = the oracle for the market the Spiral adapter actually
  uses.
- `MORPHO_MARKET_ORACLE` = the oracle for the Morpho market used by the lend arm.
- Add a startup assertion that both oracles are non-zero and match the market's
  `oracle()` (read-only call).

### P0.2 Net-of-borrow 3% NVDA APR

The 3% is **APR after borrowing cost**. The model now supports
`nvda_apr_is_net=True`:

```
nvda_apr_eff = arm_nvda_apr + LTV * arm_borrow_apr
nvda_yield   = arm.nvda * nvda_apr_eff / 8760
borrow_cost  = arm.debt * arm_borrow_apr / 8760
net NVDA contribution = 3% APR of collateral
```

Production keeper must use the same convention. If the Spiral quote gives a net
3% APR, do not also subtract the full borrow cost again in the P&L; either
gross up as above, or record the 3% as a net yield and keep borrow cost in a
separate line. Add a test that the net NVDA line is exactly 3% of collateral
when debt = LTV × collateral.

### P0.3 Continuous 30% LTV sentinel

Current `borrow_size()` caps debt at borrow time. Always-arms drifts to 33.7% and
35% target drifts to 40.1% as NVDA falls. Add a keeper check that runs every
allocator tick:

```
if debt > 0 and debt / (nvda * price) > 0.30:
    repay enough to bring LTV back to 0.2975 (or 0.30 with a small buffer)
```

Do not wait for HF < 1.5. The 30% rule is a risk limit, not just a borrow-time
cap. Acceptance: max LTV ≤ 30.1% in a 45d replay with a 10% NVDA drawdown.

### P0.4 Fix the one-way door

The as-built allocator recalls the book, sees `guardPresent=false`, and never
reaches `returnToBooks` (`!guardPresent` is checked before `decidePoolSwitch`).
Until fixed, the allocator is essentially always-arms. The fix is already
modelled as `fix_empty_book_guard=True`: the guard-absent trigger must only fire
while the book actually has positions. Apply the same guard to production.

## 3. P1 — no-swap inventory / 50-50 re-add

### Rule

After a guard pull or recall, re-add the LP with the tokens you have. Do **not**
swap to force 50/50. Leave a reserve so the next guard re-add has both sides.

```
reserve_usd   = max(inventory_reserve_usd, inventory_reserve_pct * NAV)
reserve_nvda  = reserve_usd / price
reserve_usdg  = reserve_usd

# 1. Re-add the book (one action per allocator run)
#    Fund only the largest L that both idle balances support.
#    x_req, y_req = token_amounts(target_L, current_tick, range)
scale = min(1, idle_usdg / x_req, idle_nvda / y_req)
fund(scale * target_L)
# Excess tokens stay idle. No swap.

# 2. Optional surplus sweep (only if the arm is not cap-bound)
if idle_nvda * price > reserve_usd + surplus_nvda_min_usd:
    excess = min(idle_nvda - reserve_nvda, arm_collateral_room / price)
    allocate_nvda_to_arm(excess)
if arm.nvda > 0 and arm.debt < target_ltv * arm_collateral:
    borrow_usdg(min(target_debt - debt, borrow_room, max_borrow_per_call))
if idle_usdg > reserve_usdg + surplus_usdg_min_usd:
    lend_usdg(min(idle_usdg - reserve_usdg, lend_room))
```

### Current evidence

- The reserve/50-50 re-add is the part that works. It is already the model's
  default `funding_mode="scale"`; keep it.
- The surplus-to-arm leg is **not** a net win at $10k/20% caps. It adds actions,
  holds NVDA through the down move, and the 3% net yield is too small.
- Raising caps to 50% improves 45d but collapses 20d. Do not raise caps just to
  make the sweep work.
- If the goal is to use the arm at larger capital, require all of:
  1. verified net Spiral yield > 3% APR,
  2. borrow liquidity and a 30% LTV exit test,
  3. a tail hedge or a hard cap on NVDA inventory value,
  4. bootstrap p05 no worse than the no-sweep baseline.

### Implementation notes

- Add `surplus_sweep` as an opt-in keeper feature, default **off**.
- One action per allocator run; do not batch NVDA allocate + borrow + lend in
  one transaction unless the adapter supports it.
- Track `surplus_sweep` events and the idle-NVDA value; if idle NVDA stays above
  the reserve for N hours and the arm cap is full, log it rather than silently
  leaving it.
- Tests: reserve respected; no swap; arm cap respected; LTV ≤ 30%; NAV
  conservation; no action when below reserve.

## 3A. Large NAV — $100k / $250k / $500k / $1M / $2M

The model now has `fee_share_mode="exact"` for large books:

```
fee = rate × volume × L/(poolL+L),  poolL = volume/volOverL
```

Use it for any book whose `L` is more than ~5–10% of the pool's active `L`.
`run.py large` writes `out/large_nav_summary.csv`.

### Results (45d / last 20d, exact fee share, live $15k borrow liquidity)

| NAV | Always A 45d net / APR | Always B 45d net / APR | C 45d net / APR | C 20d net / APR | Book B L/pool |
|---|---:|---:|---:|---:|---:|
| $100k | +$1,451 / 11.8% | +$1,511 / 12.3% | +$4,248 / 34.5% | −$690 / −12.6% | 2.1% |
| $500k | +$6,579 / 10.7% | +$3,608 / 5.9% | +$20,679 / 33.6% | −$10,208 / −37.3% | 10.7% |
| $1M | +$11,742 / 9.5% | +$2,473 / 2.0% | +$40,164 / 32.6% | −$21,155 / −38.6% | 21.3% |
| $2M | +$19,036 / 7.7% | **−$3,726 / −1.5%** | +$76,349 / 31.0% | **−$44,405 / −40.5%** | 42.7% |

Annualized windows: 45d ×8.111, 20d ×18.25.

### What it means

- **Book A scales.** At $1M/$2M it is ~1–2% of its pool; its fee APR holds at
  ~17.4%/15.6% (vs 19.9% at $10k). Always-A stays positive.
- **Book B does not scale.** At $1M it is 21% of its pool, at $2M 43%; the exact
  share saturates and always-B turns negative at $2M. Cap Book B around
  **$250k–$500k** (L/pool 5–10%) unless the pool is deep enough.
- **C stays positive over 45d but the 20d is negative at $1M/$2M.** Do not
  linearly extrapolate the $10k C 20d (+$81.77). The large book's 20d loss is
  −$21k/−$44k; the path/idle/timing changes with size.
- **Arm caps are not the driver.** 20/50/100% relative caps give nearly the same
  1M/2M C 45d result; the arm is <$1k at these sizes. Raising caps does not fix
  the scale; the book/idle/timing does.
- **Exact fee share is required for Book B at 1M/2M**, not for Book A.

### Ship guidance

- Book A: ~$1M–$2M is feasible in-sample, but only with a fresh-tape/tail test.
- Book B: ~$250k–$500k maximum; above that the pool share dominates.
- Do not size the arm for 3% net; at 1M/2M it is a rounding error.
- Re-run `run.py large` after any fee-share, pool, or size change.

## 4. P2 — fee/IL rule

Replace any raw `fee > IL` check with:

```
fee_apr_24h = book fee over last 24h / book value * 8760/24
il_apr_24h  = |IL over last 24h| * 8760/24
hold/deploy if:
    fee_apr_24h > k * il_apr_24h + buffer_bps
    and expected_hours_in_range > min_hours
    and fee_usd_24h > gas_cost * expected_actions
```

Recommended starting values:

- `k = 1.0–1.5`
- `buffer_bps = 250`
- `confirm_hours = 8`
- `min_hours = 4–8`
- Do **not** pull the guard on the guard's own fee/IL signal; it churns.
- Use the rule for **book hold/deploy** and **guard re-arm**, not for a raw
  one-hour guard pull.

Current evidence: 45d +$302.11 / 20d +$19.47, DD −4.4%/−6.7%, but it does not
beat A/C. It is a defensive overlay for the 1h/10k/50 config, not a fee
maximizer.

## 5. P3 — width, guard share, skew

### Recommended tests

| Variable | Current | Test | In-sample result |
|---|---:|---:|---:|
| Base width | 6,000 | 3,000 | +$213.65 / −$93.83 (alone) |
| Guard width | 600 | 500 | +$212.12 / −$110.19 (alone) |
| Guard width | 600 | 900 | +$168.43 / −$38.28 (20d defense) |
| Guard share | 50% | 75% | +$273.69 / −$127.14 |
| Guard share | 50% | 80% | +$294.17 / −$133.90 |
| Skew | 0 | 1,000 | C +$502.26 / +$60.93 |
| Skew | 0 | 2,500 | C +$512.06 / +$81.77 |
| Allocator interval | 1h | 2h | +$325.65 / +$29.59 |
| Volume floor | $10k | $15k | +$314.17 / +$28.26 |

### Warning

All of these are in-sample. The 20-path bootstrap says the base/guard/skew
combination has a worse p05 than always-A. Do not ship a width/skew change unless
the fresh-tape test and bootstrap p05 are at least as good as the baseline.

### Order of experiments

1. Base width 3,000 alone (no skew, no 2h). This is the simplest change.
2. Guard width 500 or 900 alone. Choose 500 for 45d fees, 900 for 20d defense.
3. 2h interval + $15k floor. The $15k floor is the stronger single lever.
4. Guard share 75% only after 1–3.
5. Skew 1,000 (not 2,500) as a compromise; tail-test it.
6. Do not stack all of them without a fresh-tape test.

## 6. P4 — validation and ship criteria

### Fresh tape

Build a new scenario from the **next** 30–45 days of swaps:

```
node scripts/research/build_allocator_scenario.mjs
```

Do not tune on the same 45 days. If the new tape is not available, stop at
research; do not ship.

### Acceptance criteria

- `pytest -q research/cadcad/allocator/tests` → **76+ passed**.
- `run.py validate` → fees within 1% of the research sims.
- 45d and 20d: net vs HODL, drawdown, max LTV, gas, actions.
- 20-path block bootstrap: median, p05, mean, paired win rate vs always-A.
- **Ship only if p05 is not worse than the baseline and the mean is not worse
  than always-A.** The current C/D fail this.
- Max LTV ≤ 30.1% with the continuous sentinel.
- No unresolved oracle mismatch; no swap in the book funding path; no hidden
  idle-NVDA above the reserve for >24h without a logged reason.

### Commands

```powershell
$py = "research\cadcad\allocator\.venv\Scripts\python.exe"
& $py -m pytest -q research\cadcad\allocator\tests
& $py research\cadcad\allocator\run.py validate
& $py research\cadcad\allocator\run.py baseline
& $py research\cadcad\allocator\run.py optimize
& $py research\cadcad\allocator\run.py large
& $py research\cadcad\allocator\run.py mc-optimize --opt-paths 20
& $py research\cadcad\allocator\run.py mc --mc-paths 30
& $py research\cadcad\allocator\eth_compare.py --eth-usd-change 0
& $py research\cadcad\allocator\build_dashboard.py
& $py research\cadcad\allocator\build_scenario_dashboard.py
& $py research\cadcad\allocator\build_scenario_lab.py
```

## 7. Agent task checklist

- [ ] Fix the `.env.example` oracle mismatch; add a startup oracle assertion.
- [ ] Apply `nvda_apr_is_net=True` in the keeper P&L; add the net-NVDA test.
- [ ] Add the continuous 30% LTV sentinel; replay a 10% NVDA drawdown.
- [ ] Fix the `!guardPresent` one-way door (`fix_empty_book_guard`).
- [ ] Keep `funding_mode="scale"`; add the reserve/no-swap re-add.
- [ ] Add `surplus_sweep` default **off**; implement the reserve and one-action
      sweep; test at 20% and 50% caps; do not enable at $10k if p05 worsens.
- [ ] Add the fee/IL hurdle + hysteresis + gas rule; do not use a guard-specific
      fee/IL pull.
- [ ] Test base 3k, guard 500/900, 2h, 15k, guard 75% one at a time.
- [ ] Test skew 1,000 first; only test 2,500 if the tail is acceptable.
- [ ] Run `run.py large`; keep Book B ≤ $500k and require a fresh-tape/tail test
      before sizing Book A at $1M–$2M.
- [ ] Build a fresh tape; run the full suite and the 20-path MC.
- [ ] Ship only if p05 ≥ baseline and mean ≥ always-A; otherwise keep the
      defensive 1h/10k/50 config and document why.

## 8. Open questions

1. Is the 3% Spiral yield contractual, and does it scale with LTV? If yes, the
   gross-up formula changes; provide the exact formula.
2. Is the 3% net of **all** borrowing cost, including the USDG lend leg, or only
   the NVDA collateral leg? The model assumes the collateral leg.
3. What is the real borrow liquidity at the lower-utilization NVDA market? The
   snapshot shows ~$337; the model caps borrow at that.
4. What is the actual swap/slippage cost if the keeper ever needs to rebalance?
   The model uses 10 bps only in the swap-to-fund case.
5. Is the hook's guard pull EV-based? The 5-minute proxy never fires at 200 bps
   on this tape; the real hook may pull more. Need an oracle series.
6. What is the tail hedge or NVDA inventory cap if the skew is deployed?
7. What is the real pool depth and price impact at $1M/$2M? The model uses the
   exact fee share but no price impact/slippage; Book B is already 21%/43% of its
   pool at 1M/2M, so a real size cap needs the pool's active liquidity.
8. Is the 3% Spiral yield capacity-limited? At 1M/2M the arm is <$1k in the
   model because the caps/borrow liquidity bind; a larger allocation needs a
   verified capacity and a 30% LTV exit test.

## 9. Reference results

| Case | 45d net | 20d net | 45d fees | 20d fees | 45d DD | 20d DD |
|---|---:|---:|---:|---:|---:|---:|
| Risk-only 1h/10k/50 | +$191.04 | −$105.62 | $187.92 | $71.59 | −5.2% | −7.6% |
| A: 2h/15k/75 | +$431.36 | +$46.95 | $280.40 | $148.99 | −4.4% | −6.7% |
| C: 3k/500/2.5k skew | +$512.06 | +$81.77 | $338.07 | $207.69 | −4.5% | −6.7% |
| D: C + 80% guard | +$536.60 | +$75.79 | $339.39 | $207.29 | −4.6% | −6.7% |
| A + sweep | +$430.73 | +$46.87 | $280.40 | $148.99 | −4.4% | −6.7% |
| C no-skew + sweep | +$496.84 | +$50.72 | $307.95 | $174.26 | −4.5% | −6.7% |
| C + sweep + 50% caps | +$517.07 | −$70.34 | $342.17 | $43.23 | −4.5% | −7.0% |
| Always A | +$148.45 | −$146.21 | $245.65 | $62.44 | −5.7% | −7.9% |
| Always arms | +$12.87 | +$4.97 | $0 | $0 | −6.6% | −6.5% |

20-path bootstrap, median / p05 / win vs always-A:

| Config | 45d median | 45d p05 | 45d win | 20d median | 20d p05 | 20d win |
|---|---:|---:|---:|---:|---:|---:|
| Risk-only 1h/10k/50 | +$168.19 | −$473.36 | 30% | +$64.43 | −$78.37 | 25% |
| A: 2h/15k/75 | +$185.59 | −$552.51 | 30% | +$47.51 | −$133.92 | 35% |
| C: 3k/500/skew | +$220.63 | −$607.47 | 45% | +$68.47 | −$158.65 | 50% |
| D: C + 80% guard | +$218.04 | −$626.16 | 55% | +$71.41 | −$161.64 | 50% |
| Always A | +$214.16 | −$506.67 | — | +$79.33 | −$85.01 | — |

**The in-sample ranking is not the risk-adjusted ranking. Ship the defensive
config unless the fresh tape and the tail test say otherwise.**
