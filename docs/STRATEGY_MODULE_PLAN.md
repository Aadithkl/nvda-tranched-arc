# Strategy Module + Robinhood Migration — Plan of Record

Status: **implemented on `static-fee`** (contracts + oracle + configs; deploy pending) · References:
Veda **Boring Vault** (Teller/Accountant/ManagerWithMerkleVerification) and **Morpho Vault V2**
(adapters, absolute/relative caps, Curator/Allocator/Sentinel roles, timelocks)

## Decisions (locked)

1. **Single-chain strategy** on **Robinhood Chain** (4663) — the static book is Robinhood-Chain-only.
2. **Fixed-function adapters** (allocate/deallocate/realAssets; only the module may call them) —
   deliberately stricter than Boring's merkle-whitelisted arbitrary calls.
3. **Morpho Blue (Robinhood, era-2 `0x9D53…1010`) is the primary lend venue**; loop sleeve =
   whitelisted Morpho markets (multi-venue by market id), USDG loan asset.
4. **Curator / Allocator / Sentinel** with a **timelock on risk increases** (enable adapter,
   raise caps ≈ 24 h); decreases/deallocations are instant.
5. **Onchain NAV** via adapters' `realAssets()` aggregation (losses socialize through share price).
6. Oracle = **Chainlink stock-feed mid** (includes the ERC-8056 multiplier) **+ pushed session/status**
   layer (keeper session/status pusher). Quote stable = **USDG**. Path: **4663 fork → 46630 testnet →
   4663 mainnet** (small caps first).

## Market-open guard (why sessions matter)

Stock tokens only price reliably while the underlying equity trades (regular/extended/overnight).
Outside those windows takers could trade against a stale feed — adverse selection the IL guard
cannot price. Three layers:
1. `ChainlinkSessionOracle.getPrice()` returns `valid=false` when the feed is stale OR the session is
   `None`; mid comes from Chainlink, status/session from the pushed layer.
2. `PoolGuardHook.beforeSwap` reverts `SessionNotAllowed` when the session bit is not in
   `GuardParams.allowedSessionsMask` (persistent, quoter-readable) and `OracleStale`/`OracleInvalid`
   otherwise.
3. Strategy layer: closed session → agent runs `parkPlan()` (standby + recall + lend); open session →
   `resumePlan()` (withdraw + fund + enable + recenter). `agent/static.mjs` exposes
   `decideStrategy()` / `sessionStandbyPlan()`.

## Components (as built)

| File | Role |
|---|---|
| `src/adapters/IStrategyAdapter.sol` | Fixed-function adapter interface (authority/asset/realAssets/maxWithdrawable/deposit/withdraw/exit) |
| `src/adapters/StrategyModule.sol` | Registry + caps + timelock + allocator/sentinel roles; holds no assets at rest; `totalAssets()` NAV aggregation; `pullToVault` (redemption-safe only); `exitAll` (settlement) |
| `src/adapters/MorphoBlueLendAdapter.sol` | Direct Morpho Blue `supply` (permissionless; Vault V2s gate deposits), share-conversion accounting |
| `src/adapters/ERC4626Adapter.sol` | Generic ERC-4626 venue (cap-aware via `maxWithdraw`) |
| `src/adapters/MorphoLoopAdapter.sol` | Junior sleeve: stock collateral → borrow USDG within a conservative fraction of LLTV; `healthFactor()`; `deleverage()`; NOT redemption-safe; NAV = collateral value − debt (floored) |
| `src/adapters/IMorpho.sol` | Minimal Morpho Blue + oracle interfaces |
| `src/oracle/ChainlinkSessionOracle.sol` | Composite oracle (Chainlink mid + session layer) implementing the hook's price-data shape |
| `src/vaults/RegimeVault.sol` | Adds `setStrategyModule` (standing allowances), `baseManagedAssets()` + strategy-aware `totalManagedAssets()`, redemption routing (`_ensureUsdc` → module), settlement `exitAll` |

## Roles

| Role | Holder | Can | Cannot |
|---|---|---|---|
| Curator | module owner (multisig) | submit adapter enablement / cap increases (timelocked), disable, lower caps, cancel pending, set roles/timelock | exceed hard maxima |
| Allocator | agent key (can be the vault keeper/controller) | allocate/deallocate, loop collateral/borrow/repay, funding via vault allowance | enable adapters, raise caps, touch the guard beyond controller bounds |
| Sentinel | de-risk key | instant: disable adapter, lower caps, cancel pending, deallocate, repay/deleverage | increase exposure |
| Vault owner/keeper | multisig / controller | guard params, recenters, hook deploy enable, venue, settlement | bypass module caps |

## Risk controls

- Per-adapter **absolute cap** and **relative cap (bps of base + strategy NAV)** — checked on
  allocation only (exits can exceed caps, Morpho-style).
- Loop sleeve: **target LTV ≤ 60% of market LLTV**, `minHealthFactor` floor on collateral
  withdrawals, per-market whitelist via adapter config.
- Withdrawal routing: idle → hook → venue → **redemption-safe adapters only** (loop sleeve excluded);
  settlement `exitAll` unwinds everything (funding loop debt from vault proceeds).
- Timelock default 24 h (`setTimelock`, max 7 days); Sentinel de-risks without delay.

## Robinhood facts used

- Mainnet 4663 / testnet 46630 (ETH gas); canonical v4: PoolManager `0x8366…951`, PositionManager
  `0x58da…fa7`, Quoter `0x8dc1…f94`, StateView `0xf333…73b`, UR 2.1.1 `0x8876…904`, Permit2 canonical.
- No Uniswap on testnet 46630 → self-deploy vendored v4 there; Morpho mainnet-only → loop rehearsed
  on a 4663 fork.
- Morpho era-2 Blue `0x9D53…1010`; USDG `0x5fc5…d168`; WETH `0x0Bd7…d73`.

## Verification checklist (before any mainnet tx)

- [x] NVDA stock token `0xd060…9EEC` (18 dec, ERC-8056 `uiMultiplier()` = 1.00077…) + Chainlink feed
      `0x379E…9F15` "RHNVDA / USD" (8 dec) — verified on-chain 2026-10-09 (`npm run robinhood:verify`)
- [x] USDG `0x5fc5…d168` decimals on-chain: 6
- [x] Morpho market params for the primary NVDA/USDG market: oracle `0x37CF…0bE0`, irm `0x2BD3…0fa1`,
      LLTV 62.5%; id `0xf5ff…6e4c` matches keccak(abi.encode(params)). NOTE: the RH Morpho variant has
      **no `id()` view** (`idToMarketParams` only) — adapters compute the canonical id locally.
      Deepest market `0x8b16…9c3e` is ~100% utilized — do not park there (withdraw risk).
- [ ] Canonical v4 PoolManager ABI/flags vs pinned `v4-core` submodule (hook mining gate)
- [ ] Hook mined address: non-`0x91`, flags `BEFORE_INITIALIZE|BEFORE_SWAP`, delta bits clear
- [ ] Blockscout verification config for 4663

## Status vs phases

- P2a adapters + module + NAV/routing: **done** (tests: `StrategyModule.t.sol`)
- P2b risk/caps/roles/timelock + agent decisions + **expiry lifecycle** (slow halt, settlement
  readiness, post-settlement request→fulfill→claim, guard-recall funding): **done**
  (tests: `VaultStrategy.t.sol`, `ExpiryWithdrawals.t.sol`)
- P2c loop sleeve + HF/deleverage: **done** (Morpho mocks); lending sleeve rehearsed on a live 4663
  fork (`test/fork/RobinhoodFork.t.sol`: real Morpho supply/withdraw)
- P2d Robinhood records (`deployments/robinhood-{mainnet,testnet}.json`), foundry/env config: **done**;
  fork rehearsal: **done** (4/4 pass via `scripts/rpc-proxy.mjs`); testnet/mainnet deploy: **pending**
