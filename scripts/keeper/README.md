# Self-run keeper (Yearn-style)

A long-running process, not GitHub Actions and not a managed keeper network.

```
poll triggers -> pure decision (decide.mjs) -> execute -> alert
```

Modelled on Yearn's keeper split: trigger checks are pure functions, the runner executes them,
and every action is bounded on-chain.

## What it does

| Check | Contract call | Safety |
|---|---|---|
| Depeg heartbeat | `DepegHeartbeat.performUpkeep()` | Vault latches only on a TWAP-vs-stock divergence sustained for `minDuration` |
| Guard re-arm | `PoolGuardHook.recheckGuard()` | Permissionless; re-arms only inside the recheck band |
| Morpho loop arm (Spiral NVDA) | `VaultStrategyAgent.submitDeleverage(adapter, repay, 0)` | De-leverage only; caps and LTV enforced by the adapter/module |
| Sleeve risk (optional) | `Sleeve.deRisk()` / `pause()` | De-risk only; never opens or adds leverage |
| Risk allocator (optional) | fee/volume/volatility -> `submitRecall`, `submitAllocate`, `submitAllocateCollateral`, `submitBorrow`, `submitDeallocate`, `submitDeleverage` | One step per tick; stock LTV hard-capped below 30% |

## What it does not do

- No arbitrary calldata: the allocator only calls the typed `VaultStrategyAgent` functions.
  The sleeve only calls `deRisk()` / `pause()`; the hub only calls `performUpkeep()`; the hook
  only calls `recheckGuard()`.
- No APR comparison: the allocator does not compare book fees to arm rates. The arms are the
  safe harbor; the book earns fees. Risk comes from fee, volume, price fluctuation, guard and
  depeg state.

## Run

```shell
cp .env.example .env
# fill KEEPER_RPC_URL, KEEPER_VAULT, KEEPER_HEARTBEAT, KEEPER_HOOK
# KEEPER_DRY_RUN=true is the default: logs intended actions, sends nothing
npm run keeper:dry

# to send transactions
KEEPER_DRY_RUN=false KEEPER_PRIVATE_KEY=0x... npm run keeper:run
```

The key must be authorised for whatever it executes:

- `DepegHeartbeat.performUpkeep` is permissionless (gas only).
- `PoolGuardHook.recheckGuard` is permissionless (gas only).
- `SpiralNvdaSleeve.deRisk/pause` require the key to be the sleeve's `keeper`.

## Run it as a service

systemd:

```ini
[Unit]
Description=NVDA sleeve keeper
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

## Tests

```shell
npm run test:keeper
```

63 tests cover the decision matrix: heartbeat due/fresh/paused, every sleeve trigger
(stock LTV, yield LTV, health, carry, venue pause), guard re-arm, the risk allocator
(volatility/volume/guard/depeg), the <30% LTV cap, the USDG-first/NVDA-step plan,
the fee-vs-IL pool switch, the actual-tick IL model, position-level fee share (guard pull
drives book fees to zero), the risk-first book return (repay, withdraw, then quote), and the
book-stat math (volume, fees, fee APR, price fluctuation, active liquidity).

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
- `SPIRAL_NVDA_MIN_HEALTH_FACTOR=1.5e18` → collateral withdrawals are blocked below 1.5.
- `SPIRAL_ARM_ABS_CAP` (USDG exposure) + `SPIRAL_ARM_REL_CAP_BPS=2000` (20% NAV).
- The keeper de-leverages at `KEEPER_MIN_HEALTH_FACTOR` (default 1.5) or when the borrow APR
  exceeds `KEEPER_MAX_BORROW_APR_BPS` (default 30%), in `KEEPER_DELEVERAGE_BPS` slices
  (default 10% of debt per tick). It never borrows or adds collateral.

The keeper's **arm risk check** reads `healthFactor()`, `debt()`, and `borrowAprBps()` from the
adapter and calls the **agent relay** (`KEEPER_AGENT`) as the operator. That check is
de-leverage-only. The separate allocator is the only path that may allocate/borrow, and it does
so within the controller and module caps. The keeper never touches the module directly, so the
module's allocator/sentinel permissions stay intact.

## Risk allocator

The book is the yield venue; the Morpho arms are the safe harbor. There is no target APR
and no min-carry rule. Each allocator tick scans **book A and book B** over
`KEEPER_STATS_LOOKBACK_BLOCKS × KEEPER_BLOCK_TIME_SECONDS` (default 21,600 × 0.1s ≈ 36m;
set 216,000 blocks for ~6h) from Uniswap `Swap` logs only. The annualization uses that actual
block span, so the APR is not distorted by a block-time mismatch. For each book:

- fee APR: pool fees × `L_book/L_pool`, divided by the book's LP value, annualized
  (Uniswap fee config is in pips per 1e6: 500 = 0.05%, 3000 = 0.30%, not bps)
- USDG volume: sum of `amount0` notional
- price fluctuation: `(max - min) / average` over the window
- IL: the book's **actual base-position tick range** and the tick path from the swaps
- **net APR = fee APR − |IL APR|**

`assessBookRisk` marks risk HIGH if the guard is absent, the vault is depeg-paused, the guard
was pulled inside `KEEPER_GUARD_COOLDOWN_SECONDS` when that optional cooldown is non-zero, more
than `KEEPER_MAX_GUARD_PULLS` `GuardPulled` events fired **since the previous allocator run**
(the count resets every hourly run; default 2), price fluctuation is at/above
`KEEPER_RISK_MAX_VOLATILITY_BPS`, volume is below `KEEPER_RISK_MIN_VOLUME_USD`, or the optional
`KEEPER_RISK_MIN_FEE_APR_BPS` floor is set and breached. HIGH moves to the arms.

If risk is normal, `decidePoolSwitch` ranks A/B by **net APR after IL** and switches only when
the best book clears `KEEPER_SWITCH_BUFFER_BPS` and beats the current book by the same buffer.
The switch executes `VaultStrategyAgent.submitSwitchBook(0|1)`.

Moves are one step per tick:

1. Recall the book to the vault if the assets are not idle.
2. Put **most** of the idle quote into the Morpho USDG lend arm first
   (`KEEPER_MORPHO_ARM_SHARE_BPS`, default 80% target).
3. Add NVDA to the collateral/borrow arm in small slices
   (`KEEPER_NVDA_STEP_BPS`, default 10% of total NVDA per tick).
4. Borrow USDG against the new NVDA at the <30% LTV cap and lend it in the USDG arm.
5. On the way back, repay debt first, then withdraw NVDA collateral, then pull the remaining
   USDG in `KEEPER_BOOK_STEP_BPS` slices (risk-reducing order).

`KEEPER_ALLOCATOR_EXECUTE=false` is the default: the keeper logs the risk, stats and planned
steps, and sends nothing. Set it to `true` only after the dry-run recommendations look right.

Execution details:

- The vault holds **no standing allowance** to `StrategyModule`. Every `submitAllocate`,
  `submitAllocateCollateral`, and debt-repaying `submitDeleverage` is preceded by an exact
  `submitApproveStrategy(token, amount)`. `send` waits for the receipt and checks success.
- Per-call `maxAllocatePerCall` / `maxCollateralPerCall` / `maxBorrowPerCall` /
  `maxFund*PerCall` bounds are read from `VaultStrategyAgent.controller().bounds()`, and the
  module adapter's absolute + relative caps are read from `StrategyModule.adapters()` /
  `adapterExposure()`. Each move is capped to the remaining headroom before it is signed.
- If the vault is `depegPaused`, or the controller is `paused` / `switchFrozen`, risk-up is
  on-chain-blocked: the allocator only recalls the book. It does not allocate or borrow.
- After the arms unwind, `submitFund` funds the book with `KEEPER_FUND_BOOK_BPS` of the idle
  vault assets (default 90%, leaving a buffer).
- Unwind snaps to 100% below `KEEPER_UNWIND_DUST_USDG` / `KEEPER_UNWIND_DUST_NVDA`; a repay
  includes `KEEPER_REPAY_BUFFER_USDG`, which the module refunds.

### Fee vs IL and the guard math

All live inputs are on-chain Uniswap data: `Swap` logs, pool `getLiquidity`/`getSlot0`, the
hook's `basePosition`/`guardPosition`, and `GuardPulled` logs. The keeper does not call an
external analytics API.

For the active book:

```
L_book   = base.liquidity if base in range + guard.liquidity if guard in range
share    = L_book / pool.activeLiquidity
bookFees = poolFees × share
feeApr   = bookFees / bookPositionValue × annualization
IL       = value of base range at end price vs HODL, using the actual ticks
netApr   = feeApr − |IL APR|
```

Worked check:

- pool fees $1,000 over 6h, `L_pool = 1,000,000`, `L_book = 100,000` → `share = 10%`
- book fees `$100`; book value `$50,000` → `0.2%` over 6h → **292% APR**
- guard pulled or base out of range → `L_book = 0` → `share = 0` → book fees `$0` → **0% APR**
- the pool's aggregate fee APR can still look high because other LPs are earning; the book's
  position-level share is zero, so the book does not stay in on the pool's APR

Multiple guard pulls are caught two ways: while the guard is down the book's `L_book`/share
falls, and more than `KEEPER_MAX_GUARD_PULLS` `GuardPulled` events **since the previous hourly
allocator run** force the safe harbor even after the share is restored. The count is not
cumulative: it is recomputed from the last allocator block each run and resets every hour.
`pulledAt` inside `KEEPER_GUARD_COOLDOWN_SECONDS` is an optional extra recent-pull check
(default 0 = disabled, so two pulls per run are allowed). Re-arm swap costs are not pool fees;
they are not double-counted in this fee number.

The switch rule:

- rank A/B by `netAprBps` (annualized fees after IL), not fee APR;
- skip any book whose on-chain risk is HIGH;
- switch only if the best book clears `KEEPER_SWITCH_BUFFER_BPS` and beats the current book by
  the same buffer;
- otherwise the arms are the safe harbor.

## Safe operation

- `KEEPER_DRY_RUN=true` is the default; run dry for at least one full day before enabling sends.
- The keeper key must be the operator of `VaultStrategyAgent`; it cannot open positions.
- The arm is timelocked on the way in; disabling it (`submitDisableAdapter`), lowering caps, and
  de-leveraging are immediate sentinel actions.
- Start with a pilot `SPIRAL_ARM_ABS_CAP` you can write off, then raise it only after the
  de-leverage path has been exercised on testnet/fork.
