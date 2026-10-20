# NVDA Tranched Platform — Static-Fee Book (Robinhood Chain)

Stablecoin-native RWA capital structuring for **NVDA stock tokens on Robinhood Chain (4663)**: a
static-fee Uniswap v4 pool guarded by an onchain IL guard, tranche Senior/Junior vaults on top, and
a bounded strategy module (Morpho lending + a levered junior sleeve) — all with onchain risk limits.

**Version model:** this branch (`main`) is the static-fee book. The dynamic-fee v3 book
(`TrancheJITHook`) is preserved on `jit` — nothing is removed from GitHub.

## Architecture

```
depositors → Senior/Junior tranche vaults (ERC-7540) → TrancheAccountant (waterfall, expiry)
                                  │
                            LedgerVault  (share issuer, NAV, pipe, settlement, capital allocator;
                                  │        owns the hook)
              ┌───────────────────┼────────────────────────────┐
              ▼                   ▼                            ▼
      PoolGuardHook        StrategyModule              lending venue / Morpho
      (static fee,         (fixed-function adapters:    (idle USDC rest;
       base+guard bands,    MorphoBlueLend, ERC4626,     RH testnet: in-repo
       per-swap IL guard)   MorphoLoop junior sleeve)    Aave semi-fork)
              │
      PoolGuardSimulator (SwapMath EV walk)  ·  ChainlinkSessionOracle (mid + sessions)
```

- **PoolGuardHook** — open pool (public LP welcome); holds a wide *base* band (discovery anchor)
  and a moving *guard* band; `beforeSwap` simulates the swap with SwapMath and pulls the guard when
  the oracle edge turns negative (the swap then prices against base only — never a revert). Pulled
  guards re-arm on the next EV+ swap or via the permissionless time-based `recheckGuard()`;
  oracle-stale/invalid and disallowed sessions revert (market-open guard).
- **LedgerVault** — combined vault: vault-native ERC-20 share (`HookShareToken`, ERC-7575
  share-to-vault lookup), NAV (hook positions + venues + strategy adapters), wrap/unwrap pipe,
  expiry settlement waterfall, and the allocator surface. The standard surface is a stateless
  **`LedgerEntry7575`** ERC-7575 entry point (ERC-4626 minus ERC-20) piping through the vault.
- **StrategyModule** — Curator/Allocator/Sentinel roles, absolute + relative caps checked on
  allocation, timelocked risk increases, instant de-risking; adapters are fixed-function
  (`MorphoBlueLendAdapter`, `ERC4626Adapter`, `MorphoLoopAdapter` — junior sleeve only, excluded
  from the redemption path).
- **Oracle** — `ChainlinkSessionOracle`: Chainlink stock-feed mid (already includes the ERC-8056
  corporate-action multiplier) + a keeper-pushed session/status layer.

## Lifecycle

Deposits → guarded book runs (per-swap IL guard, market-open sessions, strategy sleeves) →
**soft halt at T−Δ** (deployments off) → **`haltIfExpired()` at T** (base + guard pulled back to the
vault; the hook can never redeploy) → `finalizeSettlement()` freezes the terminal rates →
users exit by pulling withdraw requests on the senior/junior vaults (`fulfillRedeemMatured` →
`claimMatured`, or `redeemAtExpiry` for held shares). Redemptions while live draw from idle →
hook idle → venue → strategy adapters → **guard recall** as the last resort.

## Docs

- [`docs/STATIC_FEE.md`](docs/STATIC_FEE.md) — design freeze (hook, gating, discovery rules)
- [`docs/DUAL_BOOK_PLAN.md`](docs/DUAL_BOOK_PLAN.md) — dual low/high-fee static hooks with
  volume-steered liquidity switching + multi-strategy (implementation handoff plan)
- [`docs/STRATEGY_MODULE_PLAN.md`](docs/STRATEGY_MODULE_PLAN.md) — strategy module + Robinhood
  migration plan of record (roles, caps, market-open guard, verification checklist)
- [`docs/STATIC_FEE_PLAN.md`](docs/STATIC_FEE_PLAN.md) — build plan / version model
- [`docs/ACCOUNTANT.md`](docs/ACCOUNTANT.md) — tranche claims, waterfalls, settlement
- [`docs/LENDING.md`](docs/LENDING.md) — in-repo Aave V2 semi-fork (testnet venue / adapter)
- [`slither-static.summary.txt`](slither-static.summary.txt) — security scan of the static book

## Quickstart

```shell
forge build && forge test            # 265 tests: hook, vault, strategy, tranches, oracle, E2E
forge fmt --check
npm install && npm run test:agent    # offchain agent decisions (node:test)
npm run agent:static -- --help       # recheck/recenter + strategy park/resume decisions
npm run robinhood:verify             # live 4663 check: addresses, decimals, feed, Morpho market
```

### Fork rehearsal (live 4663)

The fork suite deploys the static book on the canonical PoolManager with real USDG/NVDA and
exercises the Morpho sleeve on the real market. The public RPC sits behind a Cloudflare challenge,
so foundry forks through the bundled header-injecting proxy:

```shell
npm run robinhood:proxy              # terminal 1 (leave running)
# terminal 2:
$env:ROBINHOOD_RPC_URL = "http://127.0.0.1:8546"
forge test --match-path test/fork/RobinhoodFork.t.sol -vv
```

Or set `ROBINHOOD_RPC_URL` to a provider RPC and skip the proxy. Without it the fork suite skips.

## Deploy (Robinhood Chain)

Records and addresses: [`deployments/robinhood-mainnet.json`](deployments/robinhood-mainnet.json)
(canonical v4, Morpho Blue, USDG) and `deployments/robinhood-testnet.json` (self-deployed v4).
Path: 4663 fork rehearsal → 46630 testnet → 4663 mainnet (small caps). The resolve-and-verify items
(NVDA stock token, Chainlink feed, Morpho market params) are verified on-chain — see
`npm run robinhood:verify` and the `contracts.note` in the record. The RH Morpho variant exposes no
`id(MarketParams)`; ids are computed as `keccak256(abi.encode(params))` (canonical scheme).

```shell
# testnet only (no canonical v4 on 46630)
forge script script/DeployV4Stack.s.sol --rpc-url $ROBINHOOD_TESTNET_RPC_URL --broadcast
# hook (mined) + full stack
forge script script/DeployPoolGuardHook.s.sol --rpc-url $ROBINHOOD_RPC_URL --broadcast
forge script script/DeployStaticStack.s.sol   --rpc-url $ROBINHOOD_RPC_URL --broadcast
```

Config via `.env` (see [`.env.example`](.env.example)); dependencies and pins in
[`REQUIREMENTS.md`](REQUIREMENTS.md).

## License

MIT — see [`LICENSE`](LICENSE); third-party scope in [`LICENSES.md`](LICENSES.md).
