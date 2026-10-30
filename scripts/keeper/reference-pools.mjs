// Reference pools: external NVDA/USD and NVDA/ETH markets, read-only.
//
// The keeper reads these pools (price, liquidity, swap volume) to keep its own bands honest.
// It never adds liquidity, moves capital or signs for them: this module is market data only.
//
// Nothing here is a live market value. `DEFAULT_REFERENCE_POOLS` is a list of DISABLED
// placeholders; replace them either way:
//   1. `KEEPER_REFERENCE_POOLS` env JSON (parsed and validated by scripts/keeper/config.mjs), or
//   2. edit this module, fill an entry and flip `enabled: true`.
// Three or four pools is the expected size: NVDA/USD and NVDA/ETH, v3 and/or v4.
//
// `KEEPER_REFERENCE_POOLS` JSON shape (must be one line in `.env`):
//
//   [
//     {
//       "name": "nvda-usd-v3-005",       // unique (case-insensitive), non-empty; used in logs
//       "kind": "v3",                     // "v3" | "v4"
//       "pair": "nvda-usd",               // "nvda-usd" | "nvda-eth"
//       "enabled": true,                  // default false; disabled entries are inert
//       "address": "0x...",               // v3 pool address (20 bytes, required when enabled)
//       "quoteToken": "0x...",            // USDG (nvda-usd) or WETH (nvda-eth)
//       "equityToken": "0x...",           // NVDA; must differ from quoteToken
//       "feePips": 500                    // v3 only, optional, 0..1000000
//     },
//     {
//       "name": "nvda-usd-v4-ext",
//       "kind": "v4",
//       "pair": "nvda-usd",
//       "enabled": true,
//       "poolId": "0x...",                // 32 bytes, required when enabled
//       "poolManager": "0x...",           // optional 20-byte PoolManager
//       "tickSpacing": 60,                // optional, integer > 0
//       "quoteToken": "0x...",
//       "equityToken": "0x..."
//     }
//   ]
//
// Enabled entries require `quoteToken` and `equityToken` (20-byte addresses, distinct). Disabled
// entries may leave every address/id empty. Unknown fields are rejected so a typo fails loudly.

/** Fields accepted on a reference-pool entry. Env JSON and this module share the schema. */
export const REFERENCE_POOL_KEYS = Object.freeze([
  "name",
  "kind",
  "pair",
  "enabled",
  "address",
  "quoteToken",
  "equityToken",
  "feePips",
  "poolId",
  "poolManager",
  "tickSpacing",
]);

/** Supported pool kinds. */
export const REFERENCE_POOL_KINDS = Object.freeze(["v3", "v4"]);

/** Supported pairs: NVDA quoted in USD (USDG) and in ETH (WETH). */
export const REFERENCE_POOL_PAIRS = Object.freeze(["nvda-usd", "nvda-eth"]);

/**
 * Disabled placeholders. No live pool address or id is baked in, so the config validates without
 * a deployment and nothing is read until an operator fills an entry in and flips `enabled`.
 *
 * Operator reference only (deliberately NOT enabled below): the known Uniswap v3 0.05%
 * USDG/NVDA pool on Robinhood mainnet is 0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3.
 * Re-verify the pool, its tokens and its fee tier before enabling anything.
 */
export const DEFAULT_REFERENCE_POOLS = Object.freeze([
  // NVDA/USD v3, 0.05% tier.
  Object.freeze({
    name: "nvda-usd-v3-005",
    kind: "v3",
    pair: "nvda-usd",
    enabled: false,
    address: "",
    quoteToken: "",
    equityToken: "",
    feePips: 500,
  }),
  // NVDA/USD v3, 0.30% tier.
  Object.freeze({
    name: "nvda-usd-v3-030",
    kind: "v3",
    pair: "nvda-usd",
    enabled: false,
    address: "",
    quoteToken: "",
    equityToken: "",
    feePips: 3_000,
  }),
  // NVDA/ETH v3, 0.05% tier (WETH is the quote token).
  Object.freeze({
    name: "nvda-eth-v3-005",
    kind: "v3",
    pair: "nvda-eth",
    enabled: false,
    address: "",
    quoteToken: "",
    equityToken: "",
    feePips: 500,
  }),
  // NVDA/USD v4, external venue. v4 fees are dynamic, so the entry carries tickSpacing instead
  // of a fee tier. The token pair stays explicit so enabling is a one-line edit.
  Object.freeze({
    name: "nvda-usd-v4-ext",
    kind: "v4",
    pair: "nvda-usd",
    enabled: false,
    poolId: "",
    poolManager: "",
    tickSpacing: 60,
    quoteToken: "",
    equityToken: "",
  }),
]);
