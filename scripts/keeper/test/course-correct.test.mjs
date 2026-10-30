import test from "node:test";
import assert from "node:assert/strict";
import { recommendCourse } from "../course-correct.mjs";

const COURSE = {
  bufferBps: 500,
  fastBufferBps: 1_000,
  guardWidthMinBps: 200,
  guardWidthMaxBps: 3_000,
  guardShareMinBps: 1_000,
  guardShareMaxBps: 9_000,
  riskVolMinBps: 150,
  riskVolMaxBps: 1_200,
  riskVolumeMinUsd: 5_000,
  riskVolumeMaxUsd: 100_000,
  baselineVolBps: 300,
  baselineVolumeUsd: 15_000,
  armVolHighBps: 600,
};

function view(overrides = {}) {
  return {
    regime: "normal",
    byPair: {},
    byFeeTier: {
      "500": { count: 2, medianNetApr24h: 900 },
      "3000": { count: 2, medianNetApr24h: 400 },
    },
    medianExternalNetApr: 700,
    medianVol6h: 300,
    medianVolatilityBps: 300,
    medianVolume24h: 15_000,
    healthy: [],
    warnings: [],
    ...overrides,
  };
}

function book(overrides = {}) {
  return {
    name: "book-a",
    feePips: 500,
    netAprBps: 600,
    netApr6h: 400,
    bookValueUsd: 100_000,
    maxVolatilityBps: 300,
    minVolumeUsd: 10_000,
    guardWidthBps: 1_000,
    guardShareBps: 5_000,
    nvdaStepBps: 1_000,
    ...overrides,
  };
}

test("uncertain market: every recommendation stays at the book's values", () => {
  const result = recommendCourse({
    marketView: view({ regime: "uncertain", warnings: ["cross-check-failed"] }),
    book: book(),
    config: COURSE,
  });

  assert.equal(result.apply, false);
  assert.deepEqual(result.risk, {
    maxVolatilityBps: 300,
    minVolumeUsd: 10_000,
    changed: false,
    reason: "uncertain-market",
  });
  assert.deepEqual(result.guard, {
    widthBps: 1_000,
    shareBps: 5_000,
    changed: false,
    reason: "uncertain-market",
  });
  assert.deepEqual(result.bookBias, {
    preferredFeePips: null,
    reason: "uncertain-market",
  });
  assert.deepEqual(result.arm, {
    nvdaStepBps: 1_000,
    changed: false,
    reason: "uncertain-market",
  });
  assert.deepEqual(result.reArm, { allowed: false, reason: "uncertain-market" });
  assert.ok(result.warnings.includes("cross-check-failed"));
  assert.ok(result.warnings.includes("uncertain-market"));
});

test("risk: high volatility and deep volume clamp to the upper bounds", () => {
  const result = recommendCourse({
    marketView: view({ medianVol6h: 900, medianVolume24h: 100_000 }),
    book: book({ maxVolatilityBps: 1_000, minVolumeUsd: 90_000 }),
    config: COURSE,
  });

  assert.equal(result.apply, false);
  assert.deepEqual(result.risk, {
    maxVolatilityBps: 1_200,
    minVolumeUsd: 100_000,
    changed: true,
    reason: "market-loosened",
  });
  assert.ok(result.warnings.includes("risk-volatility-clamped"));
  assert.ok(result.warnings.includes("risk-volume-clamped"));
});

test("risk: quiet volatility and thin volume clamp to the lower bounds", () => {
  const result = recommendCourse({
    marketView: view({ medianVol6h: 30, medianVolume24h: 1_000 }),
    book: book({ maxVolatilityBps: 200, minVolumeUsd: 8_000 }),
    config: COURSE,
  });

  assert.deepEqual(result.risk, {
    maxVolatilityBps: 150,
    minVolumeUsd: 5_000,
    changed: true,
    reason: "market-tightened",
  });
  assert.ok(result.warnings.includes("risk-volatility-clamped"));
  assert.ok(result.warnings.includes("risk-volume-clamped"));
});

test("risk: baseline vol and volume leave the book unchanged", () => {
  const result = recommendCourse({
    marketView: view({ medianVol6h: 300, medianVolume24h: 15_000 }),
    book: book(),
    config: COURSE,
  });

  assert.deepEqual(result.risk, {
    maxVolatilityBps: 300,
    minVolumeUsd: 10_000,
    changed: false,
    reason: "unchanged",
  });
});

test("risk: falls back to raw healthy-pool medians", () => {
  const result = recommendCourse({
    marketView: {
      regime: "normal",
      byFeeTier: { "500": { count: 2, medianNetApr24h: 700 } },
      healthy: [
        { volatilityBps: 600, volume24h: 30_000, netApr24h: 700 },
        { volatilityBps: 600, volume24h: 30_000, netApr24h: 700 },
      ],
      warnings: [],
    },
    book: book(),
    config: COURSE,
  });

  assert.equal(result.risk.maxVolatilityBps, 600);
  assert.equal(result.risk.minVolumeUsd, 15_000);
  assert.equal(result.risk.changed, true);
});

test("guard: width scales with volatility and share follows the net APR sign", () => {
  const result = recommendCourse({
    marketView: view({ medianVol6h: 600, medianExternalNetApr: 700 }),
    book: book({ guardWidthBps: 1_000, guardShareBps: 5_000 }),
    config: COURSE,
  });

  assert.deepEqual(result.guard, {
    widthBps: 2_000,
    shareBps: 5_500,
    changed: true,
    reason: "market-scaled",
  });
});

test("guard: width and share clamp to the upper bounds", () => {
  const result = recommendCourse({
    marketView: view({ medianVol6h: 600, medianExternalNetApr: 700 }),
    book: book({ guardWidthBps: 5_000, guardShareBps: 8_900 }),
    config: COURSE,
  });

  assert.deepEqual(result.guard, {
    widthBps: 3_000,
    shareBps: 9_000,
    changed: true,
    reason: "market-scaled",
  });
  assert.ok(result.warnings.includes("guard-width-clamped"));
  assert.ok(result.warnings.includes("guard-share-clamped"));
});

test("guard: width and share clamp to the lower bounds", () => {
  const result = recommendCourse({
    marketView: view({ medianVol6h: 30, medianExternalNetApr: -100 }),
    book: book({ guardWidthBps: 300, guardShareBps: 1_200 }),
    config: COURSE,
  });

  assert.deepEqual(result.guard, {
    widthBps: 200,
    shareBps: 1_000,
    changed: true,
    reason: "market-scaled",
  });
  assert.ok(result.warnings.includes("guard-width-clamped"));
  assert.ok(result.warnings.includes("guard-share-clamped"));
});

test("guard: zero width and zero share stay disabled", () => {
  const result = recommendCourse({
    marketView: view(),
    book: book({ guardWidthBps: 0, guardShareBps: 0 }),
    config: COURSE,
  });

  assert.deepEqual(result.guard, {
    widthBps: 0,
    shareBps: 0,
    changed: false,
    reason: "guard-disabled",
  });
});

test("book bias: another tier above the buffer is preferred, confidence by margin", () => {
  const low = recommendCourse({
    marketView: view({
      byFeeTier: {
        "500": { count: 3, medianNetApr24h: 600 },
        "3000": { count: 2, medianNetApr24h: 900 },
      },
    }),
    book: book({ netAprBps: 0 }),
    config: COURSE,
  });
  assert.deepEqual(low.bookBias, {
    preferredFeePips: 3_000,
    reason: "fee-tier-outperforms",
    confidence: "low",
  });

  const medium = recommendCourse({
    marketView: view({
      byFeeTier: {
        "500": { count: 3, medianNetApr24h: 600 },
        "3000": { count: 2, medianNetApr24h: 1_200 },
      },
    }),
    book: book({ netAprBps: 0 }),
    config: COURSE,
  });
  assert.deepEqual(medium.bookBias, {
    preferredFeePips: 3_000,
    reason: "fee-tier-outperforms",
    confidence: "medium",
  });

  const high = recommendCourse({
    marketView: view({
      byFeeTier: {
        "500": { count: 3, medianNetApr24h: 600 },
        "3000": { count: 2, medianNetApr24h: 1_600 },
      },
    }),
    book: book({ netAprBps: 0 }),
    config: COURSE,
  });
  assert.deepEqual(high.bookBias, {
    preferredFeePips: 3_000,
    reason: "fee-tier-outperforms",
    confidence: "high",
  });
});

test("book bias: within buffer, book ahead and missing tiers stay put", () => {
  const within = recommendCourse({
    marketView: view({
      byFeeTier: {
        "500": { count: 3, medianNetApr24h: 600 },
        "3000": { count: 2, medianNetApr24h: 1_200 },
      },
    }),
    book: book({ netAprBps: 200 }),
    config: COURSE,
  });
  assert.deepEqual(within.bookBias, {
    preferredFeePips: null,
    reason: "within-buffer",
  });

  const ahead = recommendCourse({
    marketView: view({
      byFeeTier: {
        "500": { count: 3, medianNetApr24h: 600 },
        "3000": { count: 2, medianNetApr24h: 1_200 },
      },
    }),
    book: book({ netAprBps: 700 }),
    config: COURSE,
  });
  assert.deepEqual(ahead.bookBias, {
    preferredFeePips: null,
    reason: "book-ahead",
  });

  const missing = recommendCourse({
    marketView: view({ byFeeTier: {} }),
    book: book(),
    config: COURSE,
  });
  assert.deepEqual(missing.bookBias, {
    preferredFeePips: null,
    reason: "no-reference-tier",
  });
});

test("book bias: no other tier beats the book's own tier", () => {
  const onlyTier = recommendCourse({
    marketView: view({
      byFeeTier: {
        "500": { count: 3, medianNetApr24h: 900 },
      },
    }),
    book: book({ netAprBps: 0 }),
    config: COURSE,
  });
  assert.deepEqual(onlyTier.bookBias, {
    preferredFeePips: null,
    reason: "no-better-tier",
  });

  const weakerOther = recommendCourse({
    marketView: view({
      byFeeTier: {
        "500": { count: 3, medianNetApr24h: 900 },
        "3000": { count: 2, medianNetApr24h: 600 },
      },
    }),
    book: book({ netAprBps: 0 }),
    config: COURSE,
  });
  assert.deepEqual(weakerOther.bookBias, {
    preferredFeePips: null,
    reason: "no-better-tier",
  });
});

test("arm: high volatility halves the NVDA step with a 1 bps floor", () => {
  const research = recommendCourse({
    marketView: view({ medianVol6h: 700 }),
    book: book({ nvdaStepBps: 1_000 }),
    config: COURSE,
  });
  assert.deepEqual(research.arm, {
    nvdaStepBps: 500,
    changed: true,
    reason: "volatility-high",
  });

  const atThreshold = recommendCourse({
    marketView: view({ medianVol6h: 600 }),
    book: book({ nvdaStepBps: 1_000 }),
    config: COURSE,
  });
  assert.deepEqual(atThreshold.arm, {
    nvdaStepBps: 500,
    changed: true,
    reason: "volatility-high",
  });

  const normal = recommendCourse({
    marketView: view({ medianVol6h: 500 }),
    book: book({ nvdaStepBps: 1_000 }),
    config: COURSE,
  });
  assert.deepEqual(normal.arm, {
    nvdaStepBps: 1_000,
    changed: false,
    reason: "volatility-normal",
  });

  const floor = recommendCourse({
    marketView: view({ medianVol6h: 700 }),
    book: book({ nvdaStepBps: 1 }),
    config: COURSE,
  });
  assert.deepEqual(floor.arm, {
    nvdaStepBps: 1,
    changed: false,
    reason: "step-floor",
  });
});

test("re-arm: allowed outside volatile and uncertain regimes", () => {
  for (const regime of ["normal", "calm", "thin"]) {
    const result = recommendCourse({
      marketView: view({ regime }),
      book: book(),
      config: COURSE,
    });
    assert.deepEqual(result.reArm, { allowed: true, reason: "market-allowed" }, regime);
  }

  const volatile = recommendCourse({
    marketView: view({ regime: "volatile" }),
    book: book(),
    config: COURSE,
  });
  assert.deepEqual(volatile.reArm, { allowed: false, reason: "volatile-market" });

  const uncertain = recommendCourse({
    marketView: view({ regime: "uncertain" }),
    book: book(),
    config: COURSE,
  });
  assert.deepEqual(uncertain.reArm, { allowed: false, reason: "uncertain-market" });
});

test("warnings pass through and are deduplicated", () => {
  const passed = recommendCourse({
    marketView: view({ warnings: ["cross-check-unavailable"] }),
    book: book(),
    config: COURSE,
  });
  assert.deepEqual(passed.warnings, ["cross-check-unavailable"]);

  const once = recommendCourse({
    marketView: view({ regime: "uncertain", warnings: ["uncertain-market"] }),
    book: book(),
    config: COURSE,
  });
  assert.deepEqual(once.warnings, ["uncertain-market"]);
});

test("missing view is treated as uncertain, never as an implicit approval", () => {
  const result = recommendCourse({ book: book(), config: COURSE });

  assert.equal(result.apply, false);
  assert.equal(result.risk.changed, false);
  assert.equal(result.guard.changed, false);
  assert.equal(result.arm.changed, false);
  assert.equal(result.reArm.allowed, false);
  assert.deepEqual(result.bookBias, {
    preferredFeePips: null,
    reason: "uncertain-market",
  });
});
