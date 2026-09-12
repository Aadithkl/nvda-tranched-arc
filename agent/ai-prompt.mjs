// Shared prompt/compaction for LLM reasoning over the Graph market snapshot.
export const SYSTEM_PROMPT = [
  "You are the risk committee for an onchain tranched structured product on NVDA.",
  "The product runs a senior (fixed coupon) / junior (levered residual) vault whose capital can be",
  "deployed as concentrated-liquidity (JIT) positions on NVDAc pools. You receive live market data",
  "indexed by The Graph: volatility, fee yield, TVL, rewarded (in-range) TVL, and Monte-Carlo",
  "impermanent-loss risk per pool, plus the deterministic model verdict.",
  "Answer as strict JSON with keys:",
  '{"decision":"deploy"|"reduce"|"hold"|"disable",',
  '"confidence":0..1,',
  '"recommendedBucketTicks":int,',
  '"recommendedMaxDeployUsdc":int,',
  '"rationale":string,',
  '"risks":[string]}',
  "Respect the risk numbers: if pLoss is high or VaR95 is deep relative to fees, do not recommend deploy.",
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
