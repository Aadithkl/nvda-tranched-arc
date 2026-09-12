# Hook — `TrancheJITHook` + Agent Control Plane

The hook is the only bridge between the tranche stack and the two markets:
**rest state** = Aave V2 semi-fork (`deposit`/`withdraw` USDC via `IAaveV2Pool`), **execution** = v4
(dynamic fee + JIT in P5). Shares are the ERC-7575 `HookShareToken`.

## Modules (V1)

| File | Role |
|---|---|
| `src/hook/TrancheJITHook.sol` | `BaseHook` (OZ) + roles, pause, pool init/`setActivePool`, dynamic fee, quote gates, Aave rest state, share pipe (`wrapUSDC`/`unwrapUSDC`), risk budget |
| `src/hook/libraries/HookParams.sol` | `Params` struct + validation (fees, deviation band, TTL, bucket width) |
| `src/core/HookShareToken.sol` | ERC-7575 share (`vault(asset)`), mint/burn by hook only |
| `src/strategy/StrategyController.sol` | Bounds + whitelist; agent can only move params *inside* limits |
| `src/strategy/StrategyAgent.sol` | Separate agent contract; operator key (never the deployer) submits params/base fee/quoting |
| `src/interfaces/INVDAPriceOracle.sol` | Oracle read (`mid`, `valid`) for gate pricing |

## Quote flow (`beforeSwap`)

1. `_checkActivePool` (only the active poolId, hooks == this)
2. gate: `quoteState() != REST`, cooldown elapsed, `_checkActivePool`
3. price: `poolUsdPerEquity` (v4 slot0 via `StateLibrary`) vs `oracleUsdPerEquity` (`mid × 1e10`)
4. `deviationBps = |pool − oracle| / oracle`; `> maxDeviationBps` → `DeviationTooHigh`
5. `toxic` = trade pushes pool price **toward** oracle; non-toxic → `baseFee`; toxic →
   `min(baseFee + deviationBps × toxicityMultiplierBps, maxSurgeFee)`
6. `fee < minEvBps × 100` → `NotEvPositive`; else sets `lastQuotedAt` and returns
   `fee | OVERRIDE_FEE_FLAG`

## State machine (M5)

| State | Condition | Behavior |
|---|---|---|
| ACTIVE | `now ≤ paramsUpdatedAt + ttl` | full quoting |
| DEGRADED | within `+ gracePeriod` after TTL | `effectiveMaxDeploy = min(cap/4, riskBudget)` |
| REST | paused, quoting off, or past grace | no quotes; capital stays in Aave |

`effectiveMaxDeploy = min(agent maxDeployPerSwap, riskBudget)`, `riskBudget = juniorClaim` only when
`accountant.escrowFunded()`, else 0 (no accountant → 0).

## JIT engine (P5)

- **Rest state**: inventory sits in Aave (`aUSDC` + optional `aTokenEquity`); the pool carries zero standing liquidity.
- **Per swap**: `beforeSwap` sizes and seeds a **one-sided transient position** at the tick range the swap
  trades into:
  - `zeroForOne` (price down) → range `[tick - bucketTicks, tick]`, seeded with **token1**
  - `oneForZero` (price up) → range `[tick + spacing, tick + spacing + bucketTicks]`, seeded with **token0**
  - size = expected swap output × 1.01, **valued in USDC via the price oracle** and capped by
    `effectiveMaxDeploy()`; oversized swaps revert `JitCapacityExceeded`
  - inventory is withdrawn from Aave and settled to the PoolManager (`sync` + `settle`)
- **After swap**: the exact liquidity is removed; positive deltas are converted to **ERC-6909 claims**
  (`PoolManager.mint`) because the swapper's input is settled after `afterSwap`; negative deltas are paid
  from Aave. `JitRangeExceeded` reverts the whole swap if price left the range (safety valve).
- **Claim redemption**: `_redeemClaims` (partial-safe `burn` + `take` → Aave) runs at the start of every JIT;
  `unwindClaims()` opens a PoolManager unlock (`unlockCallback`) so keepers can redeem the full claim
  balance outside a swap. Fees accrue to the hook as claims and are redeemable to Aave.
- **Enable/bootstrap**: `setJitEnabled(bool)` + `seedInventory(asset, amount)` (owner) to fund the Aave
  rest state before the first swap. `setLiquidityGuard(true)` blocks external LPs once live.
- **Invariant**: pool liquidity returns to zero after every swap; value grows by the quoted fee minus
  half-tick price impact.

## Roles

- `owner` (deployer/multisig): pool mgmt, roles, oracle/lending/accountant wiring
- `guardian`: pause only
- `controller` (`StrategyController`): params/base fee/quoting
- `StrategyAgent` (whitelisted on controller): call surface for the offchain operator key
- Agent **cannot** mint/burn shares, move funds, change roles, or exit bounds

## Tests

- `test/unit/TrancheJITHook.t.sol` — 28 tests: permissions, pool init gating, oracle/toxic pricing,
  surge cap, hard band, TTL states, risk budget, controller bounds, agent whitelist, cooldown,
  dynamic fee update on the pool, Aave rest + yield share pricing, wrap/unwrap, liquidity guard.
- `test/unit/TrancheJIT.t.sol` — 12 tests: zero standing liquidity, both directions, Aave round trip,
  fee accrual, capacity/budget guards (budget valued in USDC), claim unwind outside a swap,
  sequential swaps with no residue, range bounds, JIT-disabled fallback.

## Next

- M3/M4: escrow-targeting fee floor, EV-tracking buckets; M6: onchain vol estimator
- Offchain agent (`agent/`, GitHub Actions loop) writes params through `StrategyAgent`
- Live exercise: deploy + swap with JIT enabled on Arc (after the current demo deployment)
