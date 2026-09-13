# Hook — `TrancheJITHook` + Agent Control Plane

The hook is the only bridge between the tranche stack and the two markets:
**rest state** = Aave V2 semi-fork (`deposit`/`withdraw` USDC via `IAaveV2Pool`), **execution** = v4
(dynamic fee + JIT in P5). Shares are the ERC-7575 `HookShareToken`.

## Modules (V1)

| File | Role |
|---|---|
| `src/hook/TrancheJITHook.sol` | `BaseHook` (OZ) + roles (two-step ownership), pause, pool init/`setActivePool`, dynamic fee, quote gates, Aave rest state, share pipe (`wrapUSDC`/`unwrapUSDC`), risk budget, JIT engine, module primitives (`modulePull`/`moduleBurn`/`moduleSupplyIdle`) |
| `src/periphery/TranchePipeModule.sol` | Dual-token pipe + rebalancing periphery: `wrapUSDC`, `unwrapUSDC`, `unwrapEquity`, `unwrapProportional`; `assetComposition`; hard-cap enforcement; external venue swaps (`rebalanceSwap`) |
| `src/hook/libraries/HookParams.sol` | `Params` struct + validation (fees, deviation band, TTL, bucket width) |
| `src/core/HookShareToken.sol` | ERC-7575 share (`vault(asset)`), mint/burn by hook only |
| `src/strategy/StrategyController.sol` | Bounds + whitelist; agent can only move params *inside* limits |
| `src/strategy/StrategyAgent.sol` | Separate agent contract; operator key (never the deployer) submits params/base fee/quoting |
| `src/interfaces/INVDAPriceOracle.sol` | Oracle read (`mid`, `valid`) for gate pricing |

**Safety notes:** hook share math uses virtual shares/assets (inflation defense); `maxPriceAge` (default
300s) is enforced on top of the oracle's own staleness; oracle decimals are read from the oracle and
scaled (no hard-coded 8); `wrapUSDC`/`unwrapUSDC`/`seedInventory`/`unwindClaims` are `nonReentrant`;
`unwindClaims()` is intentionally permissionless (moves hook-owned claims to Aave only).

## Quote flow (`beforeSwap`)

1. `_checkActivePool` (only the active poolId, hooks == this)
2. gate: `quoteState() != REST`, cooldown elapsed, `_checkActivePool`
3. price: `poolUsdPerEquity` (v4 slot0 via `StateLibrary`) vs `oracleUsdPerEquity` (`mid` scaled to 1e18
   by the oracle's own `decimals`)
4. `deviationBps = |pool − oracle| / oracle`; `> maxDeviationBps` → `DeviationTooHigh`
5. `toxic` = trade pushes pool price **toward** oracle; non-toxic → `baseFee`; toxic →
   `min(baseFee + deviationBps × toxicityMultiplierBps, 1_000_000)` (100% protocol cap — no
   per-pool fee ceiling, extreme markets may price fees up to seven figures)
6. `fee < minEvBps × 100` → `NotEvPositive`; else sets `lastQuotedAt` and returns
   `fee | OVERRIDE_FEE_FLAG`

If JIT is enabled but the risk budget is 0 (unfunded escrow), `beforeSwap` reverts `JitUnavailable` —
deliberately stopping swaps rather than letting the AMM run the price to the swap's price limit with zero
liquidity.

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
  - sizing is **bucket-exact**, derived from the swap itself (`_sizeJit`): exact-in liquidity is solved
    from v4's amount-delta equations so the whole fee-adjusted input stays inside the bucket, exact-out
    from the requested output, +1% buffer for rounding. (An inline `SwapMath.computeSwapStep` validation
    step was removed because it pushed the hook over EIP-170; the closed form is exact for the single
    one-sided bucket and the buffer covers rounding.)
  - the seed is **valued in USDC via the price oracle** and capped by `effectiveMaxDeploy()`; oversized
    swaps revert `JitCapacityExceeded`
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

## Dual-token exits + rebalancing (v3)

The 7575 share is basket-backed (USDC + equity, e.g. NVDA). Exits are selectable:

| Path | Function | Pricing | Notes |
|---|---|---|---|
| USDC (default, senior-allowed) | `unwrapUSDC(shares, receiver, minUsdcOut)` | share NAV | withdraws from Aave rest |
| Equity in-kind | `unwrapEquity(shares, receiver, minEquityOut)` | oracle mid, `maxPriceAge` enforced | conversion fee (`conversionFeeBps`, ≤100) stays in the pool |
| Proportional | `unwrapProportional(shares, receiver, minUsdcOut, minEquityOut)` | **oracle-free** unit fractions | pays a slice of both idle + Aave balances |

`TrancheVault` exposes `claimAndUnwrapEquity` / `claimAndUnwrapProportional`; senior vaults revert
`SeniorUsdcOnly` on both. The module's `assetComposition()` reports `(usdcValue, equityValue, equityBps)`
at the oracle, and `equityToUsdc` prices equity unit amounts for the controller cap check.

Rebalancing is agent-driven and venue-agnostic. `TranchePipeModule` is deployed as the vault `pipe` and
set as the controller `rebalanceTarget` (`PIPE_ADDRESS` in the stack deploy); its owner configures a
plain external pool via `setRebalanceVenue(key, router)` and the controller calls
`rebalanceSwap(equityOut, amountIn, minOut, deadline)`:

- hard cap only (`hardMaxEquityBps`, default 7500, max 9500) — no target ratio;
- `minOut` must beat the oracle-implied output minus `maxRebalanceSlippageBps` (`SlippageBoundUnmet`);
- buying equity reverts `RebalanceNotFunded` while the senior escrow is unfunded, and reverts
  `EquityCapExceeded` if the post-swap book breaches the cap;
- controller-side per-call cap (`maxRebalanceSwapUsdc`, equity sells valued at the oracle) and cooldown.

The offchain LLM manager proposes `buy`/`sell`/`hold` plus size every few hours; deterministic code
(`agent/model.mjs` `validateRebalanceProposal`) validates the hard rails and submits through
`StrategyAgent.submitRebalance`; the chain only enforces bounds. Portfolio IL, inventory drift and JIT
edge are computed as manager context, not as a deterministic trading policy.

## Expiry (v3.2)

`setExpiry(uint64)` (owner, one-shot, future-only) sets the book's maturity timestamp. Once
`block.timestamp >= expiry`, `expired()` is true and `quoteState()` returns `Rest`, so
`_beforeSwap` reverts (`QuotingOff`) and `effectiveMaxDeploy()` is 0 — JIT and trading stop and
only settlement remains. Rebalancing through `TranchePipeModule.rebalanceSwap` likewise reverts
(`TradingClosed`). Vaults carry the same timestamp (the stack deploy asserts equality) and close
deposits at expiry.

## Next

- M6: full E2E on Arc against the v3 USDC/NVDA book (deploy → seed → JIT swap → redeem → expiry settlement)
- v3 redeploy once `NVDA_ADDRESS` / venue env lands (`docs/DEPLOYMENTS.md` checklist)
- Onchain volatility estimator for bucket widths; escrow-targeting fee floor
