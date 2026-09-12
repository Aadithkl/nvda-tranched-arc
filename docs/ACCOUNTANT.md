# TrancheAccountant — rules layer

Sits between the ERC-7540 tranche vaults and the hook: turns deposits/redemptions into
senior/junior entitlements, pegs the vaults' hook-share balances, and enforces senior priority.

```
SeniorVault ─┐ deposits/redeems (hook-share amounts)      ┌─ seniorClaim()/juniorClaim() ─► hook risk budget
JuniorVault ─┤ ──────────────────────────► Accountant ────┤
             │   moveShares() (rebalance)                 └─ escrowFunded()             ─► JIT on/off
             └────────────────────────────── keeper: fulfillRedeem()
```

## Rules

| Concept | Formula |
|---|---|
| Senior claim | `min(seniorPrincipal + escrow, poolValue)` (escrow = `escrowBps` of principal, default 5%) |
| Junior claim | `poolValue − seniorClaim` (levered residual; absorbs losses first) |
| Escrow funded | `poolValue ≥ seniorPrincipal + escrow` → gates the hook's JIT risk budget |
| Rebalance | target senior shares = `totalShares × seniorClaim / poolValue`; moves the exact delta between vaults via `moveShares` |
| Senior haircut | when `poolValue < seniorPrincipal + escrow`, senior claim is reduced to the pool (deep-loss case) |

`poolValue` values the vaults' hook shares through `hook.convertToUsdc()` (Aave rest + claims + PnL).

## Wiring

- Vaults report flows: `onTrancheDeposit(isSenior, hookShares)` / `onTrancheRedeem(isSenior, hookShares)`
  (vault-gated) keep `seniorPrincipal` / `juniorPrincipal` as USDC cost basis.
- `rebalance()` is public — anyone can call; it is idempotent and keeps each vault's share balance pegged
  to its claim.
- Keeper (`fulfillRedeem(bool senior, address user)`) runs `rebalance()` then locks the redemption rate via
  the vault's admin-redeem path. **Junior fills revert while any senior request is pending** (`SeniorPriority`).
- The hook reads `escrowFunded()` + `juniorClaim()` for its `effectiveMaxDeploy` risk budget — JIT stops
  automatically when the senior claim is not covered.

## Access

| Role | Rights |
|---|---|
| owner | `setHook`, `setVaults`, `setKeeper`, `setEscrowBps` (≤ 20%) |
| keeper | `fulfillRedeem(senior, user)` |
| vaults | `onTrancheDeposit` / `onTrancheRedeem` (must match their tranche) |
| anyone | `rebalance()`, all views |

## Tests

`test/unit/TrancheAccountant.t.sol` — 12 tests: principal reporting, 5% coupon / junior residual,
escrow share rebalance, profit/loss waterfalls, senior haircut, escrow-funded gating, senior-priority
fulfillment, keeper-only guards, risk-budget reads.
