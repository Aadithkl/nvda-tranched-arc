# NVDA tranched vault — cross-machine handoff

Last saved: 2026-10-30  
Repo: https://github.com/Aadithkl/nvda-tranched-arc  
Branch: `main`  
This file is the context handoff so another PC can continue from GitHub.

## What is in the repo

- `scripts/keeper/` — the production keeper and its tests.
- `scripts/research/` — swap-tape collection and research helpers.
- `research/cadcad/allocator/` — 45-day cadCAD allocator model, tests, scenarios, dashboards.
- `research/cadcad/fee_allocator/` — fee-first pool allocator model, tests, dashboard.
- `src/`, `script/`, `test/` — Solidity vault, hooks, adapters, deploy scripts, Foundry tests.
- `docs/` — vault, dual-book, strategy, deployment notes.

## Keeper status

- `npm run test:keeper` — **256/256 pass**.
- `node --check` — keeper source and tests clean.
- `npm run keeper:preflight` — read-only deployment preflight; exits 1 with a clean config error when `KEEPER_RPC_URL` is missing.
- Safe defaults: `KEEPER_DRY_RUN=true`, `KEEPER_ALLOCATOR_EXECUTE=false`.

Implemented in this save:

- validated frozen config (`scripts/keeper/config.mjs`);
- deployment preflight (`scripts/keeper/preflight.mjs`);
- simulate-before-send executor with exact allowance approvals (`scripts/keeper/executor.mjs`);
- configurable LTV sentinel, independent of `KEEPER_ALLOCATOR_EXECUTE`;
- borrow APR + available-liquidity guard;
- 5-minute depeg recall and guard re-arm;
- 2-hour allocator + 5-minute safety tick;
- 24-hour fee/IL stats, worst-case IL, guard uptime, A/B switching with confirmation/gas/dwell;
- loop arm (borrow → lend) and gas-gated surplus sweep;
- reference-market advisory path (v3/v4 NVDA/USD + NVDA/ETH): price checks, market view, course-correction recommendations, **no external capital movement**;
- `KEEPER_COURSE_CORRECT_MODE=off|advisory|apply`; `apply` currently logs only.

Known gaps / not implemented in the keeper:

- **45m risk window / no volume floor / 24h A/B / low-fee exit** — design only. The keeper is still **36m / $15k** in the committed code.
- The production keeper A/B switch still uses **net APR after IL**. The **fee-only + 0.30 risk gate** exists only in the fee-first research model.
- The LTV sentinel and human-readable docs are in `scripts/keeper/README.md`.

## Research models

### Allocator cadCAD

- 45-day, 1,080-hour tape; Book A (0.05%), Book B (0.30%), Morpho USDG lend, Spiral/NVDA collateral/borrow.
- `research/cadcad/allocator/` — 76 tests.
- Focused study: `research/cadcad/allocator/out/pool_il_study.html` (128.8 KB, 12 charts). **90/100 PASS WITH NOTES.**
- Broad page: `research/cadcad/allocator/out/team_dashboard.html` (117 KB). **86/100 PASS WITH NOTES.**
- Old research dashboards: `out/dashboard.html`, `out/scenario_dashboard.html`, `out/scenario_lab.html`.

Headline in-sample results (45d / 20d, $10k):

| Case | Net vs HODL | Max DD |
|---|---:|---:|
| Always A | +$148.45 / −$146.21 | −5.73% / −7.90% |
| Risk-only A (1h/10k) | +$191.04 / −$105.62 | −5.19% / −7.65% |
| A 2h/15k/75 | +$431.36 / +$46.95 | −4.39% / −6.69% |
| Always arms | +$12.87 / +$4.97 | −6.60% / −6.48% |

- Book fees are 99%+ of carry; the arm is a safe harbor, not the return engine.
- Always A is the risk-adjusted benchmark; C/D win more often but have worse bootstrap p05.
- Book B is thin; cap it around $250k–$500k. Book A scales further in-sample.
- 20-path bootstrap p05: C/D are worse than Always A. Do not treat the in-sample C as proven alpha.

### Fee-first allocator

- `research/cadcad/fee_allocator/` — 505-case static sizing sweep, fee-only live rule, 11 tests.
- Rule: **fee-only** edge
  `0.30 fees − 0.05 fees − switch cost − $25 buffer`,
  with a **0.30 risk gate**: 3-hour trailing volume ≥ $2,000, volatility ≤ 300 bps, guard ≤ 200 bps / 2 pulls, depeg ≤ 200 bps, and a 5% pool-share cap.
- On HIGH risk, the 0.30 sleeve is cut by 0.05 per rebalance; never enters on HIGH.
- Dashboard: `research/cadcad/fee_allocator/out/dashboard.html` (347 KB).
- Baseline: 1.5× +$276 fee gain / +$21.89 vs risk-only / 15% end 0.30; 2× +$908 / +$527 / 22.4%; 10× +$9,011 / +$8,666 / 20.3%.
- Time split: 1.5× 41.3% hours / 73.3% exposure / 5.9% capital; 2× 54.6% / 95.6% / 10.9%.
- The research model review gate did not complete due to a provider free-usage limit; no score is claimed.

## Dashboards

Open locally:

- `research/cadcad/allocator/out/pool_il_study.html`
- `research/cadcad/allocator/out/team_dashboard.html`
- `research/cadcad/fee_allocator/out/dashboard.html`

Regenerate:

```powershell
python research\cadcad\allocator\build_pool_il_study.py
python research\cadcad\allocator\build_team_dashboard.py
python research\cadcad\fee_allocator\dashboard.py
```

## Quick start on another PC

```powershell
git clone https://github.com/Aadithkl/nvda-tranched-arc.git
cd nvda-tranched-arc
npm install
npm run test:keeper
$py = "research\cadcad\allocator\.venv\Scripts\python.exe"
& $py -m pytest -q research\cadcad\allocator\tests
& $py -m pytest -q research\cadcad\fee_allocator\tests
```

The allocator/Fee model venv and raw swap tapes are not committed. Create the venv from `research/cadcad/allocator/requirements.txt`; the 6 MB `scenario_45d.json` is committed so the models can run without the raw 1 GB tapes.

## Pending next steps

1. Decide whether the production keeper should use the fee-only + 0.30 risk gate (currently research only).
2. Implement the 45m / no-volume-floor / 24h / low-fee-exit policy in the keeper, then re-tape and bootstrap.
3. Re-run the fresh-tape / 20-path MC gate before live capital.
4. Re-run the fee_allocator review gate when the provider limit resets.
5. Keep `KEEPER_ALLOCATOR_EXECUTE=false` until the preflight, dry-run, and fresh-tape pass.

## Local-only / never committed

- `.env` and any keys.
- `research/data/` raw swap tapes (~1 GB).
- `research/out/`.
- `.venv/`, `__pycache__/`, `.pytest_cache/`.
- Large generated paths `baseline_paths.csv` (17 MB) and `optimize_paths.csv` (12 MB); regenerate from the model.

No secrets are in this repository. Set `KEEPER_PRIVATE_KEY` only in a local `.env` or the process environment.
