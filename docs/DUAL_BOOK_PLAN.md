# Dual-Book Static Plan — 2 hooks (low/high fee), multi-strategy, volume-steered liquidity

Status: plan of record for implementation (handoff doc) · Branch: `static-fee` · Written 2026-10-11
Supersedes nothing; extends `docs/STATIC_FEE.md` (design freeze) + `docs/STRATEGY_MODULE_PLAN.md`.
Decisions locked 2026-10-11: **assets = WETH + NVDA**, **fee tiers = init-time parameters (immutable)**.

## 0. Current state (verified from code + this build)

| Piece | File | State |
|---|---|---|
| LedgerVault (single book) | `src/vaults/LedgerVault.sol` | share issuer (`HookShareToken`), NAV incl. hook positions/claims/venue, `IHookSharePipe` wrap/unwrap, ladder `_ensureQuote/_ensureEquity`, settlement, owns ONE `PoolGuardHook` (immutable `hook`, immutable `_venueKey`), keeper/owner hook-admin proxies (12 fns), keeper pull door for the controller swap, 7575 bits (`setShareVault`, `wrapSharesExact`), `oracleValid` probe. **Runtime 22,839 / 24,576 — margin 1,737 B (measured 2026-10-12, after rename + swap move).** |
| PoolGuardHook | `src/hook/PoolGuardHook.sol` | per-pool guard: base+guard positions, per-swap SwapMath EV via `PoolGuardSimulator`, pull-thin, lazy redeploy, `recheckGuard`, `pullAll`/`rearm`, `recallToVault`, `withdrawInventory`, claims. Fee-agnostic (fee lives in the `PoolKey`), 21,521 B. |
| Tranches | `src/vaults/{TrancheVault,SeniorVault,JuniorVault}.sol`, `TrancheAccountant` | ERC-7540 (OZ) over tjSHARE; async maturity queue; talk to the vault via pipe only. **Unchanged by this plan** (rename sweep touches names only). |
| ERC-7575 entry | `src/vaults/LedgerEntry7575.sol` | stateless standard surface (ERC-4626 minus ERC-20, ids `0x2f0a18c5`/`0xf815c03d`), pipes through vault; `max*` mirrors the ladder. |
| Strategy | `src/adapters/*` | `StrategyModule` (Curator/Allocator/Sentinel, abs+rel caps, 24h timelock up, `pullToVault` redemption-safe only, `exitAll`, `pullableAssets`) + adapters `MorphoBlueLendAdapter` (lend), `MorphoLoopAdapter` (junior loop, NOT redemption-safe), `ERC4626Adapter`. **Multi-strategy + movable already.** |
| Keeper | `src/strategy/VaultStrategy{Controller,Agent}.sol`, `agent/static.mjs` | bounded ops surface; agent decides recheck/park/winddown. |
| Tests | `test/unit/*` 201 pass, `test/fork/RobinhoodFork.t.sol` 5/5 on live 4663, agent 13. | |

### 0.1 Chain facts added 2026-10-11 (all verified on-chain unless noted)

| Fact | Value | How verified |
|---|---|---|
| ETH / USD Chainlink feed | `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9` — `description()` "ETH / USD", `decimals()` 8, answer `251433766455` | on-chain read via RPC |
| WETH / NVDA Morpho market | `0x141c2b1d2bbecf7f8a76563307d7e5bf586457e873c3d97c4bb1502e57b77952` · oracle `0x63c3ab00B12A7581af3eE8410E161650fBBb7829` · irm `0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1` · lltv 38.5% | `keccak256(abi.encode(params)) == id` locally, and on-chain `market()` supply `482033059174398714` (= API), borrow 0 |
| WETH-loan markets on RH | 23 exist (collaterals: NVDA, bNVDA, SPY, RBLX, NFLX, GME/MSTR/TSLA/PLTR/COIN/QQQ wrapped, Scrypt `scV3-*` LP tokens) | Morpho API 2026-10-11, spot-checked |
| WETH-as-collateral markets | 7, all loan USDG, mostly empty | Morpho API 2026-10-11 |
| Feed catalog (source of truth) | `https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json` | Chainlink directory; summarised at `docs.robinhood.com/chain/oracles-and-price-feeds` and the investors-center chain-facts page |

Feed conventions confirmed: equity/ETF/USD feeds are **8 decimals**, exchange-rate feeds 18; the feed price **already includes the ERC-8056 corporate-action multiplier** — never re-apply `uiMultiplier`. Equity feeds update 24/5 (guard weekends with the session layer); crypto feeds (ETH/USD) update continuously. Observed feed age at check time ~1.9 h — resolve each feed's real heartbeat from the directory at wiring time, don't hardcode.

## 1. Target architecture

```
users ─> ERC-7540 sr/jr vaults ─> LedgerVault (tjSHARE, NAV, pipe, settlement, 7575 entry)
                                      │ quote (WETH) + equity (NVDA) inventory, strategy module (lend/loop, movable)
                                      ▼
                               DualBookHub  (owns BOTH PoolGuardHooks; active-book pointer;
                                             atomic migrate; dwell + freeze policy; aggregated views)
                                ├── Book L: PoolGuardHook L ── v4 pool (fee LOW,  init param)
                                └── Book H: PoolGuardHook H ── v4 pool (fee HIGH, init param)
keeper/agent (volume stats via graph/onchain Swap events) ── switchBook(L<->H) when regime flips
```

- **One active book at a time.** The inactive hook is always fully pulled (policy-enforced), so
  vault NAV/ladder stay correct and there is no split-brain liquidity.
- **Fee tiers are init-time pool parameters, immutable after pool creation** — both hooks run the
  identical `PoolGuardHook` bytecode (two mined instances); only the `PoolKey.fee` differs.
  Values come from env at deploy (`STATIC_FEE_LOW` / `STATIC_FEE_HIGH`), never hardcoded in Solidity.
- **Routing decision is offchain** (agent: volume via The Graph `Swap` events or RPC eth_logs),
  **execution is onchain-gated** (dwell, oracle-valid, not expired, freeze). No per-day flip
  budget (dropped 2026-10-11 as arbitrary — dwell does the job).

## 2. Design decisions (locked for this build)

1. **`DualBookHub` owns both hooks; LedgerVault owns the hub.** The vault's `hook` immutable becomes
   the hub address. The hub is duck-type-compatible with the `PoolGuardHook` surface the vault
   already calls, plus aggregated views. Rationale: vault is 67 B under EIP-170 — all new logic
   MUST live in fresh contracts; the vault stays near-identical.
2. **Vault slimming pays for the additions.** Move the 12 keeper/owner hook-admin proxies
   (`setGuardParams`, `deployGuard`, `recenterGuard`, `rearmHook`, `recallFromHook`, `exitHook`,
   `setHookDeployEnabled`, `initializeHook`, `acceptHookOwnership`, …) OFF the vault onto the hub
   (~-800 B); the vault keeps `fundHook`, `halt*`, settlement pulls, and gains `switchBook(uint8)`.
   Keeper/controller rewires to the hub for guard ops. Net vault size must go DOWN.
3. **Aggregated views replace direct balance reads** (the only mandatory vault edits):
   `quote.balanceOf(address(hook))` → `hub.quoteIdle()`; `equity.balanceOf(address(hook))` →
   `hub.equityIdle()`; `poolManager.balanceOf(address(hook), id)` → `hub.claims(token)` — each
   summed over both hooks. `_positionUnits`/`_ensureQuote`/`_ensureEquity`/`unwrapProportional`/
   `_halt`/`_finalize` use them; `_venueKey` → `hub.activeKey()` (quoteIs0 identical for both
   pools — same token pair).
4. **Atomic migration, single tx:** `vault.switchBook(to)` (onlyOwnerOrKeeper) →
   `hub.pullInactiveAndActivate(to)` (pullAll on from-book, sweep to vault, set active) →
   vault funds `hub` with its full inventory → `hub.deployGuard()` (forwards to active).
   No intermediate state where capital sits idle by accident. Both pools initialized at deploy, so
   migration never initializes a pool (lazy-init fallback: keeper-supplied `sqrtPrice` bounded
   ±1% vs oracle — implement only if needed).
5. **Switch policy:** `switchDwell` (e.g. 1 h) between switches, `switchFrozen`
   (owner/guardian — terminal wind-down for final withdrawal: blocks ALL controller risk-up,
   exits only), require `!vault.expired()` and oracle-valid. Lives on the controller today
   (dwell + freeze, no flip budget); moves with the hub at atomic-migrate time. Events log
   evidence; the agent's decision data stays offchain and reviewable via the keeper's
   controller tx trail.
6. **Strategies stay in `StrategyModule`** — moving between lending/looping is live
   `allocate`/`deallocate` under caps (already built). This plan adds nothing except the new
   market params (§2.12) — adapters slot in without touching the vault.
7. **Assets (DECIDED 2026-10-11): quote = WETH, equity = NVDA.** WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`
   (18 dec), NVDA `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` (18 dec), replacing USDG. WETH
   address sorts below NVDA, so **`quoteIs0` is unchanged**. Consequences, each handled below:
   - (a) The oracle must become a **ratio** oracle — no NVDA/WETH feed exists (§2.9).
   - (b) Share math must be **re-derived for an 18-dec quote** (§2.10).
   - (c) The senior tranche becomes **WETH-denominated**: principal and the senior guarantee are
     WETH, so their USD value floats with ETH. Deliberate product decision (accepted) — document it
     on the tranche and in the README; it is not a bug.
   - (d) Morpho sleeves move to the **WETH-loan / NVDA-collateral** market (§2.12).
   - (e) Every `usdc` name is now a lie → **rename to `quote`** (§2.11).
   - The USDG/NVDA design is not deleted: assets stay a constructor pair, so a second USDG book
     (`ChainlinkSessionOracle`, `STATIC_FEE_*`) remains deployable.
8. **Fee tiers are init-time parameters, immutable.** `PoolKey.fee` is fixed when each pool is
   initialized (env-driven, same `tickSpacing` for both), then never changes (v4-native static fee).
   The defaults below (LOW 3000 / HIGH 10000) are starting points, not constants.
9. **Oracle: `RatioSessionOracle` (new).** The hook expects **mid = equity price in quote, scaled
   1e18** (`IPoolGuardSimulator.mid1e18`; the hook scales the oracle value by `10**(18 - oracleDecimals)`).
   With a WETH quote that means **mid = WETH per NVDA = NVDA/USD ÷ ETH/USD** (NOT the reciprocal —
   `NVDA per WETH` would invert the book). Both legs are Chainlink on RH (NVDA `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15`,
   ETH `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9`), both 8 dec, both already include ERC-8056
   adjustments. Scale each leg to 18 dec (`usd18 = answer * 10**(18 - feedDecimals)`), then
   `mid18 = nvdaUsd18 * 1e18 / ethUsd18`; report `decimals() = 18`. Invalid if either leg is
   stale/invalid or the denominator ≤ 0 (fail-closed: wrap/unwrap block, swap EV degrades to
   pull-thin). The pushed session/status layer (`ISessionStatus`) is unchanged — it carries
   "market open" for the 24/5 equity leg, so with an ETH-quote book the oracle is invalid whenever
   the equity market is closed (same behavior as the USDG book; do not "fix"). Keep
   `ChainlinkSessionOracle` for the USDG book/tests. Staleness per feed uses the directory heartbeat.
10. **Share-math re-derivation for an 18-dec quote.** `SHARE_SCALE=1e6`, `VS=1e3`, `VA=1` were tuned
    for 6-dec USDG and are wrong for WETH: 1 wei of `VIRTUAL_ASSETS` is dust, and the per-share rate
    feeding `TrancheVault`'s 1e18 scaling no longer keeps sub-cent precision. Re-derive so that
    (i) shares-per-dollar stays in a sane range, (ii) the tranche per-share rate stays precise,
    (iii) the virtual-offset inflation protection is real at 18-dec. Deliverable: new constants +
    an **inflation-attack test** + a **mandatory nonzero bootstrap wrap at deploy** (already done by
    the deploy script — keep it and make it explicit; document the pre-mine invariant).
11. **Rename `usdc` → `quote`.** Mechanical sweep: `IHookSharePipe.wrapUSDC/unwrapUSDC` →
    `wrapQuote/unwrapQuote`, `LedgerVault` (`usdc` immutable, `usdcPerShare1e18` →
    `quotePerShare1e18`), tranches/accountant, `LedgerEntry7575` comments, mocks (`MockHookShare`),
    all tests + invariants. `wrapEquity/unwrapEquity` names stay. Do this in P0 so later phases read
    cleanly.
12. **Morpho sleeves use the WETH/NVDA market** (id `0x141c2b1d…7952`, oracle `0x63c3ab00…7829`,
    irm `0x2BD3d596…fa1`, lltv 38.5 % — all cross-checked on-chain 2026-10-11). Lend sleeve supplies
    WETH (≈0 utilization today → ≈0 yield but redemption-safe parking); loop sleeve borrows WETH
    against NVDA at ≤60 % of LLTV. Book is thin (0.48 WETH supplied) — fine as parking and
    withdrawals are unconstrained at 0 borrows, but re-check depth before sizing up.
13. **`rebalanceSwap` fate + policy params** stay open (§7) and do not block P1.

## 3. File-level work

**New: `src/hook/DualBookHub.sol`** (~5–6 KB budget)
- State: `PoolGuardHook[2] books`, `PoolKey[2] keys` (immutable), `uint8 activeBook`, policy
  (`switchDwell`, `lastSwitchAt`, `switchFrozen` — no flip budget, decided 2026-10-11),
  Ownable2Step (owner = LedgerVault; keeper = controller, mirroring vault auth).
- Forwarders (active book): `setDeployEnabled`, `recenterGuard`, `deployGuard`, `rearm`,
  `recallToVault`, `withdrawInventory(quote,equity)` (route to whichever hook holds), `unwindClaims`,
  `poolInitialized`, `exited`, `guardPresent`, `basePosition`, `guardPosition`, `activePoolId`,
  `activeKey`, `initializeBook` (route by `key.hooks`), `setGuardParams` (active; per-book via id).
- Aggregated views: `quoteIdle()`, `equityIdle()`, `claims(address token)` (sum over both hooks'
  `poolManager.balanceOf`), `inventory()`.
- Both-books ops: `pullAll()` (both; used by halt/settlement), `pullInactiveAndActivate(uint8)`.
- Policy gate inside `pullInactiveAndActivate` + `setSwitchFrozen(bool)` (owner or sentinel role).

**New: `src/oracle/RatioSessionOracle.sol`** — implements the existing oracle interface with an
18-dec composite mid: reads two `AggregatorV3Interface` legs (NVDA/USD, ETH/USD), checks each leg's
`updatedAt` against `maxPriceAge` (and > 0 answer), divides to 18 dec, and layers the session/status
gate exactly as `ChainlinkSessionOracle` does (reuse `ISessionStatus`; mid invalid when the session
says the equity market is closed). Fail-closed on any missing/stale/invalid leg. Unit tests in §5.

**Edit (P0, before hub work): share math + rename** — `src/vaults/LedgerVault.sol`,
`src/interfaces/IHookSharePipe.sol`, `src/vaults/{TrancheVault,SeniorVault,JuniorVault,TrancheAccountant}.sol`,
`src/vaults/LedgerEntry7575.sol` (comments), mocks + all tests. Constants per §2.10, rename per §2.11.

**Edit: `src/vaults/LedgerVault.sol`** (must end ≤ 24,576 with ≥150 B margin — measure every step)
- Constructor: take `PoolGuardHook hub_` + `PoolKey[2]` (or hub exposes keys); `hook` = hub.
- Delete the 12 hook-admin proxies (moved to hub); controller calls hub.
- Add `switchBook(uint8 to) external onlyOwnerOrKeeper nonReentrant` (atomic sequence above).
- Swap balance reads to hub views (§2.3); `_venueKey` → `hub.activeKey()`.
- `_halt`/`_finalize`: `hook.pullAll()` now pulls both books via hub — free fix.
- Size levers if over (in order): (a) drop `wrapSharesExact`, entry absorbs ≤2-share dust
  (~-300 B); (b) drop `equityToQuote` if tests allow (~-60 B); (c) relocate `rebalanceSwap` +
  setters (~-700 B) to a keeper-called `Rebalancer` given a minimal vault-authorized swap path.
  Do NOT count on the optimizer (measured: runs=1 saves only ~73 B).

**Edit: `src/strategy/VaultStrategyController.sol`** — add hub address + passthroughs for the moved
guard ops + `switchBook` (keeper-bounded, one per `switchDwell`). Switch policy already lives
on the controller (dwell + freeze-as-wind-down, submitSwitchBook stages via recall); the hub
takes over the atomic fund-new-book leg.

**Edit: `src/adapters/`** — while renaming, no logic change; add a second, pre-configured adapter
instance for the WETH/NVDA Morpho market (§2.12) if a separate instance is cleaner than re-params.

**Edit: `agent/static.mjs`** — add `decideBookRouting({volumeLow, volumeHigh, dwell, deviation, frozen})`:
flip to HIGH when trailing volume > `highVolThreshold` (e.g. 24 h notional percentile) for
`confirmBuckets`; back to LOW below `lowVolThreshold` (hysteresis). Volume source: Graph `Swap`
events per pool, fallback `eth_getLogs`. CLI: `--routing`. Tests in `agent/test/`.

**New: `script/DeployDualBookStack.s.sol`** (based on `DeployStaticStack.s.sol`): deploy/verify
`RatioSessionOracle` (NVDA/USD + ETH/USD legs); mine TWO hooks (same flags/args pattern, distinct
salts); create hub; transfer both hooks to hub, hub to vault; initialize BOTH pools at the oracle
tick with `STATIC_FEE_LOW` / `STATIC_FEE_HIGH`; mandatory bootstrap wrap; fund/deploy the LOW book;
deploy `LedgerEntry7575` + `setShareVault`.

**Edit: `scripts/verify-robinhood.mjs`** — add on-chain checks for the ETH/USD feed (`description`,
`decimals`, fresh round) and the WETH/NVDA Morpho market (`keccak256(params) == id`, `market()`
exists). Keep the existing 21 checks green.

**Unchanged:** tranches/accountant logic, `PoolGuardHook`, `StrategyModule`, `HookShareToken`, fork
infra. `LedgerEntry7575` logic is unchanged (rename/re-comment only).

## 4. Safety review (what can go wrong → mitigation)

| Risk | Mitigation |
|---|---|
| Migration window leaves capital idle / half-moved | single-tx `switchBook`; inactive book always empty (policy); events |
| Volume signal gamed to churn switches (fees accrue to LP; churn costs gas only) | `switchDwell` + `switchFrozen`; switching is keeper-only; agent requires a clear, persistent volume winner before proposing |
| New pool price dislocated at switch (thin book) | guard deploys centered at book's own tick (existing `_guardBounds(currentTick)`); agent optionally arb-seeds; both pools pre-initialized |
| Oracle invalid / market closed mid-switch | `switchBook` requires oracle-valid + `!expired()` (reuse vault checks) |
| Composite oracle leg stale/wrong (WETH quote) | per-leg staleness + fail-closed invalid → wrap/unwrap block, EV falls back to pull-thin; only external inputs are two Chainlink feeds |
| 18-dec share math mis-scaled / inflation attack | §2.10 re-derivation + inflation test + mandatory bootstrap wrap (pre-mine invariant) |
| Senior tranche now WETH-denominated (USD value floats) | accepted product decision (§2.7c); documented on tranche + README; not a correctness bug |
| Thin WETH lend market (0.48 WETH supplied) | parking only; 0-utilization withdrawals unconstrained; re-check depth before sizing up |
| Expiry hit while on book H | `_halt` pulls BOTH books (hub `pullAll`); settlement unchanged |
| Vault EIP-170 regression | hard gate after every phase: `forge build --sizes`, ≥150 B margin, levers §3 |
| Hub becomes a custody honeypot | hub holds tokens only transiently inside `switchBook`/`fundHook` forwarding; sweeps go straight to the vault (`hook.vault` = vault); no persistent balances |
| Strategy losses while steered | unchanged module: caps, timelock, redemption-safe-only pulls, loop excluded from redemption, `exitAll` at settlement |

## 5. Test plan (acceptance)

Unit (`test/unit/DualBook.t.sol` + `test/unit/RatioSessionOracle.t.sol` + edits):
1. Both pools live; vault NAV = sum of both hooks' idle + claims + active positions (inactive = 0).
2. `switchBook` atomicity: balances before == after modulo deployment; active pointer flips;
   inactive `guardPresent == false`, `exited` only on halt.
3. Policy: switch inside `switchDwell` reverts; `switchFrozen` reverts; expired/oracle-invalid
   reverts. Frozen additionally blocks all controller risk-up (allocate/borrow/fund/swap) —
   exits only.
4. Redemption ladder after switch (idle → new hook → venue → strategy → guard recall).
5. `haltIfExpired` pulls both books; settlement waterfall unchanged; 7575 entry round-trip
   unchanged (regression from `ERC7575Entry.t.sol`).
6. Ratio oracle: both legs valid → expected 18-dec mid; either leg stale → invalid; denominator
   ≤0 → invalid; session closed → invalid; decimals/scaling correct.
7. Share math: 18-dec granularity, tranche per-share precision, **inflation-attack test**,
   bootstrap-wrap invariant.
8. Full existing suite stays green (201 tests) — vault edits must not change pipe semantics.

Fork (`test/fork/RobinhoodFork.t.sol`): create WETH/NVDA pools on live 4663 (no such v4 pool exists
yet), seed LOW, `switchBook(H)` with a sim swap in between, assert guard redeployed on H and L empty;
plus a Morpho WETH/NVDA market supply→withdraw round-trip.

Agent: `decideBookRouting` tests (thresholds, hysteresis, dwell, frozen).

## 6. Phases (each ends: build + size gate + full tests + fmt clean)

- **P0 Hygiene:** rename `usdc`→`quote` (§2.11, DONE 2026-10-12) + re-derive share math for 18-dec (§2.10, DONE 2026-10-12: virtual-asset offset scales with the quote, `virtualAssets() = 10**(quoteDecimals-6)` — 1 unit on 6-dec (old behavior exact), 1e12 wei on 18-dec; genesis 1 quote unit = 1e15 shares on any book; dust < ~1000 base units reverts; donation attack proven unprofitable by round-trip test `ShareMath18.t.sol`; deploy pre-mines 0.1 quote units via `STATIC_BOOTSTRAP`).
  Gate: suite green, inflation test added.
- **P1 Hub skeleton:** `DualBookHub` forwarders + aggregated views + ownership wiring; vault edits
  §2.3 only (views). Gate: vault ≤ 24,576, suite green.
- **P2 Slim + switch:** move admin proxies to hub, controller rewire, `switchBook` + policy.
  Gate: vault margin ≥150 B (apply levers as needed).
- **P3 Oracle + deploy + agent:** `RatioSessionOracle`, `DeployDualBookStack.s.sol` (env fees,
  WETH quote), `agent/static.mjs --routing`. Gate: verifier additions pass on live chain.
- **P4 Tests:** dual-book unit suite, fork dual-book rehearsal (WETH/NVDA pools + WETH market), agent.
- **P5 Docs:** update `README.md`, `STATIC_FEE_PLAN.md` (status), this file → implemented.

## 7. Open decisions (answer before/within phases)

1. ~~Asset pair / WETH role~~ — **DECIDED 2026-10-11: quote = WETH, equity = NVDA** (§2.7).
2. ~~Fee tiers~~ — **DECIDED: init-time env params, immutable after pool creation**; defaults
   LOW 3000 / HIGH 10000, same tickSpacing (§2.8).
3. Policy params: `switchDwell` (1 h, on controller, tunable) + volume thresholds + lookback —
   P3. Flip budget dropped 2026-10-11 (no prior art; dwell does the job).
4. ~~`rebalanceSwap` fate~~ — **DECIDED+DONE 2026-10-11: swap lives in the controller**
   (bottom layer), vault keeps a keeper-only pull door. Freeze (`switchFrozen`) is terminal
   wind-down mode: blocks ALL controller risk-up, exits only — set for final withdrawal,
   never unset; pause stays the reversible incident halt.
5. **Permanent freeze after expiry — DEFERRED (noted 2026-10-11, do after vault slimming).** Agreed direction, careful version for volatile WETH/NVDA: (a) 3 steps — soft stop before expiry (no new money in), hard stop at expiry (no more book moves, only pull-to-idle + claims), locked-forever flag anyone can press after expiry (no admin changes ever again, withdrawals still work); (b) lock itself must need no swaps to succeed (just flips a flag, else it can fail when market thin/closed); (c) de-risk after lock still allowed but only safe-direction (pull to idle, repay loans, halt — nothing adding risk); (d) never force-sell volatile assets to freeze — frozen end state may be a basket (WETH + NVDA + loan receipts), users claim basket; (e) if price feed says closed/stale, block swaps, allow only pulls; every swap has a max-loss limit or it cancels.

## 7.1 Rename: RegimeVault (7575) -> LedgerVault (DECIDED 2026-10-11, DONE 2026-10-12)

The middle box is pure counting, fee split, expiry switch, pull-up + payout, and on/off
for the bottom mover. `Regime` does not say that, so it became **LedgerVault**
(`src/vaults/LedgerVault.sol`) + **LedgerEntry7575** (`src/vaults/LedgerEntry7575.sol`),
plus the `usdc`→`quote` identifier sweep (quote = WETH). No logic change in the rename,
only names + comments + deploy script env (`QUOTE_ADDRESS`).

Size calc (measured `forge build --sizes` 2026-10-11):
- Now: `LedgerVault` (ex-Regime) 24,509 / 24,576, only 67 free. `LedgerEntry` 8,487.
  `StrategyModule` 11,072. `TrancheAccountant` 6,014. Hook 21,521.
- Slim cuts (in order): 12 pool remote buttons move to hub ~-800 -> 23,709;
  drop exact-share mint ~-300 -> 23,409; drop tiny price view ~-60 -> 23,349;
  move swap + settings out ~-700 -> ~22,649 (free ~1,927).
- Add back: `switchBook` ~+350 + summed views ~+200 -> ~23,199, free ~1,377.
  Gate is 150+ free, so passes with room. Hub is new contract (~5-6k budget).
  Rule: measure after every step, never cut safety checks to fit.

## 7.2 Tranche comparison (beyond Morpho — Pendle, Goldfinch, Centrifuge, Idle, Saffron/BarnBridge)

- Pendle (PT/YT, you meant by "endle"): splits one earning asset into safe part (PT =
  get principal back at end date) + play part (YT = get all earnings till end date).
  PT + YT always equals the whole. Good: fixed end date, anyone can leave early by
  selling, no forced selling at end (PT just claims). Copy: our senior = PT-like
  (paid first, fixed), junior = YT-like (gets extra + takes loss first). Unlike Pendle
  we also run live shops (Hook A/B) + lending, not just splitting.
- Goldfinch TranchedPool: junior first-loss from real backers, senior auto-follows at a
  single mix number set by owners (FixedLeverageRatio). Pays senior first, then junior.
  Copy: one mix number + band instead of curve math — easier to check.
- Centrifuge (DROP/TIN, hub-and-spoke): one counting hub + many selling doors (spokes).
  1-5 floors, senior gets fixed, junior takes loss first, epochs batch leaves by rank
  (senior leaves first). Copy: hub counts, doors sell; senior-leaves-first; min junior
  buffer that blocks new senior money if guard gets too thin.
- Idle Perpetual Yield Tranches: senior protected (smaller but safe pay), junior boosted
  (bigger but takes loss). Auto-moves between lending places. Closest to our Morpho side.
- Saffron / BarnBridge SMART Yield: fixed-pay floors + risk floors, pay in turns.
  Lesson: pay-turns must be simple or gas eats it — keep our pay-out to one trip.

Verdict: our shape (2x 7540 up top, 1x Ledger 7575 middle counting + paying, bottom mover
across A/B + 2 Morpho pools) = Goldfinch pay-order + Centrifuge hub/doors + Pendle end
date + Idle auto-move. Rating stays 8/10; to 9 do the slim above + waiting time + loss
limit + fresh-price check on every move.

## 7.3 Morpho market rotation + controller wiring runbook (LOCKED 2026-10-11)

- Wiring (deploy or post-deploy, owner): module `setVault` → `setAllocator(controller)` →
  `setSentinel(controller)` → vault `setStrategyModule(module)` (allowance) → controller
  `setStrategyModule(module)` → controller `setBooks(hookA, hookB)` once book B exists.
  `DeployStaticStack` does the module half when `STRATEGY_MODULE_ADDRESS` is set (module
  must be deployer-owned). Adapter lifecycle stays owner-direct on the module.
- Rotate a market (owner + agent): agent `submitDeallocate` everything out of the old
  adapter → confirm `adapterExposure == 0` → owner `lowerCaps` to 0 → owner/sentinel
  `disableAdapter` → owner `submitAdapter` (new market, timelocked) → wait timelock →
  `executeAdapter` → agent `submitAllocate` within caps. Never disable before empty.
- De-risk ladder (anyone holding agent key, works paused): `submitDeployEnabled(false)` →
  `submitRecall` (hook) → `submitDeallocate` / `submitRepay` / `submitDeleverage` (Morpho)
  → `submitDisableAdapter` / `submitLowerCaps` (sentinel). Risk-up (`submitAllocate`,
  `submitAllocateCollateral`, `submitBorrow`, `submitFund`, `submitSwitchBook`) is blocked
  while paused.
- NVDA side stays loop-only (no second plain-lending module) until a real NVDA-loan market
  exists; the vault tracks one module for NAV/withdrawals — a second module would hold
  funds the vault cannot see.
- D2+Q1 DONE 2026-10-12: middle wraps sr/jr-registered callers only (entry deposits revert
  `NotTranche`; exits stay open); owner acts on money paths only until a keeper is set,
  keeper-only after (recovery = replace keeper). Vault 23,406 B (1,170 free).
- Tranching economics LOCKED 2026-10-12 (no time-accrual machinery — killed as unnecessary):
  senior mid-life exits pay min(pro-rata NAV, principal slice), never upside; junior exits
  pay min(pro-rata NAV, residual slice), uncapped upside, first loss. `seniorClaim()` is
  principal-only mid-life net of already-locked value (no double-dip across fills);
  settlement guarantee stays flat (full promise at expiry). Principal tracks PAID value
  (reduced at claim, not request). Exit schedule one-shot at deploy: 0.2% redemption fee
  + 0.3% early-exit fine decaying linearly to zero at expiry, pool-kept; settlement/matured
  claims fee-free. Day-1 senior exit ≈ deposit (zero profit). Vault 24,387 B (189 free —
  nothing left planned touches it).
- Phase 6 DONE 2026-10-12: `RatioSessionOracle` (NVDA/USD ÷ ETH/USD → WETH-per-NVDA at
  1e18, per-leg staleness, equity-session gating, fail-closed zero denominator, mixed-decimal
  legs). 2,943 B. Verified legs in `deployments/robinhood-mainnet.json`.
- Phase 5 DONE 2026-10-12: controller risk-knob timelock queue (typed propose →
  24h → permissionless execute, owner/guardian cancel; Bounds/Targets/caps/dwell/venue/
  slippage have NO instant path — emergencies use module disable/lowerCaps, pause, freeze,
  recall). Promise rate one-shot (escrow settable only pre-first-deposit). Exit fees wired
  at deploy (20/30bps defaults). Loop fixed ratio VERIFIED in adapter (borrow capped at
  60%-of-LLTV, withdrawals health-gated at 1.2 — no controller change needed). Controller
  16,922 B. Test books run 30-day expiries so the 24h queue fits before maturity.
- Epoch engine DONE 2026-10-12 (`TrancheAccountant.executeEpoch/claimEpoch`, permissionless):
  24h unix-aligned boundaries, seniority order, equal-ratio (junior % ≤ senior %), 25%
  junior floor from hook-share integer math (oracle-free; lifted when frozen), leftovers
  auto-roll, senior deposit floor-gate (genesis must be junior-led; senior ≤ 75% of book
  always — a 25% floor forbids Goldfinch-style 4:1 structures by design). Deposits stay
  instant; underfunding-at-entry structurally impossible (floor 25% >> escrow 5%), so the
  haircut path needs real losses (drilled via swap-then-crash). Mocks enforce no floor
  policy (real-contract behavior covered with the real accountant).
- Phase 7 DONE 2026-10-12 (dual-book hub + atomic migration, as built):
  `src/hook/DualBookHub.sol` (8.8k B) owns both books and implements `IBookHook` by
  forwarding to the active book + aggregating idle/claims. Vault, entry and readiness
  work through it unchanged. `submitSwitchBook` migrates atomically (recall → pull old →
  fund full vault balances → `pushToActive` → `activateAndDeploy`) and reverts as a no-op
  when the new book has no params staged. Round-trips re-arm the pulled book; halt stays
  idempotent (already-exited books skipped). As-built corrections vs the sketch: (a) hub
  needs `setVault` (owner, once, before handover — the vault cannot be a ctor arg since it
  takes the hub as its hook; sweeps revert while unset so funds can never burn to zero);
  (b) book sweeps land at the hub (their recorded vault) so every mutating path ends with
  a hub→vault sweep — hub holds nothing between txs; (c) init routing is by the key's hook
  address (both books share the pair, currency matching cannot tell them apart);
  (d) `activateAndDeploy` re-arms exited books / deploys fresh ones — plain `deployGuard`
  stays a strict forward; (e) books initialize ARMED (init deploys base+guard strictly, so
  both need inventory: A via vault funding, B via direct staging — deploy script +
  `DualBook.t.sol` do exactly this). Guard params route to the ACTIVE book only, so stage
  each book's params pre-handover. Sizes: hub 8,806, controller 17,791, vault unchanged
  24,244. Tests: `test/unit/DualBook.t.sol` 7/7 (atomic migrate, round-trip rearm, dwell/
  same-book guards, recall sweep, halt idempotent, active routing, view aggregation).
  Deploy: `script/DeployDualBookStack.s.sol` (factory-mined second hook, `STATIC_FEE_A/B`,
  `STATIC_B_*` params, `STATIC_INIT_BOOKS` + four `STATIC_FUND_*` with script approval).
  Agent: `decideBookRouting` advisory (revenue = volume × fee, 5% hysteresis; dwell/freeze/
  expiry still enforced onchain) + `--route` CLI + 2 node tests.
- Phase 8 DONE 2026-10-12 (verification): local suite 250 pass / 1 pre-existing skip;
  fork rehearsal 5/5 on live Robinhood Chain via `rpc-proxy` (live addresses + market-id
  match, session oracle, fair/toxic swaps on the canonical manager with real USDG/NVDA,
  real Morpho supply + withdraw, tranche deposits with D2-closed entry + junior-led floor
  gate). Two stale fork setups fixed along the way (keeper-exclusive D2+Q1: rehearsal now
  drives keeper paths itself; entry test rewritten for the D2/tranche world — no product
  change). Slither rerun on the hub: one real fix (pointer flip before the from-book pull,
  checks-effects-interactions); remaining findings are lib noise or intentional
  (zero keeper = legitimate owner-only mode, `^` pragma repo-wide). Agent suite 15/15.
  Live-wiring note: `DeployDualBookStack` compiles under `forge build`; `STATIC_INIT_BOOKS`
  path needs script approval for all four `STATIC_FUND_*` before broadcast.

## 8. Handoff notes for the implementing agent

- Repo: `C:\Users\klaad\nvda-tranched-arc`, branch `static-fee`. Build: `forge build --sizes`;
  tests: `forge test` (201) + proxy-based fork (see README "Fork rehearsal") + `npm run test:agent`.
- `forge fmt` must stay clean; `foundry.toml` already via_ir/200 runs (optimizer is NOT a size
  lever — measured).
- Chain facts: `deployments/robinhood-mainnet.json` (verified addresses; RH Morpho has no `id()`;
  ids = `keccak256(abi.encode(params))`). Key WETH-book addresses:
  quote WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` · equity NVDA `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` ·
  NVDA/USD feed `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15` · ETH/USD feed
  `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9` · WETH/NVDA market `0x141c2b1d…7952`.
  Resolve feed heartbeats from `https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json`.
- Public RPC needs browser headers (`scripts/rpc-proxy.mjs`). PowerShell 5.1 pitfalls:
  `Set-Content -Encoding UTF8` adds BOMs (strip before JSON parse); write temp scripts with the file
  tool, not heredocs; quote-heavy `node -e` breaks — use temp `.mjs`.
- Commit only when the owner asks. Vault/hook got a slither pass
  (`slither-static.summary.txt`) — rerun on the hub + oracle when built.
