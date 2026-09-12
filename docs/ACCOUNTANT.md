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
| Effective pool | `poolValue − value(claimableSenior + claimableJunior)` — assets locked for fulfilled redemptions are no longer tranche P&L |
| Senior claim | `min(seniorPrincipal + escrow, effectivePool)` (escrow = `escrowBps` of principal, default 5%) |
| Junior claim | `effectivePool − seniorClaim` (levered residual; absorbs losses first) |
| Escrow funded | `effectivePool ≥ seniorPrincipal + escrow` → gates the hook's JIT risk budget |
| Rebalance | target senior shares = `totalShares × (seniorClaim + value(claimableSenior)) / poolValue`; moves the exact delta between vaults via `moveShares`, never below a vault's locked balance |
| Senior haircut | when `effectivePool < seniorPrincipal + escrow`, senior claim is reduced to the pool (deep-loss case) |

`poolValue` values the vaults' hook shares through `hook.convertToUsdc()` (Aave rest + claims + PnL).

## Wiring

- Vaults report flows: `onTrancheDeposit(isSenior, hookShares)` / `onTrancheRedeem(isSenior, hookShares)`
  (vault-gated) keep `seniorPrincipal` / `juniorPrincipal` as USDC cost basis and **lock** the redeemed
  hook shares in `claimableSenior` / `claimableJunior`.
- When a user actually claims, the vault's `_withdraw` reports `onTrancheClaim(isSenior, hookShares)` so
  the locked liability is released only as the assets leave the vault.
- `rebalance()` is public — anyone can call; it is idempotent and keeps each vault's share balance pegged
  to its entitlement without ever stripping the assets backing unclaimed redemptions.
- Keeper (`fulfillRedeem(bool senior, address user)`) runs `rebalance()` then locks the redemption rate via
  the vault's admin-redeem path, clamped to the vault's available (balance − already locked) so integer
  dust can never leave a fulfilled claim unbacked. **Junior fills revert while any senior request is
  pending** (`SeniorPriority`).
- The hook reads `escrowFunded()` + `juniorClaim()` for its `effectiveMaxDeploy` risk budget — JIT stops
  automatically when the senior claim is not covered.

## Access

| Role | Rights |
|---|---|
| owner | `setHook`, `setVaults`, `setKeeper`, `setEscrowBps` (≤ 20%) |
| keeper | `fulfillRedeem(senior, user)` |
| vaults | `onTrancheDeposit` / `onTrancheRedeem` / `onTrancheClaim` (must match their tranche) |
| anyone | `rebalance()`, all views |
