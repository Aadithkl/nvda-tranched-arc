# Static-Fee Book — Build Plan (branch `static-fee`)

Status: plan of record for the static-fee build · Design freeze: [`STATIC_FEE.md`](STATIC_FEE.md) ·
Version model: **two books, two branches, one repo — nothing removed**

**Build status:** P0a + P0b + P1 + P2 implemented on this branch — `PoolGuardHook` (guard, base+guard positions,
pull/redeploy/recheck), `PoolGuardSimulator` (per-swap SwapMath EV), `RegimeVault` (share issuer, NAV,
pipe, settlement, allocator; owns the hook), `RegimeEntry7575` (stateless ERC-7575 entry: ERC-4626
minus ERC-20, `0x2f0a18c5`; share token carries the `0xf815c03d` lookup), `VaultStrategyController` +
`VaultStrategyAgent` (bounded operator surface), `StrategyModule` +
`MorphoBlueLendAdapter`/`ERC4626Adapter`/`MorphoLoopAdapter`
(fixed-function adapters, absolute/relative caps, Curator/Allocator/Sentinel with timelocked increases),
`ChainlinkSessionOracle` (Chainlink mid + pushed session layer), `agent/static.mjs`
(recheck/recenter + strategy park/resume/deleverage decisions), and deploy scripts. **Target chain moved
to Robinhood Chain (4663; USDG quote; Morpho Blue; canonical v4)** — see `docs/STRATEGY_MODULE_PLAN.md`
and `deployments/robinhood-{mainnet,testnet}.json`. Implemented mechanics supersede where in conflict:
open LP, hook-held base/guard, per-swap SwapMath EV via external simulator, pull-thin (never revert),
sticky pull + lazy EV+ redeploy + permissionless time recheck, session-gated market-open guard.
Security pass (slither) on the hook/vault/hub: all actionable findings fixed (hub: pointer
flip before the from-book pull, checks-effects-interactions; rest is lib noise or intentional).
**Robinhood porting verified on-chain 2026-10-09** (`npm run robinhood:verify`, all checks pass)
and **fork-rehearsed** on live 4663 (`test/fork/RobinhoodFork.t.sol` — 5/5: live addresses +
market-id match, real Chainlink feed + session oracle, base/guard book on the canonical
PoolManager with real USDG/NVDA, fair-keep/toxic-pull, real Morpho supply/withdraw, tranche
deposits with D2-closed entry + junior-led floor gate).
Built on top since (2026-10-11/12, see `docs/DUAL_BOOK_PLAN.md` §7.3): `RegimeVault`→`LedgerVault`
rename + `usdc`→`quote` sweep; tranched 7540 top (senior principal-only, junior residual/first-loss,
20/30bps exit schedule); permissionless 24h epochs (25% junior floor, seniority order); WETH-quote
18-dec share math; controller knob timelock; `RatioSessionOracle`; dual-book `DualBookHub` + atomic
migration (`DeployDualBookStack`, `decideBookRouting`). Local suite 250 pass / 1 pre-existing skip;
agent suite 15/15.
Remaining: 46630 testnet deploy, 4663 mainnet deploy (address verification checklist in the strategy
plan), subgraph/frontend retarget, unchecked box in §5.

## Expiry & withdrawals (implemented)

**In-life redemption ladder** — vault idle → hook idle → lending venue → strategy adapters
(redemption-safe only) → **guard recall** (`guardRecallOnWithdraw`, default on) → revert.
Price-dependent ops (`wrapUSDC` / `unwrapUSDC` / `unwrapEquity`) require a valid oracle/session;
`unwrapProportional` is oracle-free and always available.

**Slow halt** — soft step at `T−Δ` (agent `decideWinddown`: deployments off, optional guard recall),
then the **permissionless `haltIfExpired()`** at `T`: deployments stay off and `hook.pullAll()` returns
**base + guard** to the vault (`exited` ⇒ the hook can never redeploy; base is removed too). Owner
`halt()` remains for early exits. Public LPs are untouched.

**Settlement** — the `VaultReadiness` view (`src/vaults/VaultReadiness.sol`) reports units / senior
guarantee / shortfall / loop debt / pending requests; `finalizeSettlement()` requires the senior
guarantee funded (otherwise the explicit owner `finalizeSettlementHaircut()`), freezes rates across
**held + pending** shares, and credits the senior/junior vaults.

**Post-settlement exit** — users pull a withdraw request on their senior/junior vault
(`requestRedeem` is allowed post-maturity), anyone can `fulfillRedeemMatured(user)`, and
`claimMatured(receiver)` pays the frozen rates (senior USDC-only; junior USDC + equity). Requests that
were pending at expiry flow through the same path — nothing is stranded.

**Strategy module** — new risk-increasing ops (`allocate` / `allocateCollateral` / `borrow`) revert
after expiry; de-risking (deallocate/repay/deleverage) and settlement `exitAll` stay available.

## 0. Version model

| | **dynamic-fee book** | **static-fee book** |
|---|---|---|
| Branch | `main` (frozen, live) | `static-fee` (this build) |
| Execution layer | `TrancheJITHook` — dynamic fee + JIT | `PoolGuardHook` — static fee, guard-only + `RegimeVault` |
| Liquidity layer | hook-managed JIT, Aave rest, v3 share pipe | vault-owned base + window positions; native share + ERC-7575 entry |
| Status | live on Robinhood Chain; ops/deploy fixes only | built 2026-10-11/12 (see header + `DUAL_BOOK_PLAN.md` §7.3); §5 boxes audited, one open |

Rules:

- `main` is **never edited by this plan**. The dynamic-fee version stays deployed and intact on GitHub.
- The design §9 migration ("remove dynamic fee/JIT") is applied **only on this branch** — safe because
  `main` preserves v3 byte-for-byte. The branch carries a clean, single static book.
- Promotion is a deliberate later step (§6), never a direct push to `main`.
- Optional frozen marker: tag the starting `main` commit `dynamic-fee-v3` (no code change).

## 1. Naming

- Versions: **static-fee** / **dynamic-fee**.
- New contracts keep the design-freeze names: `PoolGuardHook`, `RegimeVault`.
- Docs on this branch: `docs/STATIC_FEE.md` (design, renamed from `FINAL_DESIGN.md`) and this plan;
  `docs/HOOK.md` and `README.md` are rewritten for the static book. `main` keeps the dynamic docs.

## 2. Branch mechanics

- `static-fee` branched from `main` @ `dca96c6` (2026-10-08).
- CI: add `static-fee` to the push branches in `.github/workflows/ci.yml` so pushes build + test;
  PRs to `main` already run CI.
- Pages: `main` only. No second Pages site; the static UI runs locally until promotion.
- Deployments: `deployments/robinhood-{mainnet,testnet}.json` are the static book records on this
  branch; the v3 record stays on `main`.
- No force-pushes; `main` is never deleted; the branch is deleted only after a deliberate promotion.

## 3. File-level plan (branch `static-fee` only)

### Create

| File | Purpose |
|---|---|
| `src/hook/PoolGuardHook.sol` | Guard-only: `beforeInitialize`, `beforeAddLiquidity`, `beforeRemoveLiquidity`, `beforeSwap`; revert only on persistent quoter-readable states (oracle stale/invalid, market closed); private LP (vault/manager only); all delta flags false; mined address, not `0x91` |
| `src/vaults/RegimeVault.sol` | Owns all v4 positions (base + window); issues tranche shares; exposes `convertToUsdc`/`expired` (`ITrancheHookValue`) so `TrancheAccountant` values the book; pipe surface for Senior/Junior vaults |
| `script/DeployStaticBook.s.sol` | `HookMiner.find` (non-`0x91`, exact flag bits), CREATE2 deploy, static-fee key, seed base position |
| `script/DeployStaticStack.s.sol` | Accountant + vaults wired to the vault as value source; controller hook wiring |
| `test/unit/PoolGuardHook.t.sol` | Guard semantics, private LP, staleness/closure, empty-`hookData` swap |
| `test/unit/RegimeVault.t.sol` | Base/window lifecycle, re-center, venue-cap sizing |
| `test/invariant/StaticBookInvariant.t.sol` | Fee stays static; junior budget single book; no delta flags exercised |

### Migrate (design §9, on this branch only)

| Area | Change |
|---|---|
| `src/hook/TrancheJITHook.sol` | Superseded by `PoolGuardHook`; dynamic-fee return, `updateDynamicLPFee`, JIT engine removed |
| `src/hook/libraries/HookParams.sol` | Drop dynamic-fee fields; keep oracle band/TTL |
| `script/DeployTrancheHook*.s.sol`, `DeployTrancheStack.s.sol` | Superseded by the static deploy scripts |
| `test/unit/TrancheJIT*.t.sol` | Removed on branch (preserved on `main`) |
| `docs/HOOK.md`, `README.md` | Rewritten for the static book |
| `src/strategy/*` | Add bounded `deployWindow` / `pullWindow` / `recenter`; keep no-mint/burn/no-fund-moves guarantees |
| `agent/*` | Hourly loop gains deploy/pull/re-center (reuse `agent/model.mjs` fee-vs-IL sweep); size against effective withdrawable venue amounts |
| `subgraph/*` | Index regime changes, base/window deploy/pull, re-centers |

### Reused unchanged (shared stack)

`TrancheAccountant`, `SeniorVault` / `JuniorVault`, `NVDAPriceOracle`, Aave semi-fork,
`StrategyController` bounds pattern, `HookShareToken` share + `RegimeEntry7575` (ERC-7575), graph/agent tooling.

### Known wiring mapping (verified in current code)

- `TrancheAccountant.hook` is a **value source** (`ITrancheHookValue.convertToUsdc` / `expired`) —
  on this branch it is set to `RegimeVault`; no accountant rewrite needed.
- Tranche vaults take `(hookShare, USDC, equity, pipe)`; `RegimeVault` provides the share/pipe
  surface. Reuse `HookShareToken` vs vault-native share → decision in §7.

## 4. Build phases

**P0 — guard + discovery floor**

1. Mine the `PoolGuardHook` salt (non-`0x91`, delta bits false); assert in the deploy script.
2. Static pool key (start 0.3–1% NVDA/USDC) + suitable `tickSpacing`; `beforeInitialize` book-only.
3. Private-LP enforcement + oracle stale/closed gate; switches are latched, never per-quote.
4. V4Quoter simulation with base present; Universal Router swap with empty `hookData`.
5. `forge fmt --check && forge build --sizes && forge test` green on the branch.

**P1 — vault + agent**

1. `RegimeVault` base + window positions; tranche shares; NAV/waterfall into `TrancheAccountant`.
2. Bounded `deployWindow` / `pullWindow` / `recenter`; hysteresis latched at agent actions.
3. Venue sizing vs **effective withdrawable**; Morpho looping forbidden in pool inventory.
4. Invariant suite + E2E sim; re-center tolerance (post-redeploy tick vs oracle).

**P2 — deploy + data**

1. Deploy on Robinhood Chain testnet alongside live v3 (second pool/hook; shared oracle + lending).
2. `staticBook` section in deployments; subgraph datasource; agent heartbeat dry-run first.
3. Frontend preview locally (not Pages).

**P3 — optional**

Surge pool only if rejected notional is material; hooklist entry; dynamic-fee path (design §11.7).

## 5. Acceptance checklist (design §10) — audited 2026-10-12

- [x] Quotes available at all times with base present; guard reverts only on stale/closed oracle
  (`test_swap_reverts_whenOracleStale/Invalid`, `test_swap_sessionMask_enforced`,
  `test_evPull_onToxicSwap` — toxic flow pull-thins, never reverts — + fork fair/toxic)
- [x] Swaps with empty `hookData` succeed — via `DemoRouter` (unit + fork); Universal Router
  itself is NOT wired, so the box as literally written stays open if UR integration is wanted
- [x] Deploy → pull → redeploy re-centers (`test_recenter_guard`, `test_pullAll_and_rearm`,
  `DualBook.t.sol` round-trip rearm; post-redeploy tick vs oracle covered in P1 E2E)
- [x] SUPERSEDED — "external `addLiquidity` reverts": implemented mechanics moved to **open LP**
  (status header); `test_publicLp_open` covers it, vault ops throughout the suite
- [ ] Deploy blocked when venue effective withdrawable < needed — no test pins this; still open
- [x] Invariants (`test_staticFee_afterAllFlows` + `TrancheInvariant.t.sol` 7 invariants:
  senior-claim cap, claims conservation, escrow formula, share peg, locked backing, no stray
  mint, redeem backing; `beforeSwap` returns zero delta on every flow)

## 6. Promotion criteria (`static-fee` → `main`)

Defined now so both branches have an exit, even though promotion is out of scope for the build:

- Static book deployed and stable; routing discovery measured (base TVL vs discovery floor);
  window fee capture beats base-only behavior in live data.
- Then PR `static-fee` → `main`. On merge, `main` becomes the static book; the dynamic version
  remains in history (and the optional `dynamic-fee-v3` tag). Never force-pushed, never deleted.

## 7. Open decisions

1. Target chain for the static deploy (design §11.1).
2. Share token: settled - vault-native `HookShareToken` (ERC-7575 share lookup) + `RegimeEntry7575` entry point declaring ERC-7575 (ERC-4626 minus ERC-20); full 4626 compliance deliberately avoided (in-kind multi-asset exits).
3. Major-pair review risk acceptance for NVDA/USDC (design §11.2).
4. Frontend version display while both branches exist (main app keeps v3 until promotion).
5. Whether this branch should ever carry both hooks side-by-side — **yes now
   (superseded 2026-10-12)**: `DualBookHub` + books A/B, atomic `submitSwitchBook` migration
   (`docs/DUAL_BOOK_PLAN.md` §7.3, `script/DeployDualBookStack.s.sol`).

## 8. Guardrails

- No edits to `main` as part of this build; design §9 applies on `static-fee` only.
- Never delete `TrancheJITHook.sol` from `main`; never remove the GitHub repo or branches.
- No force-push anywhere; `main` stays the live dynamic-fee book until a deliberate promotion.
