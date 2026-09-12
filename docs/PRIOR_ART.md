# Prior Art & Novelty

Audited before building `TrancheJITHook`. Principle: reuse MIT plumbing, ship our own mechanisms.

## Landscape

| Project | Rest / yield venue | JIT | Dynamic fee | Oracle-aware | Tranches / claims | Agent | License |
|---|---|---|---|---|---|---|---|
| OZ `ReHypothecationHook` | any yield source | single position | ❌ | ❌ | ❌ | ❌ | MIT |
| Uniswap `DualPoolHook` | ERC-4626 | multi-bucket + ERC-6909 | ❌ | ❌ | ❌ | ❌ | MIT |
| OZ `DynamicLPFeeHook` | — | ❌ | owner-set | ❌ | ❌ | ❌ | MIT |
| OZ `AntiSandwichHook` | — | ❌ | dynamic after-fee | ❌ | ❌ | ❌ | MIT |
| EulerSwap | Euler vaults | JIT borrow | custom curve | ❌ | ❌ | ❌ | custom |
| SymbioteHook / Reflux | Aave V3 | + leverage | ❌ | ❌ | ❌ | ❌ | none detected |

Nothing in the landscape combines **oracle-anchored pricing + tranche-claimed JIT + a bounded agent**.

## What we borrow (plumbing only)

- `OpenZeppelin/uniswap-hooks` @ `2ae32be` (MIT): `BaseHook` (permission flags, `onlyPoolManager`, `noSelfCall` semantics), fee-module patterns
- `Uniswap/v4-hooks-public` (MIT, not vendored): DualPool JIT lifecycle as a design reference
- v4 core: `LPFeeLibrary` (dynamic/override flags), `IPoolManager.updateDynamicLPFee`, `StateLibrary.getSlot0`

## What is ours

1. **M1 — Oracle-anchored toxic-flow pricing.** Fee = `base + premium(|deviation|)` for trades that move the pool price *toward* the oracle (adversely selected flow), rejected outright above `maxDeviationBps`. Deviation/direction computed onchain from `NVDAPriceOracle` + v4 slot0.
2. **M2 — Seniority-aware risk budget.** JIT deploy cap = `min(agent cap, juniorClaim)`; zero unless the accountant reports the senior escrow funded. Senior capital never funds JIT inventory.
3. **M5 — Params TTL state machine.** `ACTIVE → DEGRADED (size/4) → REST`; stale agent params stop quoting. The hook is safe with the agent offline and capital keeps earning in Aave.
4. **Bounded agent surface.** Separate `StrategyAgent` contract (operator key ≠ deployer), whitelisted on `StrategyController`; the hook accepts params only from the controller.

Planned: **M3** escrow-targeting fee floor, **M4** self-tuning EV buckets (onchain EMA of realized JIT PnL), **M6** onchain volatility estimator.

## License notes

- OZ `uniswap-hooks`: MIT — vendored as a submodule, pinned `2ae32be4906d300fc49b4384842ef6bc3e902d73`.
- `v4-hooks-public`: MIT (verified via GitHub API) — reference only.
- Upstream Aave V2 (`aave/protocol-v2`): NOASSERTION — we wrote our lending semi-fork independently (`docs/LENDING.md`).
