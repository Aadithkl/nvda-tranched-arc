# Tranche Agent (external AI / policy daemon)

Offchain control plane for `TrancheJITHook`. It **perceives** (oracle, pool price, hook params, risk
budget), **reasons** (volatility regime), and **acts** through the whitelisted `StrategyAgent` contract —
it can never mint/burn shares, move funds, or change roles.

```
oracle + hook + accountant ──► agent/index.mjs ──► StrategyAgent ──► StrategyController ──► hook params
      (RPC / The Graph)          regime policy        (whitelisted)      (hard bounds)
```

## Run modes

| Mode | Command |
|---|---|
| Local dry run | `node agent/index.mjs --once` |
| Local submit | `node agent/index.mjs --once --submit` |
| Local loop (default 600s) | `node agent/index.mjs --loop --interval 600 --submit` |
| GitHub Actions heartbeat | `.github/workflows/agent-heartbeat.yml` (cron every 10 min, `workflow_dispatch` for manual) |
| EigenCompute (later) | containerized daemon (`Dockerfile` to be added when key custody matters) |

## Regimes (policy)

| Regime | Condition | Base fee | Surge cap | Deviation band | TTL | Max deploy |
|---|---|---|---|---|---|---|
| calm | deviation ≤ 50 bps | 0.30% | 3% | 300 bps | 3600s | 1 USDC |
| elevated | ≤ 150 bps | 0.50% | 6% | 250 bps | 1800s | 0.5 USDC |
| turbulent | > 150 bps | 0.80% | 10% | 150 bps | 900s | 0.1 USDC |
| closed | oracle invalid / market closed | — | — | — | — | quoting **off** |
| unfunded | senior escrow not funded | — | — | — | — | quoting **off** |

The `StrategyController` enforces hard bounds on every submitted param, so a compromised or wrong agent
can only shrink/reshape activity within those limits.

## Environment

```
ARC_RPC_URL=
AGENT_HOOK=        # TrancheJITHook address
AGENT_MODULE=      # TranchePipeModule address (exits + rebalancing; falls back to AGENT_HOOK)
AGENT_ORACLE=      # price oracle address
AGENT_ADDRESS=     # StrategyAgent address (whitelisted on the controller)
AGENT_KEEPER=      # TrancheAccountant address (optional; for fulfillRedeem/rebalance)
AGENT_OPERATOR_PRIVATE_KEY=  # operator key ONLY (never the deployer key), local .env / GitHub secret
AGENT_CADENCE_SECONDS=600
PARAMS_TTL_SECONDS=3600
# x402 reasoning endpoint (optional; rules fallback is used when unset)
AGENT_REASONING_URL=
# Dual-token rebalancing (hard cap, no target ratio)
AGENT_REBALANCE_ENABLED=1
AGENT_REBALANCE_MIN_EDGE_BPS=0.2
AGENT_REBALANCE_MIN_USD=1
AGENT_REBALANCE_MAX_USD=500
AGENT_REBALANCE_SLIPPAGE_BPS=50
```

## Dual-token rebalancing

Each tick the daemon also reads `assetComposition()` (USDC/equity values + `equityBps` and the hook's
`hardMaxEquityBps`) and runs the portfolio policy in `agent/model.mjs`:

| Action | Condition | Result |
|---|---|---|
| sell equity | `equityBps > hardMaxEquityBps` | trims back to the cap (senior protection), independent of edge |
| buy equity | escrow funded + JIT LP edge > `AGENT_REBALANCE_MIN_EDGE_BPS` + headroom below the cap | builds inventory for JIT seeding, sized by `suggestedMaxDeployUsdc` |
| hold | otherwise | logs `il` (portfolio IL), `premium` (`w(1−w)σ²`), and the reason |

`sell` amounts are converted to equity units and both directions compute a `minOut` from the oracle with
`AGENT_REBALANCE_SLIPPAGE_BPS`; the hook rejects anything looser than its own oracle anchor, and the
controller enforces the per-call cap and cooldown. Trades execute on the configured external venue
(`setRebalanceVenue`), never against the hook's own JIT pool, and are skipped while the oracle is stale —
`unwrapProportional` remains the oracle-free exit.

## x402 reasoning (planned)

The policy function is pluggable: when `AGENT_REASONING_URL` is set the daemon will request a paid quote
(or richer volatility signal) through the x402/Circle Gateway rail already used by the oracle keeper, and
fall back to the deterministic regime table above otherwise. The onchain result is identical in shape —
bounded params submitted via `StrategyAgent`.

## GitHub Actions

`.github/workflows/agent-heartbeat.yml` runs every 10 minutes and on manual dispatch; configure the
secrets above in the repository settings. The protocol is safe if the agent stops: params expire and the
hook moves `ACTIVE → DEGRADED → REST`, with capital resting in Aave.

## Market model (Graph-only)

`agent/market.mjs` + `agent/model.mjs` compute, from The Graph gateway only:

- **volatility** per pool (3h trigger, 14d calibration, EWMA, annualized),
- **fees** (`effectiveFeeBps`, `feeApr`, `fee per hour per $`),
- **TVL** and **active/rewarded TVL** (in-range liquidity value and share),
- **range sweep**: fees vs impermanent loss per band, with the fee share diluted by rewarded TVL,
- a verdict with suggested `bucketTicks` / `maxDeployPerSwap` inside controller bounds.

```bash
npm run market        # live table
npm run market:json   # cache snapshot (read by the agent tick)
npm run test:agent    # offline math tests
```

Full definitions: `docs/AGENT_MARKET.md`. The agent tick reads `agent/.cache/market.json` and overlays
the verdict on the regime decision (`worthLp=false` disables quoting).
