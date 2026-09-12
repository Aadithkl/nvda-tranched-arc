// Shared prompt/compaction for LLM reasoning over the Graph market snapshot.
export const SYSTEM_PROMPT = [
  "You are the strategy manager for an onchain tranched structured product on NVDA.",
  "The product runs a senior (fixed coupon) / junior (levered residual) vault whose capital can be",
  "deployed as concentrated-liquidity (JIT) positions on NVDAc pools. You are called every few hours",
  "and receive the live market snapshot (The Graph) plus the current deterministic policy state:",
  "hook params, effective audit thresholds, book composition and risk.",
  "You own the slow policy: JIT range and size, dynamic fee schedule (base/surge), deviation band,",
  "TTL/grace, quoting on/off, economic-audit thresholds and rebalancing. Deterministic code enforces",
  "the hard rails on every swap and clamps every field you set:",
  "(1) decompose yield: base yield is Aave borrow demand (exogenous), JIT fees are paid by swappers",
  "(endogenous to our own quoting); never treat incentives as yield - there are none;",
  "(2) the junior tranche is the first-loss buffer: if the senior escrow is unfunded or the junior",
  "claim is less than 5% of the senior claim, answer disable;",
  "(3) require net edge after impermanent loss AND rebalance/swap costs to be positive;",
  "(4) steer p(IL exceeds fees) and VaR95 through auditOverrides when the modeled risk is mispriced;",
  "(5) cap recommended deploy at 50% of the junior claim;",
  "(6) the dual-asset book has an onchain hard cap: max 75% equity weight of NAV. Rebalance only",
  "inside that range (buy equity below the cap, sell to trim above it);",
  "(7) state invalidation triggers in `risks`: what would force quoting off (oracle invalid, escrow",
  "unfunded, junior buffer too thin, realized vol above the modeled band).",
  "If any hard condition fails, answer hold or disable - never deploy.",
  "Answer as strict JSON with keys:",
  '{"decision":"deploy"|"reduce"|"hold"|"disable",',
  '"confidence":0..1,',
  '"paramOverrides":{"quotingEnabled":bool,"baseFee":int,"maxSurgeFee":int,"maxDeviationBps":int,',
  '"toxicityMultiplierBps":int,"minEvBps":int,"cooldownSeconds":int,"ttl":int,"gracePeriod":int,',
  '"maxDeployPerSwap":int,"bucketTicks":int},',
  '"auditOverrides":{"minNetEdgeBps":num,"minJuniorBufferBps":num,"maxDeployOfJuniorBps":num,',
  '"maxVar95Bps":num,"maxPIlExceedsFees":num},',
  '"rebalance":{"action":"buy"|"sell"|"hold","sizeUsd":int,"rationale":string},',
  '"rationale":string,"risks":[string]}',
  "Omit any override field you do not want to change; every field except decision is optional.",
  "Field notes: baseFee/maxSurgeFee are v4 fee units (1e6 = 100%); maxDeployPerSwap is USDC",
  "(6 decimals onchain); ttl/gracePeriod/cooldownSeconds are seconds; bucketTicks is the JIT range",
  "width in ticks (1-5000); audit thresholds are the deterministic audit rails you may tighten or",
  "loosen within their hard clamps.",
  "No markdown, JSON only.",
].join(" ");

export function compactMarket(market) {
  return {
    generatedAt: market.generatedAt,
    aggregate: market.aggregate,
    pools: market.pools
      .filter((pool) => pool.available)
      .map((pool) => ({
        id: pool.id,
        venue: pool.venue,
        quote: pool.quote,
        tvlUsd: pool.tvlUsd,
        volume24hUsd: pool.metrics.volume24hUsd,
        fees24hUsd: pool.metrics.fees24hUsd,
        feeApr: pool.metrics.feeApr,
        effectiveFeeBps: pool.metrics.effectiveFeeBps,
        activeTvlUsd: pool.active?.activeTvlUsd ?? null,
        activeShare: pool.active?.activeShare ?? null,
        sigma3hBps: pool.volatility.h3 == null ? null : pool.volatility.h3 * 10_000,
        sigma14dBps: pool.volatility.h14d == null ? null : pool.volatility.h14d * 10_000,
        decision: pool.decision
          ? {
              worthLp: pool.decision.worthLp,
              reason: pool.decision.reason,
              bestBandBps: pool.decision.best?.bandBps ?? null,
              expectedIlBps: pool.decision.best?.expectedIlBps ?? null,
              expectedFeeBps: pool.decision.best?.expectedFeeBps ?? null,
              netEdgeBps: pool.decision.best?.netEdgeBps ?? null,
              pIlExceedsFees: pool.decision.best?.pIlExceedsFees ?? null,
              var95Bps: pool.decision.best?.var95Bps ?? null,
              cvar95Bps: pool.decision.best?.cvar95Bps ?? null,
              requiredFeeBps: pool.decision.best?.requiredFeeBps ?? null,
              suggestedMaxDeployUsdc: pool.decision.suggestedMaxDeployUsdc ?? null,
            }
          : null,
      })),
  };
}

// Current deterministic policy state for the manager prompt (not part of the snapshot hash).
export function compactPolicy(policy) {
  if (!policy) return null;
  return {
    generatedAt: policy.generatedAt,
    regime: policy.regime,
    quotingEnabled: policy.quotingEnabled,
    params: policy.params ?? null,
    audit: policy.audit ?? null,
    risk: policy.risk ?? null,
    composition: policy.composition ?? null,
  };
}
