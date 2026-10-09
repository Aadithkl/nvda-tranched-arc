# Agent — static book operations

The onchain IL guard and the risk module do the heavy lifting; the agent runs a small, bounded
operational loop (no payments, no LLM):

| Piece | Purpose |
|---|---|
| `static.mjs` | Pure decision logic + CLI: `decideStatic()` (HOLD / RECHECK / RECENTER), `decideStrategy()` (HOLD / DEALLOCATE / DELEVERAGE / REALLOCATE / PARK / RESUME), `decideWinddown()` (HOLD / SOFT_HALT / HALT / PREPARE_SETTLEMENT / HAIRCUT_OR_WAIT / SETTLE), `edgeProximityBps()`, `parkPlan()` / `resumePlan()` / `sessionStandbyPlan()` |
| `test/static.test.mjs` | `node:test` coverage of the decision matrix |

Key setup: `npm run agent:keygen` appends an operator key to `.env` (`AGENT_OPERATOR_PRIVATE_KEY` /
`AGENT_OPERATOR_ADDRESS`). The operator is the **Allocator** (strategy module) and/or the vault
keeper via `VaultStrategyController`; the **Sentinel** de-risk key should be separate.

```shell
npm run agent:static -- --state '{"guardPresent":true,"tick":196840,"guardLo":195660,"guardHi":196860}'
npm run agent:static -- --strategy '{"sessionOpen":false,"deployEnabled":true}'
npm run test:agent
```

The permissionless `PoolGuardHook.recheckGuard()` can also be poked by any keeper; the agent's
session loop parks capital (`setHookDeployEnabled(false)` → `recallFromHook()` → `supplyIdle()`)
while the stock market is closed and resumes it on open.
