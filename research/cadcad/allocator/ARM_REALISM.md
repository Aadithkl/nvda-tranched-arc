# Is 3% USDG + 3% NVDA realistic in Morpho / Spiral?

Short answer:

- **3% USDG: yes, plausible.** Curated USDG lending venues were observed around
  **2.7%–3.8%**.
- **3% NVDA: not a native Morpho collateral APR; it can be a Spiral total-yield
  assumption.** NVDA is collateral in a Morpho market. Morpho does not pay
  collateral yield. Spiral Stake is a leverage execution layer that borrows USDG
  against stock tokens and loops the USDG into stablecoin strategies; the “up to
  55%” is a leveraged stablecoin yield. The model treats your 3% as a total
  yield on the NVDA collateral: it is worth ~$9.88 grossed up in the full
  always-arms loop, but the net NVDA contribution is 3% APR after borrow; the whole
  arm nets +$12.87 over 45d. In the risk-only allocator the NVDA line is ~$0.15.
- **3% borrow: not current.** The lower-utilization NVDA market borrows at
  **1.351%**; the high-utilization NetNet/Spiral market borrows at **107.29%**.
- The 3% + 3% + 3% case is therefore a **user/Spiral assumption**, not a fully
  observed market. It is modelled as a scenario; the realistic base case is
  **3% USDG + 0% NVDA + 1.35% borrow**, with the borrow capped by available
  liquidity.

## 1. What was checked

Morpho Blue API (`https://blue-api.morpho.org/graphql`, chain 4663) current
market state on 2026-10-24; VFAT/Morpho vault snapshots for USDG venues. The API
exposes current state, not a 45-day rate history, so the model treats arm rates
as scenarios and sweeps them.

### USDG lending venues

| Venue | Observed APY | Notes |
|---|---:|---|
| Steakhouse USDG V2 | ~3.75% | curated USDG vault; check caps/liquidity |
| spUSDG / USDG | ~2.72% | Spark-style USDG venue |
| syrupUSDG / USDG | ~3.62% | Maple/Syrup USDG venue |

These are current snapshots, not 45-day averages. They are consistent with a
**3% USDG** assumption. The model's user case uses 3%; the live case uses
**1.025%** (the lower-utilization NVDA market's supply APY) and the stress case
uses **103.73%** (the high-utilization market). The 3% USDG is the most
defensible of the three user assumptions.

### NVDA Morpho markets

| Market | Oracle | LLTV | Utilization | Borrow APY | Supply APY | Borrowable |
|---|---|---:|---:|---:|---:|---:|
| NetNet / Spiral NVDA `0x8b16891f...89c3e` | `0xED29...` | 62.5% | 97.63% | **107.29%** | **103.73%** | **$15,110.79** |
| Lower-utilization NVDA `0xf5ff7d54...b6e4c` | `0x37CF...` | 62.5% | 75.98% | **1.351%** | **1.025%** | **$337.20** |

The high-utilization market is the “deepest” NVDA market, but it is a trap for a
safe harbor: 97.63% utilized, 107.29% borrow, only $15.1k borrowable. A new
depositor is buying a high headline supply APY with exit/liquidity risk. The
lower-utilization market is safer but only has **$337** borrowable, which cannot
support a $10k Spiral loop at scale.

### Configuration mismatch

`.env.example` has:

```
SPIRAL_NVDA_ORACLE=0xED29D310cfa91778A5850538DA28ed42234Cb78c   # 0x8b16 market, 107.29% borrow
MORPHO_MARKET_ORACLE=0x37CF511fA79B8446f1C23D6a81Df117F28240bE0  # 0xf5ff market, 1.351% borrow
```

The Spiral arm is configured against the **high-utilization** market, while the
primary NVDA market is the **lower-utilization** one. If the Spiral arm is meant
to be the safe harbor, this is backwards. Fix the oracle/market pair before
deploying the arm, and add a borrow-liquidity check so the arm cannot try to
borrow $587 from a market with $337 available.

## 2. What Spiral actually is

Spiral Stake describes itself as “the leverage execution layer for digital
assets”: the user holds tokenized equities, borrows USDG against them, and loops
the USDG into `syrupUSDG` / `sUSDe` strategies. The stock is **collateral**, not
a yield-bearing asset. The advertised “up to 55%” is a leveraged stablecoin
yield, with liquidation levels, borrow rates, and fees shown before deposit. It
is not a 3% NVDA staking yield.

That means:

- **3% USDG** can come from the USDG lend leg (curated vault or Morpho market).
- **3% NVDA** has no native Morpho collateral source. It can be a Spiral strategy
  total yield (the model's assumption), an incentive, or a subsidy. Model it as a
  Spiral total-yield assumption; keep 0% as the stress base.
- **3% borrow** is a middle case between the safe market (1.35%) and the
  high-utilization market (107.29%). The 3% case is not current.

## 3. What the model says

Risk-only A, 45 days / last 20 days, $10k NAV, 20% arm caps:

| Arm case | USDG lend | NVDA yield | Borrow | Net vs HODL 45d | Net vs HODL 20d |
|---|---:|---:|---:|---:|---:|
| User assumption | 3.0% | 3.0% | 3.0% | **+$191.04** | **−$105.62** |
| Live / safe market | 1.025% | 0% | 1.351% | +$190.18 | −$106.09 |
| 3% USDG, no NVDA, 1.35% borrow | 3.0% | 0% | 1.351% | +$190.91 | −$105.79 |
| Stress / high-utilization | 103.73% | 0% | 107.29% | +$225.51 | −$124.07 |

The 3% NVDA assumption is worth only **~$0.15 over 45 days** and **~$0.18 over
20 days** in the **risk-only allocator**, because it holds the Spiral collateral
only briefly. The 3% USDG lend adds ~$0.7/$0.3 versus the 1.025% live case. The
full **always-arms** loop holds the collateral long enough to gross up to **$9.88**
of NVDA yield; after the $2.31 borrow cost the net NVDA contribution is 3% APR of
the collateral, and the whole arm nets **+$12.87** over 45d. The corrected
risk-only result is **negative in the 20d** at the production $10k volume floor;
the $15k floor is +$28.26.

The book is 99%+ of the reward. In the 45d risk-only A, book fees are **$187.92**,
while the arm contributes **$1.11 USDG + $0.15 NVDA** before $5.52 gas. In the
in-sample best C config, book fees are **$338.07** and the arm is **$1.54 + $0.11**.
At $10k with 20% caps, the 3% + 3% arm cannot move the result. The 3% NVDA is a
Spiral total-yield assumption, **APR after borrowing cost**; do not underwrite it
as a native collateral yield.

The no-swap **50/50 re-add with a reserve** works, but the **surplus-NVDA-to-arm
sweep does not pay at $10k**: A + sweep is +$430.73 / +$46.87 vs A +$431.36 /
+$46.95; C no-skew + sweep is +$496.84 / +$50.72 vs C +$512.06 / +$81.77. The 20%
arm cap is full and 3% net does not compensate for holding NVDA through a down
move. Raising caps to 50% gives +$517.07 / −$70.34. Keep the reserve and the skew;
leave the excess idle rather than force it into the arm.

The stress case (+$225 / −$124) is not a safe harbor. The high supply APY is
103.73% on a 97.63%-utilized market, and the 107.29% borrow triggers the keeper's
borrow-APR deleverage; the 20d is negative. The model caps the borrow at $15.1k,
but the headline APY is not free yield.

Arm caps change the book/arm timing more than the NVDA yield:

| Relative caps | 45d net | 20d net |
|---|---:|---:|
| 20% (production) | +$191.04 | −$105.62 |
| 50% | +$206.25 | −$9.44 |
| 100% | +$206.15 | −$9.44 |

The 20d improvement is mostly extra fee hours and delayed book re-entry, not the
3% arm yield. The $15k volume floor is stronger: +$314.13 / +$28.23. Combining
15k + 50% caps is +$306.33 / +$16.47, worse than 15k alone; do not stack levers
without testing.

### Spiral 30% vs 35% LTV

The 3% NVDA is modelled as a **total Spiral yield on the NVDA collateral**, not a
native Morpho collateral APR. The full always-arms loop holds it long enough to
earn it; the risk-only allocator does not.

| Arm / LTV | 45d net | 20d net | 45d max LTV | 20d max LTV | 45d NVDA yield | 45d USDG interest | 45d borrow |
|---|---:|---:|---:|---:|---:|---:|---:|
| Risk-only 29.375% | +$191.04 | −$105.62 | 29.4% | 29.4% | $0.15 | $1.11 | $0.00 |
| Risk-only 30% | +$191.04 | −$105.62 | 30.0% | 30.0% | $0.15 | $1.11 | $0.00 |
| Risk-only 35% | +$191.04 | −$91.44 | 35.0% | 35.0% | $0.15 | $1.11 | $0.00 |
| Always arms 29.375% | +$12.87 | +$4.97 | 33.7% | 32.0% | $9.88 | $7.54 | $2.31 |
| Always arms 30% | +$12.87 | +$4.97 | 34.4% | 32.6% | $9.88 | $7.54 | $2.31 |
| Always arms 35% | +$12.82 | +$4.96 | 40.1% | 38.1% | $9.88 | $7.54 | $2.75 |

At 30% LTV the full arm earns `$9.88 NVDA + $7.54 USDG − $2.31 borrow − $1.68 gas
= $13.43` net carry; the collateral mark takes it to **+$12.87** over 45d on
$10k. The NVDA line is grossed up because the 3% is **net of borrowing cost**;
the net NVDA contribution is 3% APR of the collateral. At 35% LTV the extra 5%
debt is roughly carry-neutral at a 3% borrow / 3% lend spread, but it drifts max
LTV to **40.1%** and adds liquidation risk without lifting the net NVDA yield.
The 35% LTV is **not justified**; keep the 29.375%/30% target and add a
continuous 30% LTV sentinel if the “<30%” rule is hard.

## 4. Recommendation

1. **Keep 3% USDG as the base lend-arm assumption**, sourced from a curated USDG
   vault or a deep Morpho USDG market with an exit test and a cap. 3% is
   plausible (observed 2.7%–3.8%).
2. **Treat the 3% NVDA as a Spiral total-yield assumption, APR after borrow**,
   not a native Morpho collateral APR. The model grosses it up by LTV×borrow APR
   and subtracts borrow; the grossed-up NVDA line is ~$9.88 in the full
   always-arms loop, the whole arm nets +$12.87, and the risk-only NVDA line is
   ~$0.15. If it is contractual, cap it and verify the 30/35% LTV; do not assume
   it scales with LTV. Keep a 0% NVDA base case for stress.
3. **Use the lower-utilization NVDA market `0xf5ff...` with oracle `0x37CF...`**
   if the Spiral arm is used. Fix the `.env.example` mismatch. Accept that only
   ~$337 is borrowable, or seed liquidity; do not point the arm at `0x8b16...`
   (107.29% borrow, 97.63% utilized).
4. **Treat the arm as a safe harbor, not a return engine.** The static book earns
   $245.65–$278.25 of fees on $10k over 45 days; risk-only A's arm earns $1.11;
   even the always-arms benchmark earns $7.54. The arm's job is to reduce
   drawdown, not to beat the book.
5. **Raise the USDG lend cap to 50% if the venue is safe**, but keep the NVDA
   collateral cap at 20% until the LTV/exit behavior is proven. The model's 50%
   case adds +$15.2 (45d) / +$96.2 (20d), but most of the 20d gain is book/arm
   timing and extra fee hours, not the 3% arm yield. The $15k volume floor is the
   stronger lever (+$314.13 / +$28.23); the 15k + 50% combination is
   +$306.33 / +$16.47, worse than 15k alone. Test one lever at a time.
6. **Keep the Spiral LTV at 29.375%/30%.** The 35% case lowers the full-arm net
   from +$12.87 to +$12.82 and drifts max LTV to 40.1% vs 34.4%; the extra debt is
   carry-neutral at 3%/3% but adds liquidation risk. The 3% NVDA net contribution
   is 3% APR of the collateral; do not hold the arm just for the 3%.
7. **Do not map the `.env` 50 bps to a guard-pull threshold.** It is a
   `recheckGuard` re-arm deviation band; the pull is EV-simulator based. The
   model's 50/100/200/300 settings are 5-minute move proxies, not the env
   parameter: 50 bps is −$13.00 / +$19.45, 100 bps is +$134.74 / −$130.42, 200
   bps is +$191.04 / −$105.62. The proxy is non-monotone. Keep the 200 bps
   deploy default; the env 50 band cannot be tested without an oracle series.
   Review it against the hook's EV/recheck logic instead of lowering it blindly.
8. **Do not rely on the allocator's timing for alpha.** The 45d/20d in-sample
   results are down-regime results. In the 30-path block bootstrap, risk-only
   10k beats always-A in only 36.7% of paired paths (median −$28.32, mean
   −$25.03); the 15k floor wins 40.0% (median −$32.30, mean −$20.31). Its p05
   drawdown is slightly better (−17.20% vs −17.68% at 10k), but the mean is
   worse. The defensible conclusion is that the risk-only policy reduces
   drawdown in the down regime; it is not a proven excess-return strategy.
9. **Do not deploy the inventory/width optimization as a return strategy.** C
   (3k base / 500 guard / 2.5k skew) earns +$512.06 / +$81.77 in-sample, but the
   20-path bootstrap p05 is −$607/−$159 vs always-A −$507/−$85, and its mean is
   lower (+$12.5/+$44.5 vs +$27.2/+$49.1). The extra NVDA inventory wins more
   often but loses more in bad paths. If you want a smaller version, a 1,000-tick
   skew keeps +$502/+$61 in-sample; it still needs a bootstrap/tail test. Always-A
   has the best mean and p05; 1h/10k/50 risk-only is the defensive alternative.
10. **Keep the no-swap reserve/50-50 re-add; leave the surplus idle at $10k.**
    A + sweep is +$430.73/+$46.87 vs A +$431.36/+$46.95; C no-skew + sweep is
    +$496.84/+$50.72 vs C +$512.06/+$81.77. The 20% arm cap is already full and
    the 3% net NVDA yield is too small to compensate for holding NVDA through a
    down move. Raising caps to 50% gives +$517.07/−$70.34. Enable the sweep only
    at larger capital with a verified higher yield, a 30% LTV exit test, and a
    tail hedge/cap.

## 5. Data provenance and limits

- Morpho Blue API current state, chain 4663, 2026-10-24. Market IDs:
  `0x8b16891f032a93b771347c9cb470a780e6699dd701553d3402aa3cdba6189c3e` and
  `0xf5ff7d546af5e72f3912d2aa723088fd0bf66fddc158714995637714d9db6e4c`.
- The API is current state, not a 45-day rate history. The model uses the
  user/live/stress rates as scenarios and sweeps them.
- The 3% USDG venues are snapshots; check caps, liquidity, and incentive
  expiry before treating them as a durable 3%.
- The model's arm results are conditional on the book/risk path. They are not a
  prediction of future Morpho rates.
