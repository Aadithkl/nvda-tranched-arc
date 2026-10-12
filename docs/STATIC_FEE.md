# Static-Fee Book — Auto-Routable Design (`PoolGuardHook` + `RegimeVault`)

Status: design freeze for implementation · Target: production deploy on a Labs-routed chain (Robinhood Chain / Base / Unichain) · Version model: this is the **static-fee** version, built on branch `static-fee` (build plan: `docs/STATIC_FEE_PLAN.md`); the **dynamic-fee** v3 (`TrancheJITHook`) stays live on `main`. §9 below applies on the static branch only.

**Audience:** implementing agent. Every "MUST / MUST NOT" below is load-bearing; violating one re-introduces the BD/whitelist dependency or router-trust risk this design exists to remove.

---

## TL;DR

- One **static-fee** v4 pool (optionally a second "surge" pool later). No dynamic fees, no return deltas, no `0x91` address → Labs routing considers the pool **automatically** (no allowlist form).
- **Zero-TVL pools are invisible to routing discovery** and cannot be added to the curated lists without Labs. Therefore the pool holds a **small base position at all times** (discovery + price anchor) — this is the accepted cost.
- All liquidity management moves **up a layer**: a vault owns base + window positions; an agent deploys/pulls/re-centers. The hook only guards (oracle-valid/market-open) and enforces private LP.
- "Swap only when fees > IL" is implemented as **liquidity presence** (window in/out), never as quote manipulation. A quote is a simulated swap; you cannot quote an oracle price and you must not falsify quotes.
- Never: fee overrides, `updateDynamicLPFee`, delta returns, caller-dependent behavior, bad-quote traps, leverage in pool inventory, proxy upgrades, custom `hookData` requirements.

## 1. Design rationale (facts this design is built on)

### 1.1 Uniswap Labs routing allowlist — triggers (as of 2026-09)

A hook is automatically eligible **unless** one of:

| Trigger | This design |
|---|---|
| Hook address starts with `0x91` | MUST mine a non-`0x91` address |
| Uses dynamic fees (pool `DYNAMIC_FEE_FLAG`, fee override return, or `updateDynamicLPFee`) | MUST use static `PoolKey.fee` only |
| Uses `beforeSwapReturnsDelta` / `afterSwapReturnsDelta` | MUST keep all four delta-flag bits `false` |
| (Newer criterion) intended for pools with major token pairs | Residual risk for NVDA/USDC — open question §11, not a blocker |

Approval criteria if review ever triggers: verified source on explorer, no upgradeable proxy, no protocol-fee bypass, no custom calldata the router can't produce, non-extractive, discretionary and revocable.

### 1.2 Zero-TVL routing

Routing admission for zero-measured-TVL hooks is per hook **address**, via curated lists (`ZLCA_HOOKS_PER_CHAIN`, `ZERO_MEASURED_TVL_HOOKS_PER_CHAIN` in `Uniswap/uniroute-public`) — even Uniswap Labs' own DualPool needed registry membership. Unobtainable without Labs. ⇒ **the pool must carry standing base TVL** to be discovered and routed normally.

### 1.3 Quote mechanics (why the guard is liquidity, not quotes)

- A "quote" is a **simulated swap** (V4Quoter or `eth_call`); hooks execute inside it. There is no separate quote path.
- The pool price is `slot0.sqrtPriceX96`; only swaps move it. **You cannot quote the oracle.** The oracle may only shape hook behavior.
- Therefore: quote = f(slot0, in-range liquidity, static fee, hook behavior). The only dial this design owns is **how much liquidity is present**.
- Quote ≠ execution only if state changes between them or behavior depends on `sender`. Both are forbidden; regime changes are latched to agent actions.

## 2. Architecture

```
User / Router / Aggregator
        │
        ▼
Uniswap v4 Pool (static fee, hooks = PoolGuardHook)
   beforeSwap:            allow by default; revert only if oracle stale/invalid or market closed
   beforeAdd/RemoveLiq:   allow only the book (private LP)
        │
        ▼
RegimeVault  ── owns ALL positions (base + window); issues tranche shares (Senior / Junior)
   │                NAV + waterfall accounting (TrancheAccountant)
   ▼
StrategyAgent / StrategyController
   hourly: fee-vs-IL sweep → deployWindow / pullWindow / recenter   (bounded, whitelisted actions)
        │
        ▼
Rest venues: Aave supply / ERC-4626 (cap-aware withdrawable)   —  NO leveraged/looping inventory
Treasury sleeve (separate): Morpho looping (if any), junior risk capital only, real oracle, capped
```

Components:

| Component | Owns | Notes |
|---|---|---|
| `PoolGuardHook` | Nothing but guard state | Minimal; guard + private-LP + events only |
| `RegimeVault` | All v4 positions; tranche shares; NAV | Replaces hook-managed liquidity + v3 pipe; native ERC-20 share (7575 lookup) + `RegimeEntry7575` ERC-7575 entry (ERC-4626 minus ERC-20) |
| `StrategyController` / `StrategyAgent` | Deploy/pull/re-center decisions within bounds | Reuse existing controller/agent pattern |
| `TrancheAccountant` | Settlement, waterfall, epochs | Unchanged in principle; global junior budget |
| Rest venues | Idle capital | Aave / ERC-4626; size deploys vs **effective withdrawable** amount |

## 3. `PoolGuardHook` spec

### 3.1 Permissions (mined address flags)

`beforeInitialize`, `beforeAddLiquidity`, `beforeRemoveLiquidity`, `beforeSwap`.
All delta flags **false**. No `afterSwap` unless needed for events. Address MUST NOT start with `0x91` (use a prefix-checking miner).

### 3.2 Callback behavior

| Callback | Rule |
|---|---|
| `beforeInitialize` | Revert unless called through the book factory/initializer (no stray pools on this hook) |
| `beforeAddLiquidity` / `beforeRemoveLiquidity` | Allow only `RegimeVault` (and the manager role); revert otherwise (private pool) |
| `beforeSwap` | **Allow by default.** Revert ONLY on persistent, quoter-readable invalid states: oracle stale / invalid, market closed (oracle exposes `marketStatus`/`session`). NEVER revert because "the fee would be low" or "IL risk is high" |
| Events | `SwapGuarded`, `RegimeChanged`, `OracleInvalid` for the subgraph |

### 3.3 Forbidden in the hook

Fee overrides · `updateDynamicLPFee` · any non-zero `BeforeSwapDelta`/`AfterSwapDelta` · position management · logic keyed on `sender` · `tx.origin` · custom `hookData` requirements · upgradeability.

## 4. Liquidity layer (vault + agent)

### 4.1 Positions

- **Base position** — small, in-range, always present. Purposes: routing discovery TVL, price anchor (prevents the gate wedge), keeps quotes alive. Bears small bounded IL by design.
- **Window position** — the fee-earning size; deployed around the oracle-implied range only when the sweep says EV > 0; pulled otherwise.

Both are owned by `RegimeVault`. Tranche shares claim on vault NAV; senior target + junior first-loss accounting as in current `ACCOUNTANT.md`, with **one global junior budget** across all pools/tiers (never duplicated per pool).

### 4.2 Agent loop (hourly, reuse `agent/model.mjs` fee-vs-IL sweep)

1. Compute expected fee capture (volume estimate × static fee) vs expected IL (σ² · horizon) + re-center cost.
2. Healthy regime (EV > 0): deploy/renew window liquidity at the oracle-implied range.
3. Sustained EV < 0: pull window liquidity. **Base stays.**
4. Re-center on redeploy after a pull: with base liquidity present, execute a keeper swap to move `slot0` toward the oracle price, THEN add the window range. **Never redeploy around a stale tick.**
5. Hysteresis: regime only changes at agent actions (latched); no time/block-dependent flip inside a quote window.

### 4.3 Rest venue requirements

- Immediately withdrawable, right denomination, no deleveraging path.
- Size window deploys against **effective withdrawable assets** (`getMaxWithdraw`-style), not reported balances — Aave utilization and vault caps can make reported > withdrawable.
- **Morpho looping is forbidden as pool inventory.** It goes in a separate junior strategy sleeve: real oracle, conservative LLTV, hard caps, never needed for swap execution.

## 5. Pools & fees

- **Default: ONE pool**, static `fee` sized to cover average adverse selection (start 0.3–1% for NVDA/USDC), suitable `tickSpacing`. Best TVL concentration, single book, best discovery.
- **Optional Phase 2 "surge pool"**: same pair, SAME hook address, higher static fee (e.g., 3%), thin, funded only in marginal regimes. It is the premium lever that does not trigger the allowlist. Build only if measured rejected-notional is material; each pool must clear discovery floors independently.

## 6. Quote, gating & discoverability rules

- Availability lives in **state** (liquidity present/absent), never in conditional swap logic.
- Reverts: rare, persistent, quoter-readable only (oracle stale/closed). A reverting pool loses routes; a thin pool merely loses at price comparison. Prefer thin.
- Never behave differently by `sender`; never create quote≠execution.
- Swaps MUST succeed with **empty `hookData`** through Universal Router and V4Quoter.
- Expose views for integrators: effective liquidity, oracle validity, regime flag, (if surge pool) per-pool fees.
- Keep the pool quotable at all times (base). Monitor quote-failure rate and TVL vs discovery floor.

## 7. Compatibility checklist

- [ ] Static fee only; no delta flags; address not `0x91`
- [ ] Base TVL at all times
- [ ] Empty-`hookData` swap verified via Universal Router + V4Quoter simulation
- [ ] No proxy/upgradeability; source verified on explorer
- [ ] No protocol-fee bypass; no custom router requirements
- [ ] Optional `Uniswap/hooklist` entry + human-readable description post-launch

## 8. Prohibited patterns (escalate if "needed")

Dynamic fee override · `updateDynamicLPFee` · return deltas · bad-quote traps · caller-dependent behavior · deviation gate without a price anchor · leverage in pool inventory · external LPs (unless deliberately opened) · custom `hookData` requirement · `0x91` address · proxy upgrades.

## 9. Migration from `TrancheJITHook` v3

| File / area | Change |
|---|---|
| `src/hook/TrancheJITHook.sol` | Remove `updateDynamicLPFee` calls and the `fee \| OVERRIDE_FEE_FLAG` return; remove the JIT engine (`_jitBeforeSwap` / `_jitAfterSwap` / `_sizeJit`); retarget `liquidityGuard` to the vault; keep oracle validity checks only |
| Deploy scripts | `key.fee: 0x800000` → static fee; verify mined flags have delta bits clear and address ≠ `0x91` |
| `src/hook/libraries/HookParams.sol` | Drop dynamic-fee fields; keep oracle band/TTL for the agent |
| New `RegimeVault` | Owns base + window positions; tranche shares; NAV/waterfall hooks into `TrancheAccountant` |
| `StrategyController` / `StrategyAgent` | Add bounded `deployWindow` / `pullWindow` / `recenter`; keep no-mint/burn/no-fund-moves guarantees |
| `agent/*` | Add re-center step to the hourly loop; sizes gated by effective withdrawable venue amounts |
| Subgraph | Index regime changes, base/window events, re-centers |

## 10. Tests & acceptance

- V4Quoter quote-simulation tests: quotes available at all times with base present; guard reverts only on stale/closed oracle.
- Universal Router swap with empty `hookData` succeeds.
- Regime transitions: deploy → pull → redeploy with re-center (assert no stale-tick fill: post-redeploy pool tick within tolerance of oracle).
- Private-LP enforcement: external `addLiquidity` reverts; vault operations succeed.
- Venue sizing: deploy blocked when venue's effective withdrawable < needed.
- Invariants: junior budget single-sourced; no delta flags exercised; fee static (assert pool key fee unchanged after all flows).

## 11. Open questions (operator decisions)

1. Target chain (Robinhood Chain vs Base vs Unichain; Arc testnet is not Labs-routed).
2. "Major token pair" review risk for NVDA/USDC — decide whether to accept a possible one-time review.
3. Oracle source + session semantics on target chain.
4. Rest venue availability on target chain (Aave/ERC-4626).
5. Senior target rate, epoch cadence, expiry.
6. Surge pool: build only if rejected notional is material.
7. Alternative if dynamic pricing is ever required: single review for a custom hook, or use an already-allowlisted dynamic-fee hook (e.g., AEGIS DFM) as a venue.

## 12. Phases

- **P0**: static fee + base TVL + `PoolGuardHook` on testnet; remove dynamic fee/JIT from v3.
- **P1**: `RegimeVault` + agent-driven windows + re-center; end-to-end sims.
- **P2**: surge pool (only if data supports); hooklist entry.
- **P3** (optional): dynamic-fee upgrade path via one review or third-party listed hook.

---

## Appendix A — Reference facts

- Allowlist triggers + criteria: `support.uniswap.org` "Routing for hooked pools" (updated 2026-09-03); newer GTM page adds the major-pair trigger.
- Per-address routing registry: `Uniswap/uniroute-public` → `HOOKS_ADDRESSES_ALLOWLIST: Record<chainId, address[]>`; `ZLCA_HOOKS_PER_CHAIN`, `ZERO_MEASURED_TVL_HOOKS_PER_CHAIN`.
- Fee vs delta: fee = AMM percentage in `PoolKey.fee` (static) or dynamic via `DYNAMIC_FEE_FLAG` + override/`updateDynamicLPFee`; delta = flash-accounting `BeforeSwapDelta`/`AfterSwapDelta` adjusting the swapper's obligation (custom accounting). Both are allowlist triggers; static fee + zero deltas is not.
- Zero-TVL precedent: Uniswap Labs `DualPoolHook` (static fee, vault-parked, JIT) is registered in the ZLCA list — proof that a Labs-owned zero-TVL hook still needed curation.
- Dynamic-fee hooks already carrying allowlist status (alternatives): AEGIS DFM (base+surge, deterministic, `getFeeState()` views across chains), Arrakis Pro, Alphix (LVR fee + JIT rehypo, BUSL). 

## Appendix B — Glossary

- **Quote**: simulated swap; the only way a v4 pool is priced by routers.
- **Base position**: always-on vault liquidity for discovery + price anchor.
- **Window position**: regime-gated liquidity, deployed when fees > expected IL.
- **Re-center**: keeper swap that moves `slot0` to the oracle price before redeploying window liquidity.
- **Regime latch**: state changes only at agent actions, keeping quote == execution.

---

## Appendix C � Implementation addendum (branch `static-fee`, 2026-10)

Where the sections above conflict, the implementation is authoritative:

1. **Open LP.** The pool is public � anyone may add/remove their own liquidity. The hook holds its own
   positions (v4 caller-scoped keys, salts `poolguard.base.v1` / `poolguard.guard.v1`) and cannot be
   drained by third parties.
2. **Two protocol positions.** *Base*: wide band, always present, the discovery anchor; removed only at
   full exit. *Guard*: the bulk, width configured in `GuardParams`, centered on the current tick at
   every (re)deploy; toggled present/absent per swap.
3. **IL guard (beforeSwap).** `PoolGuardSimulator` (external contract, MIT v4-core primitives) walks the
   arriving swap with `SwapMath.computeSwapStep` across initialized ticks, **bounded to our ranges**,
   and returns `ev = S (ourL / totalL) � (oracleValue(in) - oracleValue(out))`. Below
   `minEvBps � notional` the guard is **pulled** (positive deltas minted as ERC-6909 claims); the swap
   then prices against base only � never a revert. Unknown EV (sim reverts / step-cap) also pulls.
4. **Sticky + lazy redeploy.** A pulled guard re-arms on the next EV+ swap, or via the permissionless
   `recheckGuard()` after `recheckInterval` (only if oracle valid and deviation =
   `recheckMaxDeviationBps`). `setDeployEnabled(false)` (standby) suppresses deploys/rechecks but IL
   pulls stay active.
5. **Vault owns the hook.** `RegimeVault` accepts hook ownership and proxies admin (params, recenters,
   deploy enable, recall, pullAll). Capital flow: deposits ? vault ? (`fundHook`) hook inventory ?
   lending venue; `recallFromHook` pulls the guard back, `pullAll` is the full exit.
6. **Combined vault.** The vault replaces the v3 hook-share duties and `TranchePipeModule`: it issues
   `HookShareToken` (minted by the vault), implements `ITrancheHookValue` (NAV incl. hook positions,
   claims and venue balances) and `IHookSharePipe` (wrap/unwrap USDC/equity/proportional), and ports
   `finalizeSettlement` (senior guarantee first, remainder + all equity to junior). Share denomination:
   `SHARE_SCALE = 1e6` with virtual shares `1e3` so tranche `usdcPerShare1e18` rates keep ~.001
   precision (v3's 1e12 leaked % at small NAVs). Standard surface: the stateless `RegimeEntry7575`
   entry implements **ERC-7575** (ERC-4626 minus ERC-20 + `share()`; ids `0x2f0a18c5`/`0xf815c03d`)
   by piping through the vault's wrap/unwrap; the share token's `vault(USDG)` lookup points at it.
7. **Assets note.** `LiquidityAmounts` is an in-repo implementation (v4-periphery's is BUSL);
   `NVDAPriceOracle`/`DemoRouter` pragmas relaxed to `^0.8.26` to coexist with the `^0.8.27`
   tranche stack.
