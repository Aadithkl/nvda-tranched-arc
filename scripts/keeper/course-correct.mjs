// Pure advisory course correction from the external-market view.
//
// The keeper's bands (guard width/share, risk floors, NVDA step) are policy values. The external
// reference pools can suggest a nudge inside hard configured bounds, but this module never
// applies anything: `apply` is always false, there is no I/O, and no capital or on-chain action
// follows from its output. A caller may display the recommendations, or use them only when the
// reference mode is `apply` and its own safety gates pass.
//
// All targets are clamped to the `config.course` bands and rounded to whole bps/USD. An
// `uncertain` market returns the book's current values unchanged.

import { median } from "./reference-math.mjs";

const DEFAULT_BUFFER_BPS = 500;
const KNOWN_REGIMES = new Set(["calm", "normal", "thin", "volatile", "uncertain"]);

function numberOr(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function nonNegative(value, fallback = 0) {
  const n = numberOr(value, fallback);
  return n > 0 ? n : 0;
}

/** Finite number or null, so `0` and "missing" stay distinguishable. */
function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (!Number.isFinite(value)) return lo;
  return Math.min(hi, Math.max(lo, value));
}

/** Bounds in ascending order; a missing max collapses to the min. */
function bounds(min, max, fallbackMin = 0) {
  const lo = numberOr(min, fallbackMin);
  const hi = numberOr(max, lo);
  return lo <= hi ? [lo, hi] : [hi, lo];
}

function healthyPools(marketView) {
  return Array.isArray(marketView?.healthy) ? marketView.healthy : [];
}

/** Fast-window (6h) volatility median; falls back to the raw healthy-pool field. */
function viewMedianVolatility(marketView) {
  const direct =
    finiteOrNull(marketView?.medianVol6h) ?? finiteOrNull(marketView?.medianVolatilityBps);
  if (direct !== null) return direct;
  return median(healthyPools(marketView).map((pool) => pool?.volatilityBps));
}

function viewMedianVolume(marketView) {
  const direct = finiteOrNull(marketView?.medianVolume24h);
  if (direct !== null) return direct;
  return median(healthyPools(marketView).map((pool) => pool?.volume24h));
}

function viewMedianNetApr(marketView) {
  const direct = finiteOrNull(marketView?.medianExternalNetApr);
  if (direct !== null) return direct;
  return median(healthyPools(marketView).map((pool) => pool?.netApr24h));
}

function changeReason(up, down) {
  if (up > 0 && down === 0) return "market-loosened";
  if (down > 0 && up === 0) return "market-tightened";
  return "market-mixed";
}

/**
 * Advisory fee-tier preference.
 *
 * Compares the book's own net APR with the healthy-pool median for the book's fee tier. A switch
 * is only suggested when another tier's median is both higher than the current tier and clears
 * the configured buffer. `preferredFeePips` is advisory; the caller maps it to Book A/B.
 */
function recommendBookBias({ marketView, book, course }) {
  const byFeeTier = marketView?.byFeeTier;
  if (byFeeTier === null || typeof byFeeTier !== "object") {
    return { preferredFeePips: null, reason: "no-reference-tier" };
  }

  const currentKey = String(book?.feePips);
  const currentMedian = finiteOrNull(byFeeTier[currentKey]?.medianNetApr24h);
  if (currentMedian === null) {
    return { preferredFeePips: null, reason: "no-reference-tier" };
  }

  const bookApr = finiteOrNull(book?.netAprBps);
  if (bookApr === null) {
    return { preferredFeePips: null, reason: "no-book-apr" };
  }

  const bufferBps = nonNegative(course?.bufferBps, DEFAULT_BUFFER_BPS);
  const gapBps = currentMedian - bookApr;
  if (gapBps <= 0) {
    return { preferredFeePips: null, reason: "book-ahead" };
  }
  if (gapBps < bufferBps) {
    return { preferredFeePips: null, reason: "within-buffer" };
  }

  let best = null;
  for (const [key, tier] of Object.entries(byFeeTier)) {
    if (key === currentKey) continue;
    const tierApr = finiteOrNull(tier?.medianNetApr24h);
    if (tierApr === null || tierApr <= currentMedian) continue;
    const feePips = Number(key);
    if (!Number.isFinite(feePips)) continue;
    if (best === null || tierApr > best.medianNetApr24h) {
      best = { feePips, medianNetApr24h: tierApr, count: numberOr(tier?.count, 0) };
    }
  }

  if (best === null) {
    return { preferredFeePips: null, reason: "no-better-tier" };
  }

  const marginBps = best.medianNetApr24h - currentMedian;
  let confidence = "low";
  if (best.count >= 2 && marginBps >= bufferBps) confidence = "medium";
  if (best.count >= 2 && marginBps >= 2 * bufferBps) confidence = "high";

  return {
    preferredFeePips: best.feePips,
    reason: "fee-tier-outperforms",
    confidence,
  };
}

function neutralResult({ book, reason, warnings }) {
  const current = book ?? {};
  return {
    apply: false,
    risk: {
      maxVolatilityBps: numberOr(current.maxVolatilityBps, 0),
      minVolumeUsd: numberOr(current.minVolumeUsd, 0),
      changed: false,
      reason,
    },
    guard: {
      widthBps: numberOr(current.guardWidthBps, 0),
      shareBps: numberOr(current.guardShareBps, 0),
      changed: false,
      reason,
    },
    bookBias: { preferredFeePips: null, reason },
    arm: {
      nvdaStepBps: numberOr(current.nvdaStepBps, 0),
      changed: false,
      reason,
    },
    reArm: { allowed: false, reason },
    warnings,
  };
}

/**
 * Recommend bounded course corrections. Advisory only.
 *
 * @param {object} input
 * @param {object} [input.marketView] output of `buildMarketView`
 * @param {object} [input.book] current book limits
 * @param {object} [input.config] `config.course`
 * @returns {object} `{ apply: false, risk, guard, bookBias, arm, reArm, warnings }`
 */
export function recommendCourse({ marketView, book, config } = {}) {
  const course = config ?? {};
  const current = book ?? {};

  const warnings = [];
  const seenWarnings = new Set();
  const warn = (message) => {
    const text = String(message);
    if (seenWarnings.has(text)) return;
    seenWarnings.add(text);
    warnings.push(text);
  };
  if (Array.isArray(marketView?.warnings)) {
    for (const message of marketView.warnings) warn(message);
  }

  const rawRegime = typeof marketView?.regime === "string" ? marketView.regime : "uncertain";
  const regime = KNOWN_REGIMES.has(rawRegime) ? rawRegime : "uncertain";

  if (regime === "uncertain") {
    warn("uncertain-market");
    return neutralResult({ book: current, reason: "uncertain-market", warnings });
  }

  // Risk sizing: scale with fast volatility and 24h volume, then clamp.
  const baselineVolBps = nonNegative(course.baselineVolBps);
  const medianVolBps = viewMedianVolatility(marketView);
  const volRatio = clamp(baselineVolBps > 0 ? medianVolBps / baselineVolBps : 1, 0.5, 2);

  const baselineVolumeUsd = nonNegative(course.baselineVolumeUsd);
  const medianVolume24h = viewMedianVolume(marketView);
  const volumeRatio = clamp(
    baselineVolumeUsd > 0 ? medianVolume24h / baselineVolumeUsd : 1,
    0.5,
    1.5,
  );

  const currentVolBps = numberOr(current.maxVolatilityBps, 0);
  const currentVolumeUsd = numberOr(current.minVolumeUsd, 0);
  const [riskVolMin, riskVolMax] = bounds(
    course.riskVolMinBps,
    course.riskVolMaxBps,
  );
  const [riskVolumeMin, riskVolumeMax] = bounds(
    course.riskVolumeMinUsd,
    course.riskVolumeMaxUsd,
  );

  const rawVolBps = currentVolBps * volRatio;
  const rawVolumeUsd = currentVolumeUsd * volumeRatio;
  const recVolBps = clamp(Math.round(rawVolBps), riskVolMin, riskVolMax);
  const recVolumeUsd = clamp(Math.round(rawVolumeUsd), riskVolumeMin, riskVolumeMax);

  if (rawVolBps < Math.min(riskVolMin, riskVolMax) || rawVolBps > Math.max(riskVolMin, riskVolMax)) {
    warn("risk-volatility-clamped");
  }
  if (
    rawVolumeUsd < Math.min(riskVolumeMin, riskVolumeMax) ||
    rawVolumeUsd > Math.max(riskVolumeMin, riskVolumeMax)
  ) {
    warn("risk-volume-clamped");
  }

  const riskUp =
    (recVolBps > currentVolBps ? 1 : 0) + (recVolumeUsd > currentVolumeUsd ? 1 : 0);
  const riskDown =
    (recVolBps < currentVolBps ? 1 : 0) + (recVolumeUsd < currentVolumeUsd ? 1 : 0);
  const riskChanged = riskUp + riskDown > 0;
  const riskReason = riskChanged ? changeReason(riskUp, riskDown) : "unchanged";

  // Guard: width tracks volatility; share follows the sign of external net APR.
  const currentWidthBps = nonNegative(current.guardWidthBps);
  const currentShareBps = nonNegative(current.guardShareBps);
  const widthEnabled = currentWidthBps > 0;
  const shareEnabled = currentShareBps > 0;
  const [guardWidthMin, guardWidthMax] = bounds(
    course.guardWidthMinBps,
    course.guardWidthMaxBps,
  );
  const [guardShareMin, guardShareMax] = bounds(
    course.guardShareMinBps,
    course.guardShareMaxBps,
  );

  let recWidthBps = 0;
  if (widthEnabled) {
    const rawWidthBps = currentWidthBps * volRatio;
    recWidthBps = clamp(Math.round(rawWidthBps), guardWidthMin, guardWidthMax);
    if (
      rawWidthBps < Math.min(guardWidthMin, guardWidthMax) ||
      rawWidthBps > Math.max(guardWidthMin, guardWidthMax)
    ) {
      warn("guard-width-clamped");
    }
  }

  let recShareBps = 0;
  if (shareEnabled) {
    const shareBufferBps = nonNegative(course.bufferBps, DEFAULT_BUFFER_BPS);
    const shareStepBps = viewMedianNetApr(marketView) > 0 ? shareBufferBps : -shareBufferBps;
    const rawShareBps = currentShareBps + shareStepBps;
    recShareBps = clamp(Math.round(rawShareBps), guardShareMin, guardShareMax);
    if (
      rawShareBps < Math.min(guardShareMin, guardShareMax) ||
      rawShareBps > Math.max(guardShareMin, guardShareMax)
    ) {
      warn("guard-share-clamped");
    }
  }

  const widthChanged = widthEnabled && recWidthBps !== currentWidthBps;
  const shareChanged = shareEnabled && recShareBps !== currentShareBps;
  const guardChanged = widthChanged || shareChanged;
  const guardReason =
    !widthEnabled && !shareEnabled
      ? "guard-disabled"
      : guardChanged
        ? "market-scaled"
        : "unchanged";

  // Book bias is advisory; the caller owns the Book A/B mapping.
  const bookBias = recommendBookBias({ marketView, book: current, course });

  // Arm: halve the NVDA step when fast volatility is high, never below 1 bps.
  const armVolHighBps = nonNegative(course.armVolHighBps, 600);
  const currentStepBps = Math.max(0, Math.trunc(numberOr(current.nvdaStepBps, 0)));
  const volHigh = medianVolBps >= armVolHighBps;
  const recStepBps = volHigh ? Math.max(1, Math.floor(currentStepBps / 2)) : currentStepBps;
  const armChanged = recStepBps !== currentStepBps;
  const armReason = armChanged ? "volatility-high" : volHigh ? "step-floor" : "volatility-normal";

  // Re-arm is blocked only in the two worst regimes; thin is low-conviction, not unsafe.
  const reArmAllowed = regime !== "uncertain" && regime !== "volatile";
  const reArmReason = reArmAllowed
    ? "market-allowed"
    : regime === "uncertain"
      ? "uncertain-market"
      : "volatile-market";

  return {
    apply: false,
    risk: {
      maxVolatilityBps: recVolBps,
      minVolumeUsd: recVolumeUsd,
      changed: riskChanged,
      reason: riskReason,
    },
    guard: {
      widthBps: recWidthBps,
      shareBps: recShareBps,
      changed: guardChanged,
      reason: guardReason,
    },
    bookBias,
    arm: {
      nvdaStepBps: recStepBps,
      changed: armChanged,
      reason: armReason,
    },
    reArm: { allowed: reArmAllowed, reason: reArmReason },
    warnings,
  };
}
