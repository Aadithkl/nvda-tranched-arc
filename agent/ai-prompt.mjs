// Shared prompt/compaction for LLM reasoning over the Graph market snapshot.
export const SYSTEM_PROMPT = [
  "You are the strategy manager for an onchain tranched structured product on NVDA.",
  "The product runs a senior (fixed coupon) / junior (levered residual) vault whose capital can be",
  "deployed as concentrated-liquidity (JIT) positions on NVDAc pools. You are called every few hours",
  "and receive the live market snapshot (The Graph) plus the current deterministic policy state:",
  "hook params, effective audit thresholds, book composition and risk.",
  "INPUT you receive: `market` = the Base NVDAc pools (fees, volume, TVL, volatility and the fee-vs-IL",
  "sweep per band) plus `ownPool` = our deployed USDC/NVDA venue (swap count, realized volume, fees paid,",
  "LP value and fee run-rate). `policy` = current params, audit thresholds, risk book and composition.",
  "`ownPool.feesUsd` is realized income; `ownPool.feeApr` is a run-rate from a short window, so weigh it",
  "with `ownPool.spanHours`.",
  "`aggregate.effective` is the blended fee source: Arc realized fees and the Base fee run-rate averaged",
  "with weight `blendWeight` (e.g. 0.5 = 50/50). `source=blend` means both venues counted; `source=base`",
  "means the Arc venue was unavailable; `lowConfidence=true` means the Arc window is under 6h, so treat",
  "its numbers as provisional and lean on the Base side.",
  "QUESTIONS you answer on every call: (1) is JIT/LP worth it right now (edge after IL and costs > 0,",
  "using the blended fee source)?",
  "(2) which JIT band (bucketTicks) and max size per swap? (3) fee schedule, quoting on/off, TTL/grace",
  "and deviation band? (4) which audit thresholds to tighten or loosen? (5) rebalance buy/sell/hold and",
  "size inside the equity cap? (6) what would invalidate this (list as `risks`)?",
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
  '"paramOverrides":{"quotingEnabled":bool,"baseFee":int,"maxDeviationBps":int,',
  '"toxicityMultiplierBps":int,"minEvBps":int,"cooldownSeconds":int,"ttl":int,"gracePeriod":int,',
  '"maxDeployPerSwap":int,"bucketTicks":int},',
  '"auditOverrides":{"minNetEdgeBps":num,"minJuniorBufferBps":num,"maxDeployOfJuniorBps":num,',
  '"maxVar95Bps":num,"maxPIlExceedsFees":num},',
  '"rebalance":{"action":"buy"|"sell"|"hold","sizeUsd":int,"rationale":string},',
  '"rationale":string,"risks":[string]}',
  "Omit any override field you do not want to change; every field except decision is optional.",
  "Field notes: baseFee is in v4 fee units (1e6 = 100%); maxDeployPerSwap is USDC",
  "(6 decimals onchain); ttl/gracePeriod/cooldownSeconds are seconds; bucketTicks is the JIT range",
  "width in ticks (1-5000); audit thresholds are the deterministic audit rails you may tighten or",
  "loosen within their hard clamps.",
  "No markdown, JSON only.",
].join(" ");

export function compactMarket(market) {
  return {
    generatedAt: market.generatedAt,
    aggregate: market.aggregate,
    ownPool: market.ownPool
      ? market.ownPool.available
        ? {
            poolId: market.ownPool.poolId,
            usdPerNvda: market.ownPool.usdPerNvda,
            swapCount: market.ownPool.swapCount,
            volumeUsd: Number(market.ownPool.volumeUsd.toFixed(2)),
            feesUsd: Number(market.ownPool.feesUsd.toFixed(4)),
            feeApr: Number(market.ownPool.feeApr.toFixed(4)),
            lpValueUsd: Number(market.ownPool.lpValueUsd.toFixed(2)),
            spanHours: market.ownPool.spanHours,
          }
        : { available: false, reason: market.ownPool.reason }
      : null,
    effective: market.aggregate?.effective
      ? {
          source: market.aggregate.effective.source,
          blendWeight: market.aggregate.effective.blendWeight,
          feeBpsPerDay: Number(market.aggregate.effective.feeBpsPerDay.toFixed(2)),
          ilBpsPerDay: Number(market.aggregate.effective.ilBpsPerDay.toFixed(2)),
          netEdgeBpsPerDay: Number(market.aggregate.effective.netEdgeBpsPerDay.toFixed(2)),
          worthLp: market.aggregate.effective.worthLp,
          lowConfidence: market.aggregate.effective.lowConfidence,
        }
      : null,
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
