# Security Review — External Report Triage

Independent audit findings triaged against the code. Status: all actionable items fixed in the
`fix(security)` commit; two findings were confirmed false positives with regression tests added.

| ID | Finding (reported severity) | Verdict | Resolution |
|---|---|---|---|
| C-1 | Share inflation via `wrapUSDC` (Critical) | **Valid** | Hook share math now uses virtual shares/assets (`VIRTUAL_SHARES = 1e3`, `VIRTUAL_ASSETS = 1`, 18-decimal scaled) in `convertToShares`/`convertToUsdc`/`wrapUSDC`; mint requires `shares > 0`. Regression: `test_donation_doesNotDiluteExistingHolders`. |
| C-2 | JIT revert = total swap DoS (Critical) | **Partially valid — behavior deliberate** | Kept the revert (renamed `JitUnavailable`). Skipping JIT would let v4 run the price to `sqrtPriceLimitX96` with zero liquidity consumed (`Pool.sol:344`), corrupting pool state — worse than reverting. In a JIT-only pool a skipped swap fails anyway; documented in `docs/HOOK.md`. |
| H-1 | Single oracle / no hook-level staleness (High) | **Mostly invalid; hardening added** | Oracle `valid` already enforces market session + `maxStaleness`; added a hook-side `maxPriceAge` (default 300s, owner-set) checked against `updatedAt`. Single-oracle/writer trust documented as an ops concern (multisig + second writer recommended). Regression: `test_oracle_staleHookWindow_reverts`. |
| H-2 | Unsafe `int192 → uint192` cast (High) | **False positive** | `data.mid <= 0` is checked before every cast (`TrancheJITHook.sol` `_prices` / `_equityValueInUsdc`). Regression: `test_oracle_negativeMid_reverts`. |
| H-3 | One-step ownership (High) | **Valid** | Two-step ownership (`pendingOwner` + `acceptOwnership`) added to `TrancheJITHook`, `TrancheVault`, `StrategyController`, `StrategyAgent`; `Ownable2Step` for `TrancheAccountant`, `LendingPoolAddressesProvider`, `PeggedPriceOracle`. |
| M-1 | `totalManagedAssets` donation-manipulable (Medium) | **Valid (same root as C-1)** | Closed by the virtual-offset fix; a donation now only gifts existing holders and cannot dilute later depositors beyond dust. |
| M-2 | No reentrancy guards (Medium) | **Valid, low risk** | `ReentrancyGuard` + `nonReentrant` on `wrapUSDC`, `unwrapUSDC`, `seedInventory`, `unwindClaims`. Hook callbacks stay unguarded; `jitState.active` blocks JIT reentry. |
| M-3 | `unwindClaims()` permissionless (Medium) | **Accepted by design (info)** | Only moves hook-owned claims → Aave; no recipient parameter, no theft. Left permissionless and documented as keeper-convenience. |
| M-4 | No slippage protection on `unwrapUSDC` (Medium) | **Valid** | Added `unwrapUSDC(shares, receiver, minUsdcOut)` overload + `SlippageExceeded`; vault exposes `claimAndUnwrapUSDC(..., minUsdcOut)`. Regression: `test_slippageProtection_onUnwrap`. |
| M-5 | Overflow in `_poolPrice1e18` (Medium) | **Valid** | Replaced raw `sqrtPrice²` with `Math.mulDiv(sqrt, sqrt, Q96)` (512-bit), removed the `ratioX192 * scaledUsdc` product, and added `TickMath` bounds check (`PoolPriceOutOfBounds`). Same treatment in `_expectedOutput`. Regression: `test_extremePoolPrice_noPanic`. |

## Invariants covered by tests

- Share price cannot be inflated by direct donation or first-depositor griefing.
- Pool price math never panics at tick boundaries; out-of-range prices revert with a named error.
- Unwraps enforce user-supplied minimums.
- Ownership transfers require the new owner to accept.
- JIT is unavailable (reverts with a clear reason) rather than degrading into an unquoted pool.

## Known accepted risks

- Single price oracle + single writer allowlist entry (ops: multisig ownership, multiple writers).
- JIT-only pools reject swaps larger than the risk budget (`JitCapacityExceeded`) and swaps that would
  exit the quoted range (`JitRangeExceeded`) — by design; multi-bucket JIT is the follow-up.
- Lending semi-fork has no liquidations (documented in `docs/LENDING.md`; testnet scope).
