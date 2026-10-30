# NVDA pool research: downloads, simulation, and scale

This folder is **research only**. The keeper does not call VFAT; it uses on-chain
Uniswap data. The mainnet hook stack is not deployed yet (`deployments/robinhood-mainnet.json`
says `stack.status = "not deployed"`), so the simulator models the hook logic on the real
NVDA/USDG venue pools.

## Data set

| Target | Venue | Fee (pips / %) | Pool |
|---|---|---:|---|
| `v3-usdg-nvda-005` | Uniswap V3 | 500 / 0.05% | `0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3` |
| `v4-usdg-nvda-030` | Uniswap V4 | 3,000 / 0.30% | `0x3bb34a44f1b2b5f32c034c38a53065a521a47b199700fa9bd19d60985ff24bf1` |
| `v4-usdg-nvda-001` | Uniswap V4 | 100 / 0.01% | `0x6444a8e0b267406a15db74ca00c4a24bdfa81ed3180f5b6d0851f8ed6f4f29c5` |
| `v4-usdg-nvda-100` | Uniswap V4 | 10,000 / 1.00% | `0x6a41bdbdf82850998dd5f30588cde7a38447ba6334258ba91775e090155eb796` |

Uniswap fee values are **pips per 1e6** (500 = 0.05%), not bps. The keeper and simulator
use that unit.

## Run

```shell
# terminal 1: public RPC with browser headers
npm run robinhood:proxy

# one-day sample (V3 0.05% + V4 pools)
node scripts/research/download_swaps.mjs --days 1 --chunk 50000
node scripts/research/simulate_hook.mjs --target v3-usdg-nvda-005 --fee-pips 500

# 60-day backfill (use a provider RPC; public proxy is for samples)
$env:RESEARCH_OUT="research/data/swaps-60d"
node scripts/research/download_swaps.mjs --days 60 --chunk 100000 --target v3-usdg-nvda-005
$env:RESEARCH_SWAPS="research/data/swaps-60d"
node scripts/research/simulate_hook.mjs --target v3-usdg-nvda-005 --fee-pips 500

# VFAT 30-day prepared pool history (research snapshot; not a keeper dependency)
node scripts/research/fetch_vfat.mjs
```

The downloader is resumable (`checkpoint.json`); `--reset` wipes one target and starts over.
Dedupe in the simulator is by `txHash:logIndex`.

## Dataset status

| Target | 60-day status |
|---|---|
| `v4-usdg-nvda-030` | **complete** (44.4M → 96.2M blocks; 59,459 swaps) |
| `v3-usdg-nvda-005` | partial: 44.4M → 46.6M (2.55 days; 48,689 swaps); blocked by public-RPC 429 |
| `v4-usdg-nvda-001` | partial: 44.4M → 65.2M; blocked by public-RPC 429 |
| `v4-usdg-nvda-100` | 1-day sample only; effectively no flow |

Resume with a provider:

```shell
$env:RESEARCH_RPC_URL="https://your-provider/..."
$env:RESEARCH_OUT="research/data/swaps-60d"
node scripts/research/download_swaps.mjs --days 60 --chunk 50000 --to-block 96245937 --target v3-usdg-nvda-005
node scripts/research/download_swaps.mjs --days 60 --chunk 50000 --to-block 96245937 --target v4-usdg-nvda-001
```

The checkpoint resumes from the last completed chunk. `--to-block` skips `eth_blockNumber` so a
rate-limited head read cannot block the run.

## One-day sanity check

$10k, 50/50 base/guard, base ±6,000 ticks, guard ±600 ticks, no re-arm during the day:

| Venue | Fee | Swaps | Volume | Fee APR | Net APR | Net vs HODL |
|---|---:|---:|---:|---:|---:|---:|
| V3 0.05% | 500 | 6,194 | $4.52M | 29.9% | 27.2% | +$7.75 |
| V4 0.30% | 3,000 | 342 | $98k | 23.5% | 22.6% | +$6.38 |
| V4 0.01% | 100 | 4,987 | $571k | 12.4% | 9.9% | +$2.81 |
| V4 1.00% | 10,000 | 1 | $17 | n/a | n/a | n/a |

The day was favorable: the NVDA price fell ~0.6%, so IL was small (-$0.01 to -$0.78). This is
not a forecast. The 30-day VFAT backtest showed a much thinner net after IL (+0.22% over 30d
for a ±25% range), so longer windows matter.

### 60-day result (V4 0.30%, complete)

The 60-day V4 0.30% backfill completed:

| Swaps | Volume | Fees | Fee APR | Net vs HODL | Net APR | Guard in range |
|---:|---:|---:|---:|---:|---:|---:|
| 59,459 | $13.39M | $484.82 | 29.1% | +$458.69 | 27.5% | 86.1% |

The static base/guard model did not re-center the guard; the real hook would pull/re-arm when
the guard is out of range. Re-arm cost and the exact guard timing are still missing. The V4 1%
book had one swap in a day and is not viable without new flow.

### 45-day collated set

`research/data/swaps-45d/` (manifest included):

| Target | Rows | MB | Days | Complete |
|---|---:|---:|---:|---|
| V3 0.05% | 1,264,342 | 450.74 | 45.00 | yes |
| V4 0.01% | 314,154 | 108.05 | 41.84* | yes |
| V4 0.30% | 30,650 | 10.56 | 44.99 | yes |
| V4 0.0375% | 35,874 | 12.32 | 44.99 | yes |
| **Total** | **1,645,020** | **581.67** | — | — |

\* The block window is 45 days, but the V4 0.01% pool had no swaps in the first ~3 days of the
window, so observed activity spans 41.84 days.

$10k, 50/50 base/guard, base ±6,000 ticks, guard ±600 ticks:

| Pool | Fee | Swaps | Volume | Fees | Fee APR | Net vs HODL | Net APR | Guard in range |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| V4 0.30% | 3,000 | 30,650 | $7.63M | $276.26 | 22.4% | +$179.62 | **14.6%** | 92.0% |
| V3 0.05% | 500 | 1,264,342 | $587.8M | $245.19 | 19.9% | +$147.02 | 11.9% | 91.4% |
| V4 0.01% | 100 | 314,154 | $185.2M | $132.40 | 11.5% | +$107.05 | 9.3% | 70.1% |
| V4 0.0375% | 375 | 35,874 | $3.64M | $136.68 | 11.1% | +$40.71 | 3.3% | 95.8% |

The same V4 0.30% pool produced **+27.5% net over 60d**, **+14.6% over 45d**, and **−24.1% over
the last 20d**. Regime matters more than the long-run average; the guard/arm switch is doing real
work. The 1.00% book remains dead (one swap/day).

### ETH/NVDA 45-day set

`research/data/swaps-eth-45d/` + `manifest_eth_45d.json`:

| Target | Rows | MB | Days |
|---|---:|---:|---:|
| V3 WETH/NVDA 0.05% | 581,337 | 285.83 | 45.74 |
| V3 WETH/NVDA 0.30% | 89,800 | 44.16 | 45.74 |
| V4 WETH/NVDA 0.05% | 160,578 | 72.49 | 45.74 |
| **Total** | **831,715** | **402.48** | — |

$5 WETH, 50/50 base/guard, same ranges. **All PnL/APR values are WETH-denominated**:

| Pool | Fee | Swaps | Input WETH | Fees WETH | Fee APR | Net WETH | Net APR | Guard in range |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| V3 0.05% | 500 | 558,129 | 65,358.6 | 0.2493 | 40.4% | +0.2383 | **38.7%** | 68.5% |
| V3 0.30% | 3,000 | 82,685 | 3,786.2 | 0.2435 | 39.5% | +0.2333 | 37.8% | 74.9% |
| V4 0.05% | 500 | 158,065 | 4,859.0 | 0.1867 | 30.3% | +0.1754 | 28.5% | 66.0% |

To convert to USD, multiply the WETH result by the ETH/USD price over the same window; that
conversion is not included yet. The ETH-quoted pools were stronger than the USDG-quoted pools
over this 45-day window, but the guard was out of range much more often (66-75% in range).

### Last 20 days (same V4 0.30% pool)

The 60-day result is not the recent regime. Filtering the same data to the last 20 days:

| Swaps | Volume | Fees | Fee APR | Net vs HODL | Net APR | Guard in range |
|---:|---:|---:|---:|---:|---:|---:|
| 12,574 | $2.61M | $62.27 | 11.4% | **-$131.86** | **-24.1%** | 74.1% |

NVDA fell from ~$234 to ~$212 (-9.6%). Fees did not cover the IL; the static LP underperformed
HODL. This is exactly the regime where the allocator should prefer the arm, and the guard
re-arm model matters. The full 20-day V3 0.05% and V4 0.01% downloads are in progress.

**Do not** apply a different pool's fee tier to another pool's volume. The hook's book A/B have
their own volume; the V4 0.3% and 1% pools above are the closest real proxies. The V4 1% pool is
effectively dead (1 swap/day), so a 1% book is not viable without new flow.

## Allocator cadCAD model

`research/cadcad/allocator/` is the hourly allocator model: Book A (V4 0.05%, V3 0.05% tape
proxy), Book B (V4 0.30%), the Morpho USDG lend arm, the Spiral/NVDA collateral arm, guard
pulls/re-arms, one action per hour, arm caps, LTV/HF, gas, and a HODL benchmark. It is a port of
`scripts/keeper/allocator.mjs` / `index.mjs`, not a parallel design.

Static validation against the research sim above: Book A fees **$245.65 vs $245.19 (+0.19%)**,
Book B **$278.25 vs $276.26 (+0.72%)**; net vs HODL **+$148.45 vs +$147.02** and
**+$181.05 vs +$179.62**. The model reproduces the LP economics.

45 days, $10k, user arm case 3% USDG / 3% NVDA / 3% borrow, 200 bps pull proxy, no warmup,
90% funding:

| Policy | Net vs HODL | Max DD | Fees | Arm interest | Arms hours |
|---|---:|---:|---:|---:|---:|
| Always A | +$148.45 | −5.7% | $245.65 | $0 | 0 |
| Always B | +$181.05 | −5.7% | $278.25 | $0 | 0 |
| Always arms | +$12.87 | −6.6% | $0 | $7.54 | 1,080 |
| Allocator as built | −$6.64 | −7.1% | $7.07 | $7.38 | 1,056 |
| Fixed, net-APR gate | −$19.71 | −7.3% | $5.38 | $7.37 | 1,067 |
| **Risk-only A** | **+$191.04** | **−5.2%** | **$187.92** | **$1.11** | **269** |
| Risk-only B | +$6.35 | −6.6% | $0.09 | $7.53 | 1,079 |
| Risk-only A, live arm | +$190.18 | −5.2% | $187.92 | $0.38 | 269 |
| Risk-only A, caps 50% | +$206.25 | −5.1% | $190.51 | $1.87 | 274 |
| **Risk-only A, volume 15k** | **+$314.13** | **−4.3%** | **$231.89** | **$1.35** | **341** |
| **Risk-only A, 2h/15k/75%** | **+$431.36** | **−4.4%** | **$280.40** | **$1.56** | **408** |
| **C: 3k/500/2.5k skew** | **+$512.06** | **−4.5%** | **$338.07** | **$1.54** | **406** |

Last 20 days: risk-only A **−$105.62**, risk-only 15k **+$28.23**, 2h/15k/75% **+$46.94**,
C **+$81.76**, always-A **−$146.21**, always-B **−$151.13**, caps 50% **−$9.44**.

The 20d risk-only result is negative at the production $10k volume floor. The earlier +$42.89 was
not keeper-matching: it used a 6-hour warmup, 100% funding on re-entry, and mixed price/tick
marks. The corrected model uses no warmup, 90% of idle, one mark, event-based guard pulls, and the
liquidation/bad-debt and borrow-APR rules.

**Cadence.** 1h +$191.04 / −$105.62; 2h **+$325.65 / +$29.59**; 4h +$204.83 / −$130.04; 8h
+$225.07 / −$57.04. The 2h check reduces churn (167/160 actions vs 276/229) and improves both
windows in-sample; 4h/8h are too slow in the 20d. The 2h/15k/75% combo is +$431.36 / +$46.94 on
210/177 actions. Test 2h before changing production; the guard still checks every 5 minutes.

**Guard share.** 0/25/50/75% guard = +$44.45 / +$112.68 / +$191.04 / +$273.69 in the 45d and
−$13.91 / −$61.70 / −$105.62 / −$127.14 in the 20d. The guard does not prevent IL; it
concentrates fees. The 75% case only turns positive in the 20d with the 2h/15k filters. The 5-min
pull proxy (50/100/200/300 bps) is a stress, not the `.env` recheck/re-arm band.

**Spiral LTV.** Full always-arms: 29.375% +$12.87, 30% +$12.87, 35% +$12.82; max LTV 33.7/34.4/
40.1%. The 3% NVDA is APR **after borrowing cost**; the model grosses up the NVDA line by
LTV×borrow APR, so the net contribution is 3% APR of the collateral. The grossed-up NVDA line is
~$9.88 in the full arm but only ~$0.15 in the risk-only allocator. The extra 5% debt is
carry-neutral at 3%/3% but adds LTV drift and liquidation risk; 35% does not pay. Keep
29.375%/30% and add a continuous 30% LTV sentinel if the rule is hard.

**Book vs arm rewards.** In the 45d risk-only A, book fees are **$187.92** and the arm
contributes **$1.11 USDG + $0.15 NVDA** before $5.52 gas. In the in-sample best C config, book fees
are **$338.07** and the arm is **$1.54 + $0.11**. Always-arms earns **$7.54 + $9.88** gross but only
**$13.43 net carry** (1.1% on NAV, 3% on collateral) after $2.31 borrow + $1.68 gas. The 3% NVDA is
APR net of borrow. The book is 99%+ of the reward.

**No-swap 50/50 re-add + surplus sweep.** A + sweep is +$430.73 / +$46.87 vs A +$431.36 / +$46.95;
C no-skew + sweep is +$496.84 / +$50.72 vs C +$512.06 / +$81.77. The reserve/50-50 re-add works, but
pushing excess NVDA to the arm does not pay at $10k: the 20% cap is full and the 3% net yield is too
small. Raising caps to 50% gives +$517.07 / −$70.34. Keep the reserve and the skew; leave the excess
idle rather than force it into the arm.

**Inventory, swap, re-center.** After a recall the book re-funds only $6.1k–$6.8k of ~$10k because
the recalled token ratio no longer matches the LP. Swap-to-fund raises fees $188 → $275 but lowers net
$191 → $187 (the extra capital buys IL). Inventory skew (base 3k / guard 500 / skew 2.5k) raises
fees to $338 and net to +$512.06 / +$81.76 in-sample, but the 20-path bootstrap p05 is
**−$607 / −$159** vs always-A **−$507 / −$85**. Re-center at 500 bps is worse (+$62.54); 1,000 bps
never triggers. The skew is a tail-risk trade, not free alpha.

**Fee/IL rule.** A 24h fee/IL window with a 250 bps buffer and 8h confirmation improves the 1h
baseline from +$191/−$106 to **+$302.09 / +$19.45**, DD −4.4%/−6.7%. It does not beat 2h/15k/75 or C.
A guard-specific fee/IL pull is a churn failure (−$9.29/−$30.58, 136–225 pulls, fees $50–60). Use a
hurdle + hysteresis + gas, not a raw `fee > IL` trigger.

**Risk-adjusted ranking.** 20-path bootstrap: always-A median **+$214.16/+$79.33**, p05
**-$506.67/-$85.01**; risk-only 1h/10k/50 median +$168.19/+$64.42, p05 -$473.37/-$78.37; C median
+$220.62/+$68.43, p05 **-$607.47/-$158.65**; D median +$218.04/+$71.37, p05 -$626.16/-$161.64.
C/D win slightly more often (45–55% vs 30%/25%) but have much worse tails. Always-A has the best mean
and p05; 1h risk-only is the defensive alternative. Do not deploy C/D as a return strategy without a
tail hedge or a smaller skew.

**Large NAV.** With exact fee shares at $1M/$2M: always-A **+$11.7k/+$19.0k** (9.5%/7.7% net APR),
always-B **+$2.5k/−$3.7k**, C **+$40.2k/+$76.3k** over 45d (32.6%/31.0%) but **−$21.2k/−$44.4k**
over the 20d. Book B is 21%/43% of its pool at 1M/2M; cap it around $250k–$500k. Book A is ~1–2%
of its pool; $1M–$2M is feasible in-sample only with a fresh-tape/tail test. 20/50/100% arm caps
give nearly the same 1M/2M C result; the arm is <$1k. Do not linearly extrapolate $10k.

**ETH/NVDA vs USDG/NVDA.** ETH V3 0.05/0.30/V4 0.05: fee 40.4/39.5/30.3%, IL −1.8/−1.7/−1.8%,
net 38.7/37.8/28.5%, total +3.25/+3.20/+1.97% in ETH. USDG V3 0.05/V4 0.30/V4 0.01: fee
19.9/22.4/11.5%, IL −8.0/−7.8/−2.2%, net 11.9/14.6/9.3%, total −1.72/−1.37/−0.56% in USDG. ETH
wins in ETH unless ETH/USD falls more than ~4.8% (V3 0.05 pair). The ETH books are a separate
quote-asset comparison, not the USDG allocator.

The standalone dashboard is `research/cadcad/allocator/out/dashboard.html`, built with
`python research/cadcad/allocator/build_dashboard.py` (rewards waterfall, inventory/swap/recenter,
optimisation table, 20-path MC, ETH/USD slider, NAV simulation, cadence, guard share, LTV, and the
ETH/USDG decomposition). For a simpler display page, use
`python research/cadcad/allocator/build_scenario_dashboard.py` and open
`research/cadcad/allocator/out/scenario_dashboard.html`; it compares every single pool, Book A/B/arm,
the allocator scenarios, scaling, risk, and validation. For a non-technical audience, run
`python research/cadcad/allocator/build_simple_dashboard.py` and open
`research/cadcad/allocator/out/simple_dashboard.html` (0.05 pool / 0.30 pool / deploy-to-us /
hold NVDA / hold USDG at $100k, with the real price and state timeline). Run
`run_recommended_100k.py` and `run_comparison_100k.py` first to refresh the 100k paths.
For the 0.30-pool case sweep, run
`python research/cadcad/allocator/run_pool030_cases.py` and open
`research/cadcad/allocator/out/pool030_cases.html` (volume, share cap, timing rule, capital).
For the two-sleeve split and optimal-weight rule, run
`python research/cadcad/allocator/run_split_cases.py` and open
`research/cadcad/allocator/out/split_pool_cases.html`.
For the from-scratch cadCAD fee allocator with the 0.15/0.30 sleeves, run
`python research/cadcad/fee_allocator/run.py sweep` and
`python research/cadcad/fee_allocator/dashboard.py`, then open
`research/cadcad/fee_allocator/out/dashboard.html`.
For interactive what-if testing, use
`python research/cadcad/allocator/build_scenario_lab.py` and open
`research/cadcad/allocator/out/scenario_lab.html` (market presets, strategy grid, width grid).

The in-sample win is not robust. In a 30-path fixed-length block bootstrap of the same 45-day
tape, risk-only A at 10k beats always-A in only **36.7%** of paired paths (median **−$28.32**,
mean **−$25.03**); the 15k floor wins **40.0%** (median **−$32.30**, mean **−$20.31**). The 15k
variant improves the median (+$75.52 vs +$46.17 for always-A) and p05 drawdown (−17.13% vs
−17.68%), but the mean is still worse. Treat the 45d/20d outperformance as a down-regime timing
result, not proven alpha.

Key findings:

- **As-built allocator has a one-way door into the arms.** `!guardPresent` fires before
  `decidePoolSwitch`; after the book is recalled the guard is absent, so `returnToBooks` is
  unreachable. 1,056 of 1,080 hours in arms (23 funded) in the 45d; 479 of 480 in the 20d. The
  20d is +$4.06, essentially always-arms; the 45d is −$6.64 after the transition.
- **The net-APR gate churns.** The allocator header says "no APR comparison", but
  `tickAllocator` runs `decidePoolSwitch` on a 36-minute net APR annualized by 14,600. The fixed
  variant makes 318/158 actions and loses $19.71 (45d) / $0.46 (20d).
- **The $15k volume floor is the strongest single lever.** At $10k the risk-only earns +$191.04 /
  −$105.62; at $15k it earns +$314.13 / +$28.23 and keeps $231.89 of 45d fees. The floor selects
  high-volume/high-fee hours; the thin hours are where the book loses.
- **Book B is too thin for either floor.** Its 36-minute volume is usually ~$700; risk-only B
  funds 0 hours in the 20d and makes +$6.35 / +$2.60; the $1k-floor B variant is −$48.57 / −$3.73.
  Always-B is +$181.05 in the 45d but −$151.13 in the 20d.
- **The `.env.example` 50 bps is a re-arm deviation band, not a pull threshold.** The pull is
  EV-simulator based. The model's 50/100/200/300 settings are 5-minute pull proxies: 50 is
  −$13.00 / +$19.45, 100 is +$134.74 / −$130.42, 200 is +$191.04 / −$105.62. The proxy is
  non-monotone; the env value cannot be tested without an oracle series. Keep 200 as the deploy
  default.
- **3% USDG is plausible; 3% NVDA is a Spiral total-yield assumption, not native Morpho.** The 3%
  NVDA is APR **after borrowing cost**; the model grosses it up by LTV×borrow APR, so the net
  contribution is 3% APR of the collateral. The grossed-up NVDA line is $9.88 in the full
  always-arms loop and $0.15 in the risk-only allocator; the 3% USDG lend adds $3.76 over 0% (the
  live-vs-user difference is $0.86). The risk-only arm is mostly the USDG lend arm. See
  `research/cadcad/allocator/ARM_REALISM.md`.
- **20% arm caps leave ~55% idle in risk-off.** Raising both relative caps to 50% gives
  +$206.25 / −$9.44; 100% is +$206.15 / −$9.44. The 20d improvement is mostly book/arm timing and
  extra fee hours, not the 3% arm yield; the 15k floor is stronger, and 15k + 50% caps is
  +$306.33 / +$16.47 (worse than 15k alone).
- **30% LTV is a borrow-time cap, not a continuous cap.** Risk-only A maxes at 29.37%; always-arms
  and the as-built allocator drift to 33.68% as NVDA falls. `min_health_factor=2.083` caps the
  as-built at 30.0% and costs $1.13 (45d) / $0.86 (20d).

Run it:

```powershell
$py = "research\cadcad\allocator\.venv\Scripts\python.exe"
& $py research\cadcad\allocator\run.py validate
& $py research\cadcad\allocator\run.py baseline
& $py research\cadcad\allocator\run.py sweep
& $py research\cadcad\allocator\run.py optimize
& $py research\cadcad\allocator\run.py large
& $py research\cadcad\allocator\run.py mc-optimize --opt-paths 20
& $py research\cadcad\allocator\run.py mc --mc-paths 30
& $py research\cadcad\allocator\run.py mc --mc-paths 30 --risk-min-volume 15000
& $py research\cadcad\allocator\eth_compare.py --eth-usd-change 0
& $py research\cadcad\allocator\build_dashboard.py
& $py research\cadcad\allocator\build_scenario_dashboard.py
& $py research\cadcad\allocator\run_recommended_100k.py
& $py research\cadcad\allocator\run_comparison_100k.py
& $py research\cadcad\allocator\run_pool030_cases.py
& $py research\cadcad\allocator\run_split_cases.py
& $py research\cadcad\allocator\run_fee_break_even.py
& $py research\cadcad\allocator\build_simple_dashboard.py
& $py research\cadcad\allocator\build_scenario_lab.py
# open research\cadcad\allocator\out\dashboard.html
# open research\cadcad\allocator\out\scenario_dashboard.html
# open research\cadcad\allocator\out\simple_dashboard.html
# open research\cadcad\allocator\out\pool030_cases.html
# open research\cadcad\allocator\out\split_pool_cases.html
# open research\cadcad\allocator\out\fee_break_even.html
# open research\cadcad\allocator\out\scenario_lab.html
```

Build the scenario first with `node scripts/research/build_allocator_scenario.mjs`. The canvas is
`research/cadcad/allocator/MODEL_CANVAS.md`. The handoff plan is
`research/cadcad/allocator/IMPROVEMENT_PLAN.md`.

## Scale plan

- **Backfill**: `eth_getLogs` in 50k-500k block windows, filtered by pool ID/address, with
  checkpointing and exponential backoff. 60 days is ~52M blocks; the V3 pool produced ~6.2k
  swaps/day in the sample, so ~0.4M swaps for 60 days. JSONL is ~1-2 KB/swap; Parquet is much
  smaller.
- **Provider**: the public `rpc.mainnet.chain.robinhood.com` is behind Cloudflare and rate-limits
  sustained backfills. The 60-day V4 0.30% run completed, but the V3 0.05% and V4 0.01% runs hit
  `429 Too Many Requests` on `eth_blockNumber`/`eth_getLogs`. Use Alchemy/Chainstack/QuickNode for
  the rest; the downloader now backs off 429s and splits ranges that exceed the node's 10k-log
  cap. The local proxy is only for samples.
- **Indexer for continuous data**: use Envio/Goldsky/Subgraph for Uniswap v4 `Swap` logs, or a
  websocket subscription; do not poll 52M blocks every hour.
- **Storage**: JSONL for the prototype; convert to Parquet partitioned by `target/date` and query
  with DuckDB. A 60-day, 4-pool set is small enough for a laptop; a 2-year/all-pool set is not.
- **Simulation**: the Node simulator is a prototype; for millions of swaps use a vectorized
  DuckDB/Polars job. Compute fees from the input notional, the pool active liquidity share, the
  actual tick range, and the guard state.
- **Hook fidelity next**: the cadCAD model covers the hook's base/guard ranges, 5-minute guard
  proxy, guard pull/re-arm, the allocator's one-action-per-hour loop, and the Morpho/Spiral arms.
  Still missing: the hook's EV simulator / `recheckGuard` oracle deviation, Chainlink depeg
  history, the vault's senior/junior tranche accounting, and controller timelocks.

## Caveats

- The mainnet hook/vault is not deployed; no hook-owned pool swaps exist yet.
- The simulator does not include re-arm swap costs, gas, or the vault's senior/junior
  accounting. Those must be added before using the output for capital decisions.
- VFAT history is 30 closed days; the 2-month view requires the on-chain backfill or multiple
  VFAT backtest windows.
