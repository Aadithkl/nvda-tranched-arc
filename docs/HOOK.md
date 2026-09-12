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

## Roles

- `owner` (deployer/multisig): pool mgmt, roles, oracle/lending/accountant wiring
- `guardian`: pause only
- `controller` (`StrategyController`): params/base fee/quoting
- `StrategyAgent` (whitelisted on controller): call surface for the offchain operator key
- Agent **cannot** mint/burn shares, move funds, change roles, or exit bounds

## Tests

`test/unit/TrancheJITHook.t.sol` — 28 tests: permissions, pool init gating, oracle/toxic pricing,
surge cap, hard band, TTL states, risk budget, controller bounds, agent whitelist, cooldown,
dynamic fee update on the pool, Aave rest + yield share pricing, wrap/unwrap, liquidity guard.

## Next

- P5: JIT engine (`beforeSwap` deploy → `afterSwap` remove/re-supply), ERC-6909 claims, bucket math
- M3/M4: escrow-targeting fee floor, EV-tracking buckets; M6: onchain vol estimator
- Offchain agent (`agent/`, GitHub Actions loop) writes params through `StrategyAgent`
