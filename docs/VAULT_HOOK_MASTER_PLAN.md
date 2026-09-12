# NVDA Tranched Platform — Vaults & Hook Master Plan

**Standards:** ERC-7540 (Senior/Junior tranches) · ERC-7575 (pool strategy share)
**Scope:** tranche layer → rules → hook (rehypothecation JIT) → agent control plane
**Status:** in progress — tranche vault structure landed (`src/vaults/`); rules module, hook share token, JIT hook, agent next

---

## 1. Purpose & scope

Build the remaining protocol end-to-end:

1. Senior/Junior user vaults (ERC-7540) holding a single ERC-7575 pool share.
2. Shared tranche rules (escrow, waterfalls, redemption priority).
3. `TrancheJITHook`: mints pool shares, rehypothecates idle capital to Aave V2,
   performs per-swap JIT, dynamic fee, gated execution.
4. `StrategyController` + offchain AI agent controlling yield generation within caps.

No separate lending adapter. No PoolVault-with-venues. The hook **is** the strategy.

---

## 2. Existing infrastructure (live on Arc Testnet)

| Item | Details |
|---|---|
| Uniswap v4 fork | `PoolManager 0xFc41…Ae67`, full periphery (`PositionManager`, `PositionDescriptor`, `StateView`, `V4Quoter`, `ReservesLens`), `Permit2`, `Multicall3`, canonical CREATE2 deployer |
| Hook path | proven with `SmokeHook` (`beforeSwap`/`afterSwap` fired, `hookData` delivered verbatim) |
| Oracle | `NVDAPriceOracle 0x2D58…738A` (x402 push, 8 decimals, 300s staleness) |
| x402 rail | Circle Gateway nanopayments on Arc; seller + keeper scripts working |
| Pools | USDC/EURC (real, tick -1499 = 1.1617 USD/EUR), mUSDC/mNVDA demo pool |
| Indexing | subgraph (oracle + pool) builds; deploy pending Studio key |
| FE pack | `deployments/arc-testnet.json`, `docs/abis/`, `examples/`, `docs/FRONTEND_INTEGRATION.md` |

Live addresses: see `docs/DEPLOYMENTS.md`.

---

## 3. Final architecture

```
Users ─► SeniorVault (7540) ─┐ hold HookShares       (sync deposit, async redeem)
        JuniorVault (7540) ──┤
                             ▼
                 TrancheAccountant  (THE RULES)
                 • seniorClaim = seniorPrincipal + 5% escrow
                 • juniorClaim = poolValue − seniorClaim   (2x leverage math)
                 • profit → senior escrow first, rest to junior
                 • loss → junior first (shares move Jr → Sr)
                 • rebalance() moves PoolShares between S and J
                 • senior-priority redemption queue (keeper-fulfilled)
                             ▼
        TrancheJITHook  ══  HookShareToken (ERC-7575)
        • mints/burns shares at share price; holds Aave V2 positions (aTokens)
        • REST: idle capital supplied to Aave V2 → yield
        • ACTIVE: per-swap JIT (beforeSwap deploy → afterSwap remove/re-supply)
        • dynamic fee (agent-tuned), gates, pause
                             ▲
                StrategyController ← AGENT
                (The Graph + x402 data → volatility policy;
                 quoting on/off, fees, distribution, thresholds within caps;
                 NEVER mint/burn shares, transfer out, or change caps/roles)
```

### Layer clarifications (locked)

- **No separate lending adapter.** The hook rehypothecates to Aave V2 directly
  (`IAaveV2Pool` supply/withdraw + aToken balance). Local tests use a functional
  `MockAaveV2Pool` implementing the same interface.
- **Both 7540 tranches hold the 7575 shares.** `asset()` of each tranche vault is the
  pool share; users enter with USDC through an atomic pipe helper (`depositUSDC`).
- **Rules live in a shared module** (`TrancheAccountant`), not inside either vault and
  not inside the pool share.
- **Agent sits at the hook/pool layer** and controls asset yield generation
  (quoting, fees, distribution, thresholds) — not venue allocation between adapters.

---

## 4. Standards & interfaces

| Interface / Contract | Purpose |
|---|---|
| `HookShareToken` (ERC-7575) | ERC-20 share, `vault(asset)` lookup, ERC-165 `0xf815c03d` |
| `TrancheJITHook` | Strategy vault + v4 hook: shares, Aave V2 rest, JIT, fees, gates, params |
| `TrancheAccountant` | Entitlements, waterfalls, `rebalance()`, redemption queue, automation |
| `TrancheVault` (ERC-7540 base) | `asset = HookShareToken`, sync deposit, keeper `AdminRedeem` |
| `SeniorVault` / `JuniorVault` | Thin, rules delegated to the accountant |
| `StrategyController` | Roles, caps, bounds, cooldown, circuit breaker, pause |
| `IHookShareToken`, `IAaveV2Pool`, `ITrancheAccountant`, `ITrancheVault`, gate structs | Interfaces |
| `MockAaveV2Pool` (test-only) | Functional Aave-V2-interface rest state |

---

## 5. Tranche layer (ERC-7540)

- **Deposits:** synchronous (UX), mint tranche shares at current entitlement rate.
- **Redeems:** asynchronous — `requestRedeem` locks shares; keeper fulfills
  (rate fixed at fulfillment); user claims.
- **USDC entry:** `depositUSDC(amount)` → pipe mints HookShares → vault deposit (one tx).
- **Senior priority:** junior requests are fulfilled only after the senior queue drains.
- **NAV:** computed by the accountant (`seniorClaim`, `juniorClaim`), not by raw share balances.

ERC-165 interface IDs to assert: `0xce3bbe50` (7540), `0x620ee8e4`, `0x2f0a18c5`
(deposit/mint/withdraw/redeem), `0xf815c03d` (7575).

---

## 6. Pool share (ERC-7575)

- One share token over the whole pool (lending position + JIT/claim positions + fees).
- Externalized share token enables pipes for entry/exit assets (USDC first).
- Mint/burn authority: `TrancheJITHook` only.

---

## 7. Tranche rules (`TrancheAccountant`)

1. `seniorClaim = seniorPrincipal + escrow`, escrow target **5%** of senior principal.
2. `juniorClaim = max(poolValue − seniorClaim, 0)` → the brief's math
   (+20% pool → +40% junior; −20% → −40%).
3. **Profit waterfall:** yield funds senior escrow first; excess → junior.
   Enforced by moving excess PoolShares `SeniorVault → JuniorVault`.
4. **Loss waterfall:** junior absorbs first; PoolShares move `JuniorVault → SeniorVault`
   to keep senior covered. If `poolValue < seniorClaim` → documented senior haircut.
5. **Redemption:** keeper, senior priority, fixed-at-fulfillment rates,
   `rebalance()` runs before fulfillment.
6. **Rounding:** conservative, in favor of senior; dust bounded by invariant tests.

---

## 8. Hook design (`TrancheJITHook`)

- **Permissions:** `beforeInitialize` (block direct init), `beforeAddLiquidity` /
  `beforeRemoveLiquidity` (block external LPs), `beforeSwap`, `afterSwap`. No return-delta flags.
- **Rest state:** 100% idle capital supplied to Aave V2 (aTokens).
- **JIT lifecycle:** `beforeSwap` gates → withdraw shortfall from Aave → deploy
  multi-bucket positions (transient storage tracks exactly what was added) →
  normal v4 swap math → `afterSwap` remove positions, settle deltas via flash
  accounting (redeem ERC-6909 claims first), re-supply leftovers to Aave, accrue fees to pool.
- **Gates (all must pass):** quoting on/off · risk mode (escrow funded) · market open
  (`marketStatus` 1–4) · oracle freshness · deviation vs fair price ≤ threshold ·
  toxic-direction check (block moves away from fair price) · MEV/cooldown · +EV fee.
  Reject reasons: `QuotingPaused`, `MarketClosed`, `ILTooHigh`, `ToxicFlow`, `NotEvPositive`.
- **Full stop allowed:** agent/guardian may disable quoting; swaps revert, capital stays in Aave.
- **Dynamic fee (yes):** pool initialized with `DYNAMIC_FEE_FLAG (0x800000)`.
  - `setBaseFee` → `PoolManager.updateDynamicLPFee` (hook-only, no unlock).
  - per-swap surge via `beforeSwap` override (`OVERRIDE_FEE_FLAG 0x400000`, ≤ `MAX_LP_FEE 1e6`).
- **Tick spacing (CL):** part of the immutable `PoolKey` → cannot change on an existing pool.
  Our design makes "changing" it cheap: initialize a new pool with the new spacing and
  `setActivePool(newKey)` (owner-level: same currencies, hooks = this, dynamic fee, initialized).
  No capital migration needed — JIT positions are transient and capital rests in Aave.
  Default spacing: **60**.
- **Params (agent-callable within controller bounds):** quoting on/off, base fee, surge
  params, distribution buckets (spacing-quantized), gate thresholds
  (IL, min EV, max trade size, cooldown).
- **Structural (owner-only):** `initializePool`, `setActivePool`, roles/caps.

---

## 9. Agent & control plane

- **Data in:** The Graph subgraph (OracleState, PriceUpdate history, Pool, PoolSwap —
  volatility, volume, deviation) + x402-paid data (NVDA quotes, premium signals),
  settled via Circle Gateway on Arc.
- **Reasoning:** offchain AI agent computes a volatility regime and decides actions.
- **Regimes:** Calm (tight buckets, lower fee, quoting on) · Elevated (wider, higher fee,
  smaller max trade) · Turbulent (widen/disable buckets, quoting off) · Closed/stale (rest only).
- **Enforcement:** `StrategyController` — agent/guardian/keeper/owner roles, fee/bucket
  bounds, max deploy per swap, per-epoch caps, cooldowns, drawdown circuit breaker →
  force rest state, guardian pause.
- **Hard floor:** onchain gates apply regardless of agent input; a wrong agent decision can
  only reduce activity, never force a bad swap or move funds out.
- **Runtime:** runtime-agnostic daemon (decided later); CRE workflow stub for deterministic
  safety rules; RPC fallback if the subgraph is down; agent offline → last bounded config.

---

## 10. Prior art & novelty (licenses verified)

| Project | Rehypo → lending | JIT | Dynamic fee | Volatility/agent | Tranches | License |
|---|---|---|---|---|---|---|
| OZ `ReHypothecationHook` | ✅ any yield source | ✅ single position | ❌ | ❌ | ❌ | MIT |
| Uniswap `DualPoolHook` | ✅ ERC-4626 rest | ✅ multi-bucket + ERC-6909 | ❌ | ❌ | ❌ | MIT |
| SymbioteHook | ✅ Aave V3 | ✅ + leverage | ❌ | ❌ | ❌ | none detected |
| RefluxHook (ETHGlobal) | ✅ Aave V3 | ✅ | ❌ | ❌ | ❌ | none detected |
| EulerSwap | ✅ Euler vaults | ✅ (JIT borrow) | custom curve | single-LP | ❌ | custom |
| OZ `DynamicLPFeeHook` | ❌ | ❌ | ✅ owner-set | ❌ | ❌ | MIT |
| **Ours** | ✅ Aave V2 | ✅ multi-bucket + oracle gates | ✅ agent-tuned | ✅ AI agent + caps | ✅ 7540 + 7575 | MIT (ours) |

**Novel in ours:** agent-governed yield generation with onchain bounds · tranche claims over
JIT · oracle-gated JIT (reject + keep earning) · direction-aware toxic-flow gate · volatility-
coupled surge fees.

**Reuse (MIT):** OZ `uniswap-hooks` (share/JIT/dynamic-fee patterns),
Uniswap `v4-hooks-public` (DualPool JIT details), OZ `openzeppelin-community-contracts`
(ERC7540). Study-only: EulerSwap / Symbiote / Reflux (licenses unclear).

---

## 11. Build phases

| Phase | Deliverable | Exit criteria |
|---|---|---|
| **P1 Foundations** | Vendor OZ uniswap-hooks + v4-hooks-public + OZ community ERC7540 (pin to v4-core `59d3ecf` compat); remappings; `PRIOR_ART.md`; `LICENSES.md`; interfaces; `MockAaveV2Pool` | `forge build` green |
| **P2 Rules** | `TrancheAccountant` (claims, escrow, waterfalls, rebalance, senior-priority queue, automation) tested vs `MockHookVault` | Invariants: `seniorClaim ≤ poolValue`, junior ≥ 0, share conservation |
| **P3 Tranches** | `TrancheVault` + `SeniorVault`/`JuniorVault` (ERC-7540, asset = HookShare, `depositUSDC`) | 7540 lifecycle, operator approvals, ERC-165, ±20%→±40% math |
| **P4 Hook core** | `HookShareToken` + `TrancheJITHook` (shares, Aave V2 rest, params, pause, activePoolKey); wire P2/P3 to real hook | Vault↔hook e2e on `MockAaveV2Pool` |
| **P5 JIT + fees** | Multi-bucket JIT, transient locks, claims, gates, dynamic fee + surge | Allow/reject matrix, fee fuzz, zero-residual liquidity invariant |
| **P6 Agent** | `StrategyController` + reference daemon (regimes) + CRE stub | Capability matrix, compromised-agent bounds, circuit breaker |
| **P7 Hardening** | Full unit/integration/invariant/fuzz suite; gas snapshots; CI | Suite green + `forge fmt --check` |
| **P8 Testnet** | Deploy hook (mined), pool (dynamic fee), shares, vaults, accountant, controller; e2e with real USDC | Addresses + txs in `DEPLOYMENTS.md`, manifest/ABIs/subgraph/FE pack refreshed |

---

## 12. Parameters & defaults

| Param | Default |
|---|---|
| Senior escrow target | 5% of senior principal |
| Fee mode | dynamic (`0x800000`), base + surge bounds in controller |
| Tick spacing | 60 |
| Oracle staleness | 300s |
| Redemption | keeper, senior priority, fixed at fulfillment |
| Caps | max fee, max bucket width, max deploy/swap, epoch cap, cooldown, drawdown breaker |

---

## 13. Test matrix

- **Accountant:** escrow funding, profit/loss waterfalls, `rebalance()` share moves,
  senior haircut, redemption ordering, rounding/dust.
- **Tranches:** deposit/redeem lifecycle, pipe helper, operator approvals, preview-revert
  rules, ERC-165 IDs (`0xce3bbe50`, `0x620ee8e4`, `0x2f0a18c5`, `0xf815c03d`), leverage math.
- **Hook:** share price, Aave deposit/withdraw, JIT add/remove exactness, ERC-6909 claims,
  reentrancy locks, gates per reason, fee bounds, quoting toggles, `setActivePool`.
- **Agent:** capability allowlist, cap/cooldown enforcement, circuit breaker → rest,
  compromised-agent simulation.
- **Invariants:** `seniorClaim ≤ poolValue`, junior NAV ≥ 0, no residual pool liquidity
  after swaps, share conservation ±dust, no over-redemption.
- **Scenario:** calm/elevated/turbulent/closed regimes; senior-first redemption under stress.

---

## 14. Deployment & integration plan

1. Prereqs: M2b Aave V2 fork (rest state) — or first pass with `MockAaveV2Pool`;
   optional Graph Studio key.
2. Hook deploy: salt-mined address via canonical CREATE2 deployer (`0x4e59…4956C`).
3. Pool init: dynamic fee + spacing 60; hook `setActivePool`.
4. Deploy shares, vaults, accountant, controller; seed with real USDC.
5. E2E on Arc: deposit both tranches → yield → escrow → risk mode → JIT allow/reject
   txs → senior-first redemption. Real-USDC flows via viem/`cast send` (Foundry cannot
   simulate Arc's compliance precompile used by USDC `transferFrom`).
6. Refresh `deployments/arc-testnet.json`, `docs/abis/`, `FRONTEND_INTEGRATION.md`,
   subgraph (new hook events + dynamic-fee pool), docs, commit + push.

---

## 15. Risks & mitigations

| Risk | Mitigation |
|---|---|
| OZ hooks lib incompatibility with v4-core 1.0.2-era | Pin/inspect at P1; adapt imports; pattern-port fallback (MIT) |
| Aave V2 fork not ready | Mock rest state for tests; testnet first pass with mock; repoint later |
| Arc precompile vs local simulation | mock tokens locally; viem/cast for real-USDC E2E |
| Rebalance rounding/dust | conservative rounding (favor senior); dust invariant tests |
| Aave liquidity constraints | withdrawal caps checked at JIT/fill time; reject path documented |
| Agent misbehavior | caps + gates + circuit breaker + guardian; full-stop allowed |
| Dynamic fee misdisplay | manifest marks dynamic; UI reads `getSlot0().lpFee`; swaps carry actual fee |

---

## 16. Open items / deferred

- Graph Studio deploy key (subgraph go-live).
- M2b Aave V2 fork timing (needed for real rest state on testnet).
- Agent runtime placement (server / TEE / CRE hybrid) — runtime-agnostic for now.
- Universal Router deployment (deferred; DemoRouter + PositionManager cover flows).

---

## 17. Reference facts

- `PoolKey = {currency0, currency1, fee, tickSpacing, hooks}` → immutable `poolId`.
  Tick spacing cannot change on an existing pool; new pool + repoint is cheap for us.
- Dynamic fee: `DYNAMIC_FEE_FLAG 0x800000`; `updateDynamicLPFee` hook-only, no unlock;
  per-swap override requires `OVERRIDE_FEE_FLAG 0x400000` and ≤ `MAX_LP_FEE 1_000_000`.
- JIT has no persistent liquidity between swaps — nothing to migrate when repointing pools.
- Arc: native USDC 18d vs ERC-20 6d; USDC `transferFrom` calls compliance precompile
  `0x1800…0001 isBlocklisted` (not emulated by Foundry; works onchain).
