# Self-run keeper (Yearn-style)

A long-running process, not GitHub Actions and not a managed keeper network.

```
poll triggers -> pure decisions (decide.mjs / allocator.mjs) -> execute -> alert
```

Modelled on Yearn's keeper split: trigger checks are pure functions, the runner executes them,
and every action is bounded on-chain.

## What it does

| Check | Cadence | Contract call | Safety |
|---|---|---|---|
| Depeg heartbeat | 5m loop; performs when `checkUpkeep` says due and `lastDepegCheck` is older than `KEEPER_HEARTBEAT_SECONDS` (30m) | `DepegHeartbeat.performUpkeep()` | Vault latches only on a TWAP-vs-stock divergence sustained for `minDuration` |
| Depeg recall | 5m loop; when `vault.depegPaused()` is true and the active book still holds base/guard liquidity or idle quote/equity | `VaultStrategyAgent.submitRecall()` | Safety: pulls the guard and hook idle inventory to the vault (base stays in the pool). Gated by `KEEPER_AGENT` / `KEEPER_DRY_RUN`, never `KEEPER_ALLOCATOR_EXECUTE` |
| Guard re-arm | 5m loop; rechecks when the guard is absent, deployments are enabled, and `pulledAt` is older than `KEEPER_RECHECK_SECONDS` (5m) | `PoolGuardHook.recheckGuard()` | Permissionless; re-arms only inside the recheck band |
| Arm LTV sentinel | 5m loop | `VaultStrategyAgent.submitDeleverage(arm, repay, 0)` | Repays to target LTV when debt/collateral exceeds `KEEPER_ARM_MAX_LTV_BPS` |
| Arm health / borrow APR | 5m loop | `VaultStrategyAgent.submitDeleverage(arm, repay, 0)` | De-leverages below `KEEPER_MIN_HEALTH_FACTOR` or above `KEEPER_MAX_BORROW_APR_BPS` |
| Loop carry exit | 5m loop | `submitDeleverage(arm, repay, 0)` then `submitDeleverage(arm, 0, collateral)` | Economic unwind when lend − borrow spread falls below `KEEPER_ARM_EXIT_SPREAD_BPS` |
| Sleeve risk (optional) | 5m loop | `Sleeve.deRisk()` / `pause()` | De-risk only; never opens or adds leverage |
| Risk allocator (optional) | every `KEEPER_ALLOCATOR_INTERVAL_SECONDS` (2h) | typed `VaultStrategyAgent` calls | Scan, A/B carry and switch, sweep, loop entry; caps enforced on-chain |

## Cadence: 2h economics, 5m safety

The process loop sleeps `KEEPER_INTERVAL_SECONDS` (default **300s**). Every tick runs the safety
paths:

- depeg heartbeat (the contract call is due every `KEEPER_HEARTBEAT_SECONDS`, default 30m);
- depeg recall: if `depegPaused()` is true and the active book still holds inventory, recall it
  (guarded by `KEEPER_AGENT` / `KEEPER_DRY_RUN`, not by the allocator execute flag);
- guard recheck (due every `KEEPER_RECHECK_SECONDS`, default 5m);
- sleeve check, if a sleeve is configured;
- the arm block: LTV sentinel, health-factor / borrow-APR de-leverage, and the loop carry exit.

The allocator body is separate. It runs only when `KEEPER_ALLOCATOR_ENABLED=true`
(default **false**) and at least `KEEPER_ALLOCATOR_INTERVAL_SECONDS` (default **7,200s = 2h**)
has elapsed. That run does the expensive work:

- fetch/refresh the rolling 24h `Swap` cache for every candidate and the active book's guard
  history;
- scan the configured candidates and compute fee APR after worst-case IL;
- decide carry (stay in the book vs. move to the arms) and confirm a switch;
- return/fund the book, sweep surplus, and enter the loop.

Safety is faster than economics on purpose. A depeg, a pulled guard or an over-LTV arm is a few
view calls and must not wait two hours. The depeg recall is on the 5m loop for the same reason:
the latch blocks risk-up, but it does not take inventory that is already in the book out of the
pool. An allocator run fetches up to a day of logs per pool in chunked `getLogs` calls and may
send several typed transactions; running it every 5 minutes would hammer the RPC for data that
changes slowly.

The arm block (LTV, HF/APR, loop exit) runs on the 5m loop even when
`KEEPER_ALLOCATOR_ENABLED=false`. Only the 2h scan/switch/sweep/entry block is disabled by that
flag.

Two independent gates control writes:

- `KEEPER_DRY_RUN=true` (default) blocks **every** send. Plans are still logged.
- `KEEPER_ALLOCATOR_EXECUTE=false` (default) blocks the economic paths only: allocator entry,
  return/fund/recall, sweep, switch, and loop exit. The safety paths send whenever
  `KEEPER_DRY_RUN=false` and `KEEPER_AGENT` is set, so an emergency never waits for the allocator
  flag: the depeg recall, the LTV sentinel (the 30% hard cap) and the HF/APR de-leverage. All are
  still evaluated every tick with execute off; a dry-run keeper only logs the planned move.

## What it does not do

- No arbitrary calldata. The keeper only calls `submitRecall`, `submitFund`,
  `submitAllocate`, `submitAllocateCollateral`, `submitBorrow`, `submitDeallocate`,
  `submitDeleverage`, `submitSwitchBook`, and exact `submitApproveStrategy` allowances. The
  sleeve only calls `deRisk()` / `pause()`; the hub only calls `performUpkeep()`; the hook only
  calls `recheckGuard()`.
- No swaps. The keeper moves quote and equity between the vault, the books and the Morpho arms;
  it never trades inventory.
- No external analytics API. Fees, volume, IL, guard uptime and market state come from on-chain
  logs and views.
- No book-vs-arm APR comparison. The allocator keeps a book when fee after IL is positive and
  does not require that yield to beat the arm's lend/borrow rate. The loop's own carry test is
  lend APR − borrow APR, a separate decision.
- No automatic cap, timelock or adapter changes. Those remain governance actions.

## Run

```shell
cp .env.example .env
# fill KEEPER_RPC_URL, KEEPER_VAULT, KEEPER_HEARTBEAT, KEEPER_HOOK
# optional: KEEPER_ARM_ADAPTER, KEEPER_USDG_ADAPTER, KEEPER_AGENT
# KEEPER_DRY_RUN=true is the default: logs intended actions, sends nothing
npm run keeper:dry

# to send transactions
KEEPER_DRY_RUN=false KEEPER_PRIVATE_KEY=0x... npm run keeper:run
```

The 2h allocator is off until `KEEPER_ALLOCATOR_ENABLED=true`; it only sends when
`KEEPER_ALLOCATOR_EXECUTE=true` and `KEEPER_DRY_RUN=false`:

```shell
# 2h economics on (scan/carry/switch/sweep/loop entry) but still dry-run
KEEPER_ALLOCATOR_ENABLED=true npm run keeper:dry

# actually send allocator moves
KEEPER_ALLOCATOR_ENABLED=true KEEPER_ALLOCATOR_EXECUTE=true \
  KEEPER_DRY_RUN=false KEEPER_PRIVATE_KEY=0x... npm run keeper:run
```

The key must be authorised for whatever it executes:

- `DepegHeartbeat.performUpkeep` is permissionless (gas only).
- `PoolGuardHook.recheckGuard` is permissionless (gas only).
- `SpiralNvdaSleeve.deRisk/pause` require the key to be the sleeve's `keeper`.
- The arm LTV/HF/loop paths, the sweep and the allocator call the **agent relay**
  (`KEEPER_AGENT`) and require the key to be the `VaultStrategyAgent` operator. The controller
  and module still enforce their caps; being the operator does not bypass them.

## Preflight

```shell
npm run keeper:preflight
```

Read-only: it never signs, never needs `KEEPER_PRIVATE_KEY`, and never writes state. If a key is
present it is used only to derive the wallet address and compare it with the agent operator.

Fatal checks (exit code 1 when any fails):

- `rpc-chain-id`, `contract-code`, `agent-operator`, `controller-vault`, `hook-active-pool`,
  `books-initialized`, `adapter-wiring`, `market-params`, `module-adapter-config`,
  `controller-bounds`.

Non-fatal checks (printed as WARN, exit code 0): controller/vault state, guard params, Morpho
market snapshot, IRM borrow APR vs. `KEEPER_MAX_BORROW_APR_BPS`, switch dwell, and ETH/USD
freshness. An invalid config also exits 1.

Market parameters come from the deployment, not from this repo: each adapter's
`marketParams()` supplies loan/collateral token, oracle, IRM and LLTV, `adapter.morpho()` supplies
the Morpho singleton, and the IRM's `borrowRateView` supplies the live rate. No market id, oracle,
LLTV or price is hardcoded. `KEEPER_ALLOCATOR_EXECUTE=true` implies strict config validation, so
the core addresses and pool ids must all be set before execution can start.

Run it before enabling sends, and again after changing adapters, caps, pool ids or the agent.

## Run it as a service

systemd:

```ini
[Unit]
Description=NVDA keeper
After=network-online.target

[Service]
WorkingDirectory=/opt/nvda-tranched-arc
EnvironmentFile=/opt/nvda-tranched-arc/.env
ExecStart=/usr/bin/node scripts/keeper/index.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Docker:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY scripts ./scripts
CMD ["node", "scripts/keeper/index.mjs"]
```

The process is a single loop. It handles `SIGINT`/`SIGTERM`, logs scans, decisions, planned
moves and sent transactions, and keeps running after a failed tick (the error is logged and, if
configured, alerted).

## Alerts

Set `KEEPER_WEBHOOK_URL` to a Slack-style incoming webhook. The keeper POSTs
`{"text": "..."}` when a tick, depeg check, depeg recall, arm check or allocator run throws, and
when a safety condition cannot be funded. A webhook failure is logged and never stops the loop.

## Tests

```shell
npm run test:keeper
```

The full keeper suite covers:

- **config**: defaults, overrides, candidate-pool parsing, strict/execute address requirements,
  numeric ranges, and the guarantee that `KEEPER_PRIVATE_KEY` never enters the config object;
- **stats**: volume/fees/fee APR, tick and price IL, worst-case IL, guard uptime, swap-cache
  merge/prune, chunked block ranges, and `getLogs` chunking;
- **allocator**: risk scoring, the guard safe-harbor gate, arm/book entry and exit plans, LTV
  repay math, loop spread/gas payback/entry/exit, surplus sweep, and switch ranking plus
  confirmation;
- **decisions**: depeg, sleeve, guard and arm risk-down decisions.

## Arm LTV, borrow guard and the loop

### LTV target and sentinel

- `KEEPER_ARM_MAX_LTV_BPS=3000` (30%) is the operator hard cap.
- `KEEPER_ARM_TARGET_LTV_BPS=2937` (29.37%) is the target the sentinel repays to.
- On first use (then cached) the effective target is
  `min(config target, hard cap, adapter targetLtvOfLltvBps × LLTV / 1e18)`. For the Spiral
  deployment, 4,700 bps of a 62.5% LLTV gives 2,937 bps. If the adapter read fails, the keeper uses
  the configured target clamped to the hard cap and does not infer an LLTV; the fallback is not
  cached, so a later tick retries the adapter.
- Every 5m tick reads `debt()` and `collateralValue()`. If debt/collateral is above the **hard
  cap**, `ltvRepayAmount` repays enough to return to **target**, not merely to the cap. A partial
  repay is allowed when the vault cannot fund the full amount. Repay paths may add
  `KEEPER_REPAY_BUFFER_USDG` and rely on the module to refund the excess. If debt exists with zero
  collateral value, the sentinel is skipped and an alert is sent; the HF/APR path still runs.
- The LTV sentinel owns the tick when it has a repay amount. Otherwise the HF/APR check runs.
- The LTV sentinel is a safety path: it sends whenever `KEEPER_DRY_RUN=false` and `KEEPER_AGENT`
  is set, regardless of `KEEPER_ALLOCATOR_EXECUTE`. With no agent configured it logs and alerts
  instead. Dry-run logs the plan without reading the vault balance.

### Borrow guard

`KEEPER_MAX_BORROW_APR_BPS=3000` (30%) is both the arm de-leverage ceiling and the borrow gate.
Before any borrow the keeper:

1. reads the arm's `borrowAprBps()` and refuses if it is above the ceiling;
2. reads the Morpho market (`market(marketId)`) and computes available liquidity as
   `totalSupplyAssets − totalBorrowAssets` (floored at zero);
3. caps the borrow to controller `maxBorrowPerCall`, module borrow headroom, and that available
   liquidity.

A failed market read is fail-closed: no borrow, no loop entry, and no borrow step in the sweep.

### Loop arm (carry)

| Key | Default | Meaning |
|---|---|---|
| `KEEPER_ARM_LOOP_ENABLED` | `true` | Allow entering the loop |
| `KEEPER_ARM_MIN_SPREAD_BPS` | `100` | Minimum lend − borrow spread to enter |
| `KEEPER_ARM_EXIT_SPREAD_BPS` | `0` | Exit when the spread falls below this |
| `KEEPER_ARM_MIN_BORROW_USD` | `50` | Minimum borrow size to enter |
| `KEEPER_ARM_COLLATERAL_ALWAYS` | `false` | Keep adding collateral even when the loop is not viable |
| `KEEPER_MAX_PAYBACK_DAYS` | `30` | Maximum gas payback period |

`spread = lend APR − borrow APR`, both in bps:

- lend APR is derived on-chain from the lend market's IRM `borrowRateView`, utilisation and fee;
- borrow APR comes from the arm adapter's `borrowAprBps()`.

Entry requires the loop enabled, spread at/above the minimum, a borrow at/above the minimum USD,
gas payback within `KEEPER_MAX_PAYBACK_DAYS`, and a healthy borrow guard. A usable loop also
requires `KEEPER_USDG_ADAPTER`: without it the keeper will not borrow (the borrowed USDG would
idle) and the quote leg is skipped.

What one entry does over successive allocator runs (one move per run):

1. lend most idle quote: target `KEEPER_MORPHO_ARM_SHARE_BPS=8000` (80% of total quote, idle plus
   already deployed) via `submitAllocate`;
2. add equity collateral in slices of `KEEPER_NVDA_STEP_BPS=1000` (10% of total NVDA) via
   `submitAllocateCollateral`;
3. top the debt up to the target LTV via `submitBorrow`, then **in the same run** approve and
   `submitAllocate` the borrowed quote into the lend arm. This borrow → lend pair is the one
   exception to one move per run, so the borrowed USDG never sits idle.

Borrow size uses live arm collateral value, capped by the target LTV, the hard cap, the adapter
ceiling, the controller cap, module headroom and Morpho liquidity. If the loop is not viable, the
quote leg still goes to the lend arm (it earns the lend APR either way); the equity collateral
leg is skipped unless `KEEPER_ARM_COLLATERAL_ALWAYS=true`.

Gas payback is `gas cost / (amount × APR / 10,000 / 365)`. Gas cost uses
`KEEPER_GAS_UNITS_PER_ACTION` (500,000), the live gas price, and ETH/USD from
`KEEPER_ETH_USD_FEED` or the `KEEPER_ETH_USD` override. If neither is set, gas cost reads as
zero and the payback gate does not block; configure a feed or the override in production.

Exit is economic and runs on the 5m tick, but only when no LTV/health path acted: when the spread
falls below `KEEPER_ARM_EXIT_SPREAD_BPS`, the loop repays debt first (a
`KEEPER_DELEVERAGE_BPS=1000` slice, default 10%), then withdraws collateral on a later tick. It
requires `KEEPER_ALLOCATOR_EXECUTE=true`; if the spread cannot be read, the position is held. With
`KEEPER_ARM_COLLATERAL_ALWAYS=true`, a collateral-only position is not exited.

## Risk allocator and A/B switching

The book is the yield venue; the Morpho arms are the safe harbor and the carry destination. The
allocator scans the configured candidates — `KEEPER_CANDIDATE_POOLS` when set, otherwise book A
and book B from `KEEPER_BOOK_A_POOL_ID` / `KEEPER_BOOK_B_POOL_ID` — from one rolling `Swap` log
cache, using two windows:

- **risk window** (`KEEPER_STATS_LOOKBACK_BLOCKS=21600` × `KEEPER_BLOCK_TIME_SECONDS=0.1s` ≈
  **36m**): volume and price fluctuation. Annualization uses the actual block span.
- **fee/IL window** (`KEEPER_FEE_WINDOW_SECONDS=86400`, **24h**): fee APR, worst-case IL and guard
  uptime. The window is converted to blocks with the same block time; at 0.1s that is 864,000
  blocks.

The pool's on-chain `slot0.lpFee` is authoritative; `KEEPER_BOOK_A_FEE_PIPS` /
`KEEPER_BOOK_B_FEE_PIPS` are fallbacks. A pool below
`KEEPER_MIN_POOL_LIQUIDITY_USD=10000` active liquidity is scored HIGH
(`thin-active-liquidity`) and is not a switch target.

A run is evaluated in this order:

1. **depeg or controller stop** — if the vault is `depegPaused`, or the controller is `paused` /
   `switchFrozen`, recall the book only. Arm positions are left alone. The 5m tick already recalls
   on a depeg; this branch is the primary path for controller `paused` / `switchFrozen` and a slow
   backstop for the depeg recall. It is gated by `KEEPER_AGENT` / `KEEPER_DRY_RUN`, not by
   `KEEPER_ALLOCATOR_EXECUTE`.
2. **guard / risk safe harbor** — a funded book with more than `KEEPER_MAX_GUARD_PULLS` pulls
   since the previous allocator run, or a current book scored HIGH, moves to the arms. Guard
   absence alone is **not** a trigger: a recalled book is guard-less by design
   (`recallToVault` keeps the base). Pulls up to the max, or a pull inside
   `KEEPER_GUARD_COOLDOWN_SECONDS`, are a **wait/re-arm** state; the allocator funds/stages the
   book and lets `recheckGuard` re-arm it. The pull count resets each allocator run.
3. **rank candidates** by `netAprBps` (fee APR after worst-case IL), skipping HIGH-risk
   candidates.
4. **stale-data gate** — see below.
5. **confirmation** — the target must persist for `KEEPER_SWITCH_CONFIRM_SECONDS=28800` (8h).
   The pending target lives in memory, so a process restart restarts the timer.
6. **act** — HOLD returns/funds the book and then sweeps; ARMS enters the arms; SWITCH runs the
   remaining gates.

### A/B switch gates

- The best book must clear `KEEPER_SWITCH_BUFFER_BPS=250` and strictly beat the current book by
  the buffer.
- The switch gas (about four actions) must pay back within `KEEPER_MAX_PAYBACK_DAYS`, using the
  current book value and the net-APR edge.
- The controller's `switchDwell` / `lastSwitchAt` must allow the move. An unreadable dwell gate
  fails closed.
- The target book must be initialized with non-zero `guardParams.guardLiquidity`.
  `KEEPER_REQUIRE_BOTH_BOOKS=true` (default) also requires the other book to be ready.
- Only a candidate with a venue adapter (`book` 0 or 1) can be a switch target; an external
  candidate is ranked but never switched to.
- If capital is still in the arms when a switch is confirmed, the keeper unwinds at
  `KEEPER_SWITCH_UNWIND_BPS=10000` (a full step instead of the normal 25%) and switches on a
  later run. Repay, collateral withdrawal and quote deallocation still take one step each.

### Carry policy

`KEEPER_CARRY_ARM_ENABLED=true` (default) makes the arms the destination when no eligible book
has a positive net APR after IL, after the same confirmation. A book with positive fee-after-IL
stays or returns without being compared with the arm's lend/borrow rate. This is a policy choice,
not a risk signal: it uses fee vs. IL, and the HIGH-risk, depeg and guard gates still override it.

### Stale data

A stale cache can be displayed but never licenses a move. If any scanned book's 24h swap cache is
stale, or its guard-uptime read failed, a non-HOLD decision is forced to HOLD
(`stale-fee-data`) and the pending switch is cleared. A failed swap fetch keeps the old entries,
does not advance `lastFetchedBlock`, and retries the gap next run. `KEEPER_BLOCK_TIME_SECONDS=0`
produces a zero-block fee window and therefore blocks every non-HOLD decision until a real block
time is set.

Use a provider RPC for the 24h log history. The first run fetches the whole window per candidate;
later runs fetch only new blocks. `KEEPER_LOGS_CHUNK_BLOCKS=50000` splits `getLogs`; lower it if
the RPC caps block ranges.

### Surplus sweep

When the active book is fully funded and the allocator holds, idle surplus can be swept to the
arms. `KEEPER_SURPLUS_SWEEP=true` by default; each move must clear
`KEEPER_SURPLUS_MIN_USD=25` and its gas payback. The reserve is

```
reserve = max(KEEPER_INVENTORY_RESERVE_USD, KEEPER_INVENTORY_RESERVE_PCT_BPS × NAV / 10_000)
```

with defaults `$1,000` and `5%` of NAV. It is applied to the quote leg and to the equity leg
separately, so the vault keeps a USD buffer on both sides.

One action per run, in priority order:

1. **equity surplus → arm collateral** — only when the loop is enabled and the spread clears
   `KEEPER_ARM_MIN_SPREAD_BPS`, with collateral room and borrow liquidity available;
2. **borrow → target LTV** — capped by borrow room and available liquidity;
3. **quote surplus → lend arm** — capped by lend room.

No swaps. Sweep requires `KEEPER_ALLOCATOR_EXECUTE=true`; with execute off it is not evaluated at
all.

## Reference market view (external pools, read-only)

The keeper also reads a small set of **external** NVDA markets so its own bands stay honest.
They are market values, not venues: the keeper never adds liquidity to them, never moves capital
between them and this deployment, and never signs for them. Only reads are issued (`slot0` /
`liquidity` on v3, `getSlot0` / `getLiquidity` on v4, token `decimals`, and `Swap` logs).

### Pools

Three or four pools is the expected size: at least one NVDA/USD pool and one NVDA/ETH pool, across
fee tiers and both Uniswap versions.

- `reference-pools.mjs` ships **disabled placeholders**. Fill an entry in and set `enabled: true`,
  or
- set `KEEPER_REFERENCE_POOLS` to a one-line JSON array (same schema; parsed and validated by
  `config.mjs`). `KEEPER_REFERENCE_POOLS=[]` is valid: the reference path is simply off.

Replace the placeholders with real pools by **address** (v3) or **pool id + PoolManager** (v4).
The registry is not a live pool list; no address or id in this repo is trusted.

| Kind | Required when enabled | Notes |
|---|---|---|
| `v3` | `address` | `feePips` optional; the pool's own `fee()` is authoritative |
| `v4` | `poolId` | `poolManager` optional, defaults to `KEEPER_POOL_MANAGER`; `tickSpacing` optional |

Both kinds require `pair` (`nvda-usd` or `nvda-eth`), `quoteToken` (USDG for `nvda-usd`, WETH for
`nvda-eth`) and `equityToken` (NVDA). They are required because the scanner needs the orientation:
a v3 `token0()` order is not known before the read, and v4 sorts its currencies by address. An
enabled entry without them is rejected at config load. Disabled entries need nothing but `name`,
`kind` and `pair`.

### Price and health checks

`scanReferencePools` reads every enabled pool at the current head and `buildMarketView` scores
each one:

- **oracle** — `poolPrice1e18()` from the active book hook is NVDA/USD; `KEEPER_ETH_USD_FEED` (or
  `KEEPER_ETH_USD`) supplies ETH/USD for the expected NVDA/ETH price;
- **pool vs oracle** — a pool more than `KEEPER_REFERENCE_MAX_PRICE_DEV_BPS` away from the oracle
  price is `price-deviation` and excluded;
- **24h and 6h windows** — fee APR after worst-case IL, volume and volatility, per window. Fee APR
  credits the modelled L-share of pool fees against `KEEPER_REFERENCE_ALLOC_USD`, so it is
  comparable with the book's own net APR, not the pool's aggregate APR;
- **staleness** — a last swap older than `KEEPER_REFERENCE_MAX_STALE_SECONDS`, or a scan that
  reported `fresh: false`, is `stale`;
- **depth** — below `KEEPER_REFERENCE_MIN_VOLUME_USD` and/or `KEEPER_REFERENCE_MIN_SWAPS` (24h) the
  pool is `thin`;
- **dispersion and cross-check** — intra-pair price dispersion must stay within
  `KEEPER_REFERENCE_MAX_DISPERSION_BPS`, and `nvdaUsd / nvdaEth` must agree with the ETH/USD oracle
  within `KEEPER_REFERENCE_MAX_CROSS_DEV_BPS`.

Pools that fail are **excluded** from the aggregates and the regime. The log shows `excluded=N`,
and every `reference pool:` line carries its own `status`. One bad pool does not sink the batch.
`KEEPER_REFERENCE_MIN_HEALTHY` sets how many healthy pools the view needs before it is usable, and
`oracle`/`crossCheck` fields show whether the oracle side of the comparison was available.

An excluded pool is never a destination. The keeper has no LP path for these pools at all.

### Market view and advisory course correction

The view aggregates the healthy pools per pair and per fee tier (`bestExternalNetApr`,
`medianExternalNetApr`, per-pair dispersion) and reduces them to one regime:

| Regime | Meaning |
|---|---|
| `uncertain` | Too few healthy pools, a dispersion breach, or a failed ETH cross-check |
| `volatile` | 6h volatility at/above `KEEPER_COURSE_ARM_VOL_HIGH_BPS`, or 2× the baseline |
| `thin` | 24h median volume below `KEEPER_COURSE_BASELINE_VOLUME_USD` |
| `calm` | 6h volatility at/below half the baseline, with baseline volume or more |
| `normal` | Everything else |

Only `uncertain` blocks advice. The other tags are descriptive, not a signal to move capital.

`recommendCourse` turns the view into **advisory** nudges, each clamped to the `KEEPER_COURSE_*`
bands:

- risk sizing (`maxVolatilityBps`, `minVolumeUsd`) scaled by 6h volatility and 24h volume medians;
- guard width (the book's current half width in bps) scaled the same way;
- guard share (guard share of book liquidity) nudged by `KEEPER_COURSE_BUFFER_BPS` in the
  direction of the median external net APR;
- an advisory fee-tier bias, only when the book's own fee tier lags its own tier median by the
  buffer and another tier's median is higher;
- a halved `arm.nvdaStepBps` when 6h volatility is high (never below 1 bps);
- `reArm.allowed=false` in `uncertain` and `volatile`.

`apply` is always `false` in the module contract. Even the recommendation's own `changed` flags are
only text today.

`KEEPER_COURSE_CORRECT_MODE` controls the path:

| Value | RPC cost | Behaviour |
|---|---|---|
| `off` (default) | none | No reference scan, no view, no recommendation |
| `advisory` | one scan per allocator run | Logs the view and the recommendation; nothing else changes |
| `apply` | same as `advisory` | **Not implemented on-chain.** Logs the recommendation plus a "logged only" note; no send |

So even in `apply` the reference view cannot change `decidePoolSwitch`, the risk thresholds, the
guard size, or any transaction. The 2h allocator logs:

```
reference market: regime=... healthy=N excluded=M nvdaUsd=... nvdaEth=... impliedEth=... dispersion=...bps
reference pool: <name> status=... net24h=...bps net6h=...bps vol6h=...bps share=...bps
course recommendation: riskVol=...bps volumeFloor=$... guardWidth=...bps guardShare=...bps bookBias=... armStep=... reArm=... apply=false warnings=...
```

Those lines and the in-memory `lastMarketView` / `lastCourse` are the seam for a future,
separately-gated apply step. Nothing reads them for a decision.

The block runs only when the allocator is active: a run that returns early on depeg / controller
`paused` / `switchFrozen` skips it, and it sits before the guard gate so the reference view can
never suppress or trigger a safe-harbor move. A reference failure is logged
(`reference market view failed: ...`) and swallowed, so the book/arm decisions still run. With no
enabled pool the keeper logs `no enabled pools; set KEEPER_REFERENCE_POOLS` once per process
instead of scanning. The scan costs `getLogs` over the 24h window per pool, chunked by
`KEEPER_REFERENCE_LOGS_CHUNK_BLOCKS`; the 2h cadence and `KEEPER_ALLOCATOR_ENABLED` still apply.

### Keys

| Key | Default | Meaning |
|---|---|---|
| `KEEPER_COURSE_CORRECT_MODE` | `off` | `off` / `advisory` / `apply` (apply is log-only) |
| `KEEPER_REFERENCE_POOLS` | `[]` (module placeholders) | One-line JSON pool array; overrides the module list |
| `KEEPER_REFERENCE_ALLOC_USD` | `1000` | Modelled L for fee share and net APR |
| `KEEPER_REFERENCE_WINDOW_SECONDS` | `86400` | Slow window (fee APR, IL, dispersion) |
| `KEEPER_REFERENCE_FAST_WINDOW_SECONDS` | `21600` | Fast window (volatility, guard scaling) |
| `KEEPER_REFERENCE_LOGS_CHUNK_BLOCKS` | `50000` | `getLogs` chunk size for the reference scan |
| `KEEPER_REFERENCE_MAX_PRICE_DEV_BPS` | `200` | Pool-vs-oracle exclusion band |
| `KEEPER_REFERENCE_MAX_DISPERSION_BPS` | `300` | Intra-pair dispersion limit |
| `KEEPER_REFERENCE_MAX_CROSS_DEV_BPS` | `300` | NVDA/USD ÷ NVDA/ETH vs ETH/USD limit |
| `KEEPER_REFERENCE_MAX_STALE_SECONDS` | `1800` | Max age of the last reference swap |
| `KEEPER_REFERENCE_MIN_HEALTHY` | `2` | Healthy pools needed for a usable view |
| `KEEPER_REFERENCE_MIN_VOLUME_USD` | `50000` | 24h depth floor per pool |
| `KEEPER_REFERENCE_MIN_SWAPS` | `50` | 24h swap-count floor per pool |
| `KEEPER_COURSE_BUFFER_BPS` | `500` | Gap before a fee-tier or guard-share nudge |
| `KEEPER_COURSE_FAST_BUFFER_BPS` | `1000` | Parsed and validated; not used by the current rules |
| `KEEPER_COURSE_GUARD_WIDTH_MIN_BPS` / `_MAX_BPS` | `200` / `3000` | Guard-width clamp |
| `KEEPER_COURSE_GUARD_SHARE_MIN_BPS` / `_MAX_BPS` | `1000` / `9000` | Guard-share clamp |
| `KEEPER_COURSE_RISK_VOL_MIN_BPS` / `_MAX_BPS` | `150` / `1200` | Risk-volatility clamp |
| `KEEPER_COURSE_RISK_VOLUME_MIN_USD` / `_MAX_USD` | `5000` / `100000` | Risk-volume clamp |
| `KEEPER_COURSE_BASELINE_VOL_BPS` | `300` | Neutral volatility for the regime and scaling |
| `KEEPER_COURSE_BASELINE_VOLUME_USD` | `15000` | Neutral 24h volume for the regime |
| `KEEPER_COURSE_ARM_VOL_HIGH_BPS` | `600` | 6h volatility that halves the NVDA step |

`npm run keeper:preflight` loads and validates the same config, so malformed
`KEEPER_REFERENCE_POOLS` JSON, an unknown field, or an enabled v3/v4 entry without its required
address/id or tokens fails preflight. The preflight does **not** scan the reference pools; check
the `reference scan:` / `reference pool:` lines from an `advisory` dry run for that.
`KEEPER_ALLOCATOR_ENABLED=true` is still required, because the reference block lives in the 2h
allocator tick.

## Fee vs IL and the guard math

All live inputs are on-chain Uniswap data: `Swap` logs, pool `getLiquidity` / `getSlot0`, the
hook's `basePosition` / `guardPosition`, and `GuardPulled` / `GuardDeployed` logs. The keeper does
not call an external analytics API.

For the active book over the 24h fee window:

```
baseShare  = base.liquidity / pool.activeLiquidity
guardShare = guard.liquidity (or guardParams.guardLiquidity) / pool.activeLiquidity
share      = baseShare + guardShare × guardUptime
bookFees   = poolFees × share
feeApr     = bookFees / bookValue × annualization
IL         = worst |IL| along the tick path, using the book's actual range
netApr     = feeApr − |IL_APR| × KEEPER_IL_MULTIPLE_BPS / 10_000
```

When there is no guard split (a single-book deployment), the keeper falls back to the in-range
book liquidity over pool liquidity. `KEEPER_IL_MULTIPLE_BPS=10000` is 1×; raise it to stress the
worst case. The endpoint IL is not enough: the tick path can leave the range and return, so the
keeper also checks the min/max ticks seen in the window.

Worked check:

- pool fees `$4,000` over 24h, `L_pool = 1,000,000`, `L_book = 100,000` → `share = 10%`;
- book fees `$400`; book value `$50,000` → `0.8%` over 24h → **292% APR**;
- a recalled guard contributes only in proportion to its uptime (`guardShare × guardUptime`), so
  time spent pulled does not earn guard-range fees. If the book has no deployed liquidity and no
  hypothetical capital, `bookValue` is zero and the book's fee APR is zero even when the pool's
  aggregate fee APR looks high.

Guard uptime is the fraction of the 24h window the guard was deployed. A pull before the window
counts from the window start; a pull still open at the end counts to the window end. Repeated
pulls while already down are not double-counted. A read failure keeps the cached history and
marks the book stale; it does not invent an uptime.

## Spiral NVDA arm (one Morpho arm, no bespoke sleeve)

The NetNet NVDA Morpho market — the market Spiral's NVDA strategy uses — takes NVDA directly
as collateral and borrows USDG. That is exactly the repo's `MorphoLoopAdapter`, so the strategy
is added as **one loop arm** on the existing `StrategyModule`. (Spiral's separate equity-vault
page is the USDG-in wrapper; it buys NVDA. We use the underlying market, not the wrapper.)

**The arm's input is NVDA, not USDG.** `allocateCollateral` pulls idle NVDA from the vault;
`borrow` borrows USDG *against* it and sends the USDG to the vault. No USDG deposit is
required.

```shell
# 1. deploy the adapter + submit it behind the module timelock (default 24h)
forge script script/DeploySpiralArm.s.sol --rpc-url $RPC --broadcast

# 2. after the timelock elapses, enable it
SPIRAL_ARM_EXECUTE=true forge script script/DeploySpiralArm.s.sol --rpc-url $RPC --broadcast

# 3. deploy idle NVDA into the arm (operator, through VaultStrategyAgent)
#    The vault must HOLD the NVDA; if it is sitting in the hook, recall it first
#    (keeper: vault.recallFromHook() or hook.withdrawInventory(0, nvdaAmount)).
SPIRAL_ARM_ADAPTER=0x... SPIRAL_ARM_NVDA_AMOUNT=1000000000000000000 \
  SPIRAL_ARM_BORROW_AMOUNT=60000000 \
  forge script script/AllocateSpiralArm.s.sol --rpc-url $RPC --broadcast
```

Safe defaults:

- `SPIRAL_NVDA_TARGET_LTV_OF_LLTV_BPS=4700` → 29.375% LTV on a 62.5% market (≈53% drop buffer).
  The keeper's `KEEPER_ARM_TARGET_LTV_BPS=2937` matches that ceiling and is clamped again by the
  adapter's live `targetLtvOfLltvBps` and LLTV.
- `SPIRAL_NVDA_MIN_HEALTH_FACTOR=1.5e18` → collateral withdrawals are blocked below 1.5.
- `SPIRAL_ARM_ABS_CAP` (USDG exposure) + `SPIRAL_ARM_REL_CAP_BPS=2000` (20% NAV).
- The always-on arm risk check de-leverages at `KEEPER_MIN_HEALTH_FACTOR` (default 1.5) or when
  the borrow APR exceeds `KEEPER_MAX_BORROW_APR_BPS` (default 30%), in `KEEPER_DELEVERAGE_BPS`
  slices (default 10% of debt per tick). The LTV sentinel adds the 30% hard-cap / 29.37% target
  repay rule. Neither check borrows or adds collateral.

The keeper's **arm risk check** reads `healthFactor()`, `debt()`, `borrowAprBps()`,
`collateralValue()` and `collateralBalance()` from the adapter and calls the **agent relay**
(`KEEPER_AGENT`) as the operator. The separate allocator is the only path that may
allocate/borrow, and it does so within the controller and module caps. The keeper never touches
the module directly, so the module's allocator/sentinel permissions stay intact.

## Execution details

- The vault holds **no standing allowance** to `StrategyModule`. Every token-moving call
  (`submitAllocate`, `submitAllocateCollateral`, and debt-repaying `submitDeleverage`) is preceded
  by an exact `submitApproveStrategy(token, amount)` when the allowance is short. After
  `submitBorrow`, the borrowed USDG is approved before the lend allocation. The executor
  simulates every write and waits for a successful receipt.
- Per-call `maxAllocatePerCall` / `maxCollateralPerCall` / `maxBorrowPerCall` /
  `maxFund*PerCall` bounds are read from `VaultStrategyAgent.controller().bounds()`, and the
  module adapter's absolute + relative caps are read from `StrategyModule.adapters()` /
  `adapterExposure()`. Each move is capped to the remaining headroom before it is signed.
- If the vault is `depegPaused`, or the controller is `paused` / `switchFrozen`, risk-up is
  on-chain-blocked: the keeper recalls the book (5m tick on depeg; the allocator branch is the
  paused/switchFrozen path and the 2h backstop). It does not allocate or borrow.
- After the arms unwind, `submitFund` funds the book with `KEEPER_FUND_BOOK_BPS` of the idle
  vault assets (default 90%, leaving a buffer).
- Unwind snaps to 100% below `KEEPER_UNWIND_DUST_USDG` / `KEEPER_UNWIND_DUST_NVDA`; a repay
  includes `KEEPER_REPAY_BUFFER_USDG`, which the module refunds.
- The return-to-book order is risk-reducing: repay debt, then withdraw collateral, then deallocate
  the remaining quote. Each step is one allocator run; the switch-unwind path uses
  `KEEPER_SWITCH_UNWIND_BPS` to do a full step instead of the normal `KEEPER_BOOK_STEP_BPS=2500`.

## Safe operation

- `KEEPER_DRY_RUN=true` is the default; run dry for at least one full day before enabling sends.
- `KEEPER_ALLOCATOR_EXECUTE=false` is the default. Enable it only after the dry-run scans and
  plans look right, and after `npm run keeper:preflight` passes.
- `KEEPER_ALLOCATOR_ENABLED=true` is a separate switch: it turns on the 2h allocator. Without it
  the keeper still runs the depeg heartbeat/recall, guard, sleeve and arm safety, but does no
  scanning, switching, sweeping or loop entry.
- The keeper key must be the operator of `VaultStrategyAgent` for strategy moves. It cannot bypass
  the controller/module caps or the adapter timelock.
- The arm is timelocked on the way in; disabling it (`submitDisableAdapter`), lowering caps, and
  de-leveraging are immediate sentinel actions.
- Start with a pilot `SPIRAL_ARM_ABS_CAP` you can write off, then raise it only after the
  de-leverage path has been exercised on testnet/fork.
- Set `KEEPER_ETH_USD_FEED` or `KEEPER_ETH_USD`. Without either, gas cost is treated as `$0`, so
  the payback gates do not protect you from uneconomic moves.
- A stale 24h cache or a failed guard-uptime read forces HOLD. Check the `[stale]` marker in the
  allocator scan log, and the guard-uptime "from cache" log, if switches stop happening.
