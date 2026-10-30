// Read-only deployment preflight for the NVDA keeper.
//
// Verifies that the configured addresses, wiring, pool ids, Morpho market and controller limits
// all agree *before* the keeper is allowed to send anything. It never signs, never needs a
// private key, and never writes state.
//
// Market-agnostic: the market is discovered from each adapter's `marketParams()` and the Morpho
// singleton from `adapter.morpho()`. Nothing here assumes a specific oracle, IRM, LLTV, market id
// or pool id.
//
// CLI: `npm run keeper:preflight` (exits 1 only when a fatal check fails).

import { createPublicClient, encodeAbiParameters, formatUnits, http, keccak256, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadConfig, ConfigError } from "./config.mjs";

const BPS = 10_000n;
const WAD = 10n ** 18n;
const SECONDS_PER_YEAR = 31_536_000n;
const MAX_LLTV = WAD;
const ETH_USD_MAX_STALENESS_SECONDS = 86_400;

// ---------------------------------------------------------------------------
// ABIs (views only)
// ---------------------------------------------------------------------------

const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

const agentAbi = parseAbi([
  "function operator() view returns (address)",
  "function controller() view returns (address)",
]);

const controllerAbi = parseAbi([
  "function vault() view returns (address)",
  "function paused() view returns (bool)",
  "function switchFrozen() view returns (bool)",
  "function switchDwell() view returns (uint32)",
  "function lastSwitchAt() view returns (uint256)",
  "function strategyModule() view returns (address)",
  "function bounds() view returns ((int24 maxGuardTickWidth, int24 maxBaseTickWidth, uint128 maxGuardLiquidity, uint128 maxBaseLiquidity, int24 minGuardTickWidth, int24 minBaseTickWidth, uint128 minGuardLiquidity, uint128 minBaseLiquidity, uint16 maxMinEvBps, uint32 minRecheckInterval, uint32 maxRecheckInterval, uint16 maxRecheckMaxDeviationBps, uint32 maxMaxPriceAge, uint256 maxFundQuotePerCall, uint256 maxFundEquityPerCall, uint256 maxRebalanceSwapQuote, uint256 maxAllocatePerCall, uint256 maxCollateralPerCall, uint256 maxBorrowPerCall, uint32 recenterCooldown, uint32 rebalanceCooldown, uint256 maxRebalanceQuotePerDay))",
]);

const vaultAbi = parseAbi([
  "function depegPaused() view returns (bool)",
  "function oracleValid() view returns (bool)",
]);

const hubAbi = parseAbi([
  "function vault() view returns (address)",
  "function activePoolId() view returns (bytes32)",
  "function activeBook() view returns (uint8)",
  "function bookA() view returns (address)",
  "function bookB() view returns (address)",
  "function poolInitialized() view returns (bool)",
  "function bookPoolInitialized(uint8 book) view returns (bool)",
]);

const bookAbi = parseAbi([
  "function poolInitialized() view returns (bool)",
  "function guardParams() view returns ((int24 guardTickWidth, int24 baseTickWidth, uint128 guardLiquidity, uint128 baseLiquidity, uint16 minEvBps, uint16 recheckMaxDeviationBps, uint32 recheckInterval, uint32 maxPriceAge, uint8 allowedSessionsMask))",
]);

const adapterAbi = parseAbi([
  "function asset() view returns (address)",
  "function collateralToken() view returns (address)",
  "function authority() view returns (address)",
  "function morpho() view returns (address)",
  "function marketParams() view returns ((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv))",
]);

const moduleAbi = parseAbi([
  "function vault() view returns (address)",
  "function adapters(address adapter) view returns (bool enabled, bool redemptionSafe, bool isLoop, uint256 absoluteCap, uint16 relativeCapBps)",
]);

const morphoAbi = parseAbi([
  "function market(bytes32 id) view returns ((uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee))",
]);

const irmAbi = parseAbi([
  "function borrowRateView((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee) market) view returns (uint256)",
]);

const chainlinkAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

// Checks whose failure means "this deployment cannot run the keeper at all".
export const FATAL_CHECKS = Object.freeze([
  "rpc-chain-id",
  "contract-code",
  "agent-operator",
  "controller-vault",
  "hook-active-pool",
  "books-initialized",
  "adapter-wiring",
  "market-params",
  "module-adapter-config",
  "controller-bounds",
]);
const FATAL = new Set(FATAL_CHECKS);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function short(value) {
  const text = String(value ?? "");
  return text.length <= 14 ? text : `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function sameAddress(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

function shortError(error) {
  const text = error?.shortMessage ?? error?.message ?? String(error);
  return text.length <= 240 ? text : `${text.slice(0, 237)}...`;
}

function annualizeBps(ratePerSecondWad) {
  if (typeof ratePerSecondWad !== "bigint") return 0;
  return Number((ratePerSecondWad * SECONDS_PER_YEAR * BPS) / WAD);
}

function bps(part, whole) {
  if (whole <= 0n) return 0;
  return Number((part * BPS) / whole);
}

/**
 * Canonical Morpho market id: `keccak256(abi.encode(MarketParams))`.
 * The Robinhood deployment has no `id(MarketParams)` view, so it is computed locally.
 */
export function marketIdOf({ loanToken, collateralToken, oracle, irm, lltv }) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
      ],
      [loanToken, collateralToken, oracle, irm, lltv],
    ),
  );
}

function formatBps(value) {
  return `${value}bps`;
}

/**
 * Render a preflight result as a plain-text report.
 * @param {{ ok: boolean, fatal: boolean, checks: Array<{name: string, ok: boolean, detail: string}> }} result
 */
export function formatReport(result) {
  const checks = result?.checks ?? [];
  const failed = checks.filter((c) => !c.ok);
  const fatal = failed.filter((c) => FATAL.has(c.name));
  const status = result?.fatal ? "FAIL" : result?.ok ? "PASS" : "WARN";

  const lines = [
    `Keeper preflight: ${status} (${checks.length} checks, ${failed.length} failed, ${fatal.length} fatal)`,
  ];
  for (const check of checks) {
    const mark = check.ok ? "ok  " : "FAIL";
    lines.push(`  ${mark} ${String(check.name).padEnd(24)} ${check.detail ?? ""}`);
  }
  if (result?.fatal) {
    lines.push(`Blocking: ${fatal.map((c) => c.name).join(", ")}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/**
 * Run every deployment check. Read-only.
 *
 * @param {object} args
 * @param {import("viem").PublicClient} args.publicClient connected client
 * @param {ReturnType<typeof loadConfig>} args.config validated keeper config
 * @param {string} [args.walletAddress] operator address; omit to skip the operator match
 * @returns {Promise<{ok: boolean, fatal: boolean, checks: Array<{name: string, ok: boolean, detail: string}>}>}
 */
export async function runPreflight({ publicClient, config, walletAddress = "" }) {
  if (!publicClient) throw new Error("runPreflight: publicClient is required");
  if (!config) throw new Error("runPreflight: config is required");

  const checks = [];
  /** @type {Record<string, any>} */
  const ctx = {};
  const add = (name, ok, detail) => checks.push({ name, ok: ok === true, detail: detail ?? "" });
  const run = async (name, fn) => {
    try {
      const out = await fn();
      add(name, out?.ok, out?.detail);
    } catch (e) {
      add(name, false, `error: ${shortError(e)}`);
    }
  };

  const { addresses, pools, arm: armCfg, switch: switchCfg } = config;

  // 1. Chain id ------------------------------------------------------------
  await run("rpc-chain-id", async () => {
    const chainId = await publicClient.getChainId();
    ctx.chainId = chainId;
    const ok = chainId === config.rpc.chainId;
    return {
      ok,
      detail: ok
        ? `chain ${chainId}`
        : `rpc reports ${chainId}, KEEPER_CHAIN_ID=${config.rpc.chainId}`,
    };
  });

  // 2. Contract code -------------------------------------------------------
  await run("contract-code", async () => {
    const targets = [
      ["vault", addresses.vault],
      ["hook", addresses.hook],
      ["heartbeat", addresses.heartbeat],
      ["agent", addresses.agent],
    ].filter(([, address]) => address);

    if (targets.length === 0) return { ok: true, detail: "skipped: no contracts configured" };

    ctx.code = {};
    const missing = [];
    for (const [label, address] of targets) {
      const code = await publicClient.getCode({ address });
      const present = typeof code === "string" && code !== "0x" && code.length > 2;
      ctx.code[label] = present;
      if (!present) missing.push(`${label} ${short(address)}`);
    }
    return {
      ok: missing.length === 0,
      detail: missing.length > 0 ? `no code at ${missing.join(", ")}` : `code present: ${targets.map(([l]) => l).join(", ")}`,
    };
  });

  // 3. Agent operator ------------------------------------------------------
  await run("agent-operator", async () => {
    if (!addresses.agent) return { ok: true, detail: "skipped: KEEPER_AGENT not configured" };
    const operator = await publicClient.readContract({
      address: addresses.agent,
      abi: agentAbi,
      functionName: "operator",
    });
    ctx.operator = operator;
    if (!walletAddress) {
      return {
        ok: true,
        detail: `operator=${short(operator)} (wallet check skipped: no KEEPER_PRIVATE_KEY)`,
      };
    }
    const ok = sameAddress(operator, walletAddress);
    return {
      ok,
      detail: ok ? `operator=${short(operator)} == wallet` : `operator=${operator} != wallet=${walletAddress}`,
    };
  });

  // 4. Controller -> vault -------------------------------------------------
  await run("controller-vault", async () => {
    if (!addresses.agent) return { ok: true, detail: "skipped: KEEPER_AGENT not configured" };
    if (!addresses.vault) return { ok: true, detail: "skipped: KEEPER_VAULT not configured" };
    const controller = await publicClient.readContract({
      address: addresses.agent,
      abi: agentAbi,
      functionName: "controller",
    });
    if (!controller || /^0x0{40}$/i.test(controller)) {
      return { ok: false, detail: "agent.controller() is the zero address" };
    }
    ctx.controller = controller;

    const controllerVault = await publicClient.readContract({
      address: controller,
      abi: controllerAbi,
      functionName: "vault",
    });
    ctx.controllerVault = controllerVault;

    const issues = [];
    if (!sameAddress(controllerVault, addresses.vault)) {
      issues.push(`controller.vault=${controllerVault} != KEEPER_VAULT=${addresses.vault}`);
    }

    // The hook is the vault's only fund source; a mismatch orphans keeper inventory.
    let hookVault = "";
    try {
      hookVault = await publicClient.readContract({
        address: addresses.hook,
        abi: hubAbi,
        functionName: "vault",
      });
    } catch {
      // Older single-book hooks may not expose `vault`; skip that sub-check.
    }
    if (hookVault && !sameAddress(hookVault, addresses.vault)) {
      issues.push(`hook.vault=${hookVault} != KEEPER_VAULT=${addresses.vault}`);
    }

    return {
      ok: issues.length === 0,
      detail: issues.length === 0 ? `controller=${short(controller)} vault matches` : issues.join("; "),
    };
  });

  // 5. Controller state ----------------------------------------------------
  await run("controller-state", async () => {
    if (!ctx.controller) return { ok: true, detail: "skipped: controller unavailable" };
    const [paused, switchFrozen] = await Promise.all([
      publicClient.readContract({ address: ctx.controller, abi: controllerAbi, functionName: "paused" }),
      publicClient.readContract({
        address: ctx.controller,
        abi: controllerAbi,
        functionName: "switchFrozen",
      }),
    ]);
    const ok = !paused && !switchFrozen;
    const why = paused ? "controller paused (risk-up blocked)" : switchFrozen ? "switches frozen" : "open";
    return { ok, detail: `paused=${paused} switchFrozen=${switchFrozen} (${why})` };
  });

  // 6. Vault state ---------------------------------------------------------
  await run("vault-state", async () => {
    if (!addresses.vault) return { ok: true, detail: "skipped: KEEPER_VAULT not configured" };
    const [depegPaused, oracleValid] = await Promise.all([
      publicClient.readContract({ address: addresses.vault, abi: vaultAbi, functionName: "depegPaused" }),
      publicClient.readContract({ address: addresses.vault, abi: vaultAbi, functionName: "oracleValid" }),
    ]);
    const ok = !depegPaused && oracleValid;
    return {
      ok,
      detail: `depegPaused=${depegPaused} oracleValid=${oracleValid}`,
    };
  });

  // 7. Active pool ---------------------------------------------------------
  await run("hook-active-pool", async () => {
    if (!addresses.hook) return { ok: true, detail: "skipped: KEEPER_HOOK not configured" };
    const activePoolId = await publicClient.readContract({
      address: addresses.hook,
      abi: hubAbi,
      functionName: "activePoolId",
    });
    ctx.activePoolId = activePoolId;

    const configured = [
      ["KEEPER_BOOK_A_POOL_ID", pools.bookA.poolId],
      ["KEEPER_BOOK_B_POOL_ID", pools.bookB.poolId],
    ].filter(([, id]) => id !== "");

    if (configured.length === 0) {
      return { ok: true, detail: `active pool ${short(activePoolId)} (no book ids configured)` };
    }

    let activeBook = null;
    try {
      activeBook = Number(
        await publicClient.readContract({
          address: addresses.hook,
          abi: hubAbi,
          functionName: "activeBook",
        }),
      );
    } catch {
      // Single-book hook: fall back to membership over the configured ids.
    }
    ctx.activeBook = activeBook;

    // Prefer the active book's own id; fall back to membership when that id is unconfigured.
    const activeBookId = activeBook === 0 ? pools.bookA.poolId : activeBook === 1 ? pools.bookB.poolId : "";
    const matchedByBook =
      activeBookId !== "" && activePoolId.toLowerCase() === activeBookId.toLowerCase();
    const matchedByMembership = configured.some(
      ([, id]) => id.toLowerCase() === activePoolId.toLowerCase(),
    );
    const ok = activeBookId !== "" ? matchedByBook : matchedByMembership;

    return {
      ok,
      detail: ok
        ? `pool ${short(activePoolId)}${matchedByBook ? ` matches book ${activeBook === 0 ? "A" : "B"}` : ""}`
        : `active pool ${activePoolId} is not the configured ${activeBook === 0 || activeBook === 1 ? `book ${activeBook === 0 ? "A" : "B"} ` : ""}id`,
    };
  });

  // 8. Books initialized ---------------------------------------------------
  await run("books-initialized", async () => {
    if (!addresses.hook) return { ok: true, detail: "skipped: KEEPER_HOOK not configured" };

    const bookAddresses = [];
    let hookBookA = "";
    let hookBookB = "";
    try {
      [hookBookA, hookBookB] = await Promise.all([
        publicClient.readContract({ address: addresses.hook, abi: hubAbi, functionName: "bookA" }),
        publicClient.readContract({ address: addresses.hook, abi: hubAbi, functionName: "bookB" }),
      ]);
    } catch {
      hookBookA = "";
      hookBookB = "";
    }
    ctx.books = [];
    if (hookBookA) bookAddresses.push(["bookA", hookBookA]);
    if (hookBookB) bookAddresses.push(["bookB", hookBookB]);

    if (bookAddresses.length === 2) {
      const uninitialized = [];
      for (const [label, address] of bookAddresses) {
        const initialized = await publicClient.readContract({
          address,
          abi: bookAbi,
          functionName: "poolInitialized",
        });
        ctx.books.push({ label, address, initialized });
        if (!initialized) uninitialized.push(`${label} ${short(address)}`);
      }
      return {
        ok: uninitialized.length === 0,
        detail:
          uninitialized.length === 0
            ? `both books initialized (${bookAddresses.map(([, a]) => short(a)).join(", ")})`
            : `not initialized: ${uninitialized.join(", ")}`,
      };
    }

    if (switchCfg.requireBothBooks) {
      return {
        ok: false,
        detail: "requireBothBooks=true but the hook does not expose bookA()/bookB()",
      };
    }

    const initialized = await publicClient.readContract({
      address: addresses.hook,
      abi: hubAbi,
      functionName: "poolInitialized",
    });
    return { ok: initialized, detail: `single book: hub.poolInitialized=${initialized}` };
  });

  // 9. Guard params --------------------------------------------------------
  await run("book-guard-params", async () => {
    if (!ctx.books?.length && !addresses.hook) {
      return { ok: true, detail: "skipped: KEEPER_HOOK not configured" };
    }
    const targets = ctx.books?.length
      ? ctx.books.map((b) => [b.label, b.address])
      : [["hook", addresses.hook]];

    ctx.guardParams = [];
    const problems = [];
    for (const [label, address] of targets) {
      const params = await publicClient.readContract({
        address,
        abi: bookAbi,
        functionName: "guardParams",
      });
      ctx.guardParams.push({ label, params });
      const guardWidth = Number(params.guardTickWidth);
      const baseWidth = Number(params.baseTickWidth);
      if (guardWidth <= 0) problems.push(`${label}: guardTickWidth=${guardWidth}`);
      if (baseWidth <= 0) problems.push(`${label}: baseTickWidth=${baseWidth}`);
      if (params.guardLiquidity <= 0n) problems.push(`${label}: guardLiquidity=0`);
      if (params.baseLiquidity <= 0n) problems.push(`${label}: baseLiquidity=0`);
      if (Number(params.recheckInterval) <= 0) problems.push(`${label}: recheckInterval=0`);
      if (Number(params.maxPriceAge) <= 0) problems.push(`${label}: maxPriceAge=0`);
      if (Number(params.minEvBps) > 10_000) problems.push(`${label}: minEvBps>10000`);
      if (Number(params.recheckMaxDeviationBps) > 10_000) {
        problems.push(`${label}: recheckMaxDeviationBps>10000`);
      }
      if (Number(params.allowedSessionsMask) > 0x0f) problems.push(`${label}: allowedSessionsMask>0x0f`);
    }
    return {
      ok: problems.length === 0,
      detail:
        problems.length === 0
          ? targets
              .map(([label]) => {
                const p = ctx.guardParams.find((g) => g.label === label).params;
                return `${label} guard=${Number(p.guardTickWidth)}/${Number(p.baseTickWidth)} ticks`;
              })
              .join(", ")
          : problems.join(", "),
    };
  });

  // 10. Adapter wiring -----------------------------------------------------
  await run("adapter-wiring", async () => {
    if (!ctx.controller) return { ok: true, detail: "skipped: controller unavailable" };
    const module = await publicClient.readContract({
      address: ctx.controller,
      abi: controllerAbi,
      functionName: "strategyModule",
    });
    if (!module || /^0x0{40}$/i.test(module)) {
      return { ok: false, detail: "controller.strategyModule() is the zero address" };
    }
    ctx.module = module;

    const moduleVault = await publicClient.readContract({
      address: module,
      abi: moduleAbi,
      functionName: "vault",
    });

    const adapters = [
      ["arm", addresses.arm],
      ["usdgAdapter", addresses.usdgAdapter],
    ].filter(([, address]) => address);
    if (adapters.length === 0) return { ok: true, detail: "no adapters configured" };

    const issues = [];
    if (!sameAddress(moduleVault, addresses.vault)) {
      issues.push(`module.vault=${moduleVault} != KEEPER_VAULT=${addresses.vault}`);
    }

    ctx.adapters = {};
    for (const [label, address] of adapters) {
      const [asset, authority] = await Promise.all([
        publicClient.readContract({ address, abi: adapterAbi, functionName: "asset" }),
        publicClient.readContract({ address, abi: adapterAbi, functionName: "authority" }),
      ]);
      ctx.adapters[label] = { address, asset, authority };

      if (addresses.quote && !sameAddress(asset, addresses.quote)) {
        issues.push(`${label}.asset=${asset} != quote=${addresses.quote}`);
      }
      if (!sameAddress(authority, module)) {
        issues.push(`${label}.authority=${authority} != module=${module}`);
      }

      // Loop adapters expose `collateralToken()`; lend adapters only via `marketParams()`.
      try {
        const collateral = await publicClient.readContract({
          address,
          abi: adapterAbi,
          functionName: "collateralToken",
        });
        ctx.adapters[label].collateralToken = collateral;
        if (addresses.equity && !sameAddress(collateral, addresses.equity)) {
          issues.push(`${label}.collateralToken=${collateral} != equity=${addresses.equity}`);
        }
      } catch {
        // Not a loop adapter; `market-params` covers the lend market's collateral.
      }
    }

    return {
      ok: issues.length === 0,
      detail: issues.length === 0 ? `${adapters.map(([l]) => l).join(", ")} wired to ${short(module)}` : issues.join("; "),
    };
  });

  // 11. Market params ------------------------------------------------------
  await run("market-params", async () => {
    const adapters = Object.entries(ctx.adapters ?? {});
    if (adapters.length === 0) return { ok: true, detail: "skipped: no adapters configured" };

    const issues = [];
    ctx.markets = [];
    for (const [label, info] of adapters) {
      const params = await publicClient.readContract({
        address: info.address,
        abi: adapterAbi,
        functionName: "marketParams",
      });
      const lltv = params.lltv;
      if (/^0x0{40}$/i.test(params.loanToken)) issues.push(`${label}: loanToken=0`);
      if (/^0x0{40}$/i.test(params.collateralToken)) issues.push(`${label}: collateralToken=0`);
      if (/^0x0{40}$/i.test(params.oracle)) issues.push(`${label}: oracle=0`);
      if (/^0x0{40}$/i.test(params.irm)) issues.push(`${label}: irm=0`);
      if (lltv <= 0n || lltv > MAX_LLTV) issues.push(`${label}: lltv=${lltv} out of (0,1e18]`);
      if (addresses.quote && !sameAddress(params.loanToken, addresses.quote)) {
        issues.push(`${label}: loanToken=${params.loanToken} != quote=${addresses.quote}`);
      }
      if (addresses.equity && !sameAddress(params.collateralToken, addresses.equity)) {
        issues.push(`${label}: collateralToken=${params.collateralToken} != equity=${addresses.equity}`);
      }

      let morpho = "";
      try {
        morpho = await publicClient.readContract({
          address: info.address,
          abi: adapterAbi,
          functionName: "morpho",
        });
      } catch {
        // Non-Morpho adapter.
      }
      const market = {
        label,
        adapter: info.address,
        marketParams: params,
        marketId: marketIdOf(params),
        morpho,
      };
      ctx.markets.push(market);
    }

    return {
      ok: issues.length === 0,
      detail:
        issues.length === 0
          ? ctx.markets
              .map((m) => `${m.label} id=${short(m.marketId)} lltv=${m.marketParams.lltv}`)
              .join(", ")
          : issues.join("; "),
    };
  });

  // 12. Morpho market ------------------------------------------------------
  await run("morpho-market", async () => {
    const markets = (ctx.markets ?? []).filter((m) => m.morpho && !/^0x0{40}$/i.test(m.morpho));
    if (markets.length === 0) return { ok: true, detail: "skipped: no Morpho adapter configured" };

    let quoteDecimals = 18;
    if (addresses.quote) {
      try {
        quoteDecimals = Number(
          await publicClient.readContract({
            address: addresses.quote,
            abi: erc20Abi,
            functionName: "decimals",
          }),
        );
      } catch {
        quoteDecimals = 18;
      }
    }

    const parts = [];
    let ok = true;
    for (const entry of markets) {
      const market = await publicClient.readContract({
        address: entry.morpho,
        abi: morphoAbi,
        functionName: "market",
        args: [entry.marketId],
      });
      entry.market = market;
      const supply = market.totalSupplyAssets;
      const borrow = market.totalBorrowAssets;
      const available = supply > borrow ? supply - borrow : 0n;
      const util = bps(borrow, supply);
      if (supply === 0n) ok = false;
      parts.push(
        `${entry.label} supply=${formatUnits(supply, quoteDecimals)} borrow=${formatUnits(borrow, quoteDecimals)} ` +
          `avail=${formatUnits(available, quoteDecimals)} util=${util}bps`,
      );
    }
    return { ok, detail: parts.join(" | ") };
  });

  // 13. IRM borrow APR -----------------------------------------------------
  await run("irm-borrow-apr", async () => {
    const markets = (ctx.markets ?? []).filter((m) => m.market);
    if (markets.length === 0) return { ok: true, detail: "skipped: no market snapshot" };

    const cap = config.risk.maxBorrowAprBps;
    const parts = [];
    let ok = true;
    for (const entry of markets) {
      const params = entry.marketParams;
      const rate = await publicClient.readContract({
        address: params.irm,
        abi: irmAbi,
        functionName: "borrowRateView",
        args: [params, entry.market],
      });
      const aprBps = annualizeBps(rate);
      entry.borrowAprBps = aprBps;
      if (aprBps > cap) ok = false;
      parts.push(`${entry.label} apr=${formatBps(aprBps)} cap=${formatBps(cap)}`);
    }
    return { ok, detail: parts.join(" | ") };
  });

  // 14. Module adapter config ---------------------------------------------
  await run("module-adapter-config", async () => {
    if (!ctx.module) return { ok: true, detail: "skipped: module unavailable" };

    const expectedLoop = {
      arm: armCfg.loopEnabled,
      usdgAdapter: false,
    };
    const entries = Object.entries(ctx.adapters ?? {});
    if (entries.length === 0) return { ok: true, detail: "skipped: no adapters configured" };

    const issues = [];
    const parts = [];
    for (const [label, info] of entries) {
      const cfg = await publicClient.readContract({
        address: ctx.module,
        abi: moduleAbi,
        functionName: "adapters",
        args: [info.address],
      });
      if (!cfg.enabled) issues.push(`${label}: adapter disabled`);
      if (expectedLoop[label] !== undefined && cfg.isLoop !== expectedLoop[label]) {
        issues.push(`${label}: isLoop=${cfg.isLoop} expected=${expectedLoop[label]}`);
      }
      if (cfg.absoluteCap === 0n) issues.push(`${label}: absoluteCap=0`);
      if (Number(cfg.relativeCapBps) > 10_000) issues.push(`${label}: relativeCapBps>10000`);
      parts.push(
        `${label} enabled=${cfg.enabled} isLoop=${cfg.isLoop} cap=${cfg.absoluteCap}/${cfg.relativeCapBps}bps`,
      );
    }
    return { ok: issues.length === 0, detail: issues.length === 0 ? parts.join(", ") : issues.join("; ") };
  });

  // 15. Controller bounds --------------------------------------------------
  await run("controller-bounds", async () => {
    if (!ctx.controller) return { ok: true, detail: "skipped: controller unavailable" };
    const bounds = await publicClient.readContract({
      address: ctx.controller,
      abi: controllerAbi,
      functionName: "bounds",
    });

    const issues = [];
    if (bounds.maxAllocatePerCall === 0n) issues.push("maxAllocatePerCall=0");
    if (bounds.maxCollateralPerCall === 0n) issues.push("maxCollateralPerCall=0");
    if (bounds.maxBorrowPerCall === 0n) issues.push("maxBorrowPerCall=0");
    if (bounds.maxFundQuotePerCall === 0n) issues.push("maxFundQuotePerCall=0");
    if (bounds.maxFundEquityPerCall === 0n) issues.push("maxFundEquityPerCall=0");

    // Guard params must be inside the controller's clamps or `setGuardParams` reverts.
    for (const { label, params } of ctx.guardParams ?? []) {
      const guardWidth = Number(params.guardTickWidth);
      const baseWidth = Number(params.baseTickWidth);
      if (guardWidth < Number(bounds.minGuardTickWidth) || guardWidth > Number(bounds.maxGuardTickWidth)) {
        issues.push(`${label}: guardTickWidth ${guardWidth} outside [${bounds.minGuardTickWidth},${bounds.maxGuardTickWidth}]`);
      }
      if (baseWidth < Number(bounds.minBaseTickWidth) || baseWidth > Number(bounds.maxBaseTickWidth)) {
        issues.push(`${label}: baseTickWidth ${baseWidth} outside [${bounds.minBaseTickWidth},${bounds.maxBaseTickWidth}]`);
      }
      if (params.guardLiquidity < bounds.minGuardLiquidity || params.guardLiquidity > bounds.maxGuardLiquidity) {
        issues.push(`${label}: guardLiquidity outside bounds`);
      }
      if (params.baseLiquidity < bounds.minBaseLiquidity || params.baseLiquidity > bounds.maxBaseLiquidity) {
        issues.push(`${label}: baseLiquidity outside bounds`);
      }
      if (Number(params.minEvBps) > Number(bounds.maxMinEvBps)) {
        issues.push(`${label}: minEvBps ${params.minEvBps} > max ${bounds.maxMinEvBps}`);
      }
      if (
        Number(params.recheckInterval) < Number(bounds.minRecheckInterval) ||
        Number(params.recheckInterval) > Number(bounds.maxRecheckInterval)
      ) {
        issues.push(`${label}: recheckInterval ${params.recheckInterval} outside bounds`);
      }
      if (Number(params.recheckMaxDeviationBps) > Number(bounds.maxRecheckMaxDeviationBps)) {
        issues.push(`${label}: recheckMaxDeviationBps ${params.recheckMaxDeviationBps} > max`);
      }
      if (Number(params.maxPriceAge) > Number(bounds.maxMaxPriceAge)) {
        issues.push(`${label}: maxPriceAge ${params.maxPriceAge} > max ${bounds.maxMaxPriceAge}`);
      }
    }

    return {
      ok: issues.length === 0,
      detail:
        issues.length === 0
          ? `caps allocate=${bounds.maxAllocatePerCall} collateral=${bounds.maxCollateralPerCall} borrow=${bounds.maxBorrowPerCall}`
          : issues.join("; "),
    };
  });

  // 16. Switch dwell -------------------------------------------------------
  await run("switch-state", async () => {
    if (!ctx.controller) return { ok: true, detail: "skipped: controller unavailable" };
    const [switchDwell, lastSwitchAt] = await Promise.all([
      publicClient.readContract({ address: ctx.controller, abi: controllerAbi, functionName: "switchDwell" }),
      publicClient.readContract({ address: ctx.controller, abi: controllerAbi, functionName: "lastSwitchAt" }),
    ]);
    const dwell = Number(switchDwell);
    const latest = await publicClient.getBlock({ blockTag: "latest" });
    const nextEligible = BigInt(lastSwitchAt) + BigInt(dwell);
    const remaining = nextEligible > latest.timestamp ? nextEligible - latest.timestamp : 0n;
    return {
      ok: dwell > 0,
      detail: `switchDwell=${dwell}s lastSwitchAt=${lastSwitchAt} nextEligibleIn=${remaining}s (confirm=${switchCfg.confirmSeconds}s)`,
    };
  });

  // 17. ETH/USD ------------------------------------------------------------
  await run("eth-usd", async () => {
    const override = config.risk.ethUsd;
    if (!addresses.ethUsdFeed) {
      return override > 0
        ? { ok: true, detail: `override $${override}/ETH (KEEPER_ETH_USD)` }
        : {
            ok: false,
            detail: "no KEEPER_ETH_USD_FEED and KEEPER_ETH_USD=0; gas cost is unpriceable",
          };
    }

    const [decimals, round] = await Promise.all([
      publicClient.readContract({ address: addresses.ethUsdFeed, abi: chainlinkAbi, functionName: "decimals" }),
      publicClient.readContract({ address: addresses.ethUsdFeed, abi: chainlinkAbi, functionName: "latestRoundData" }),
    ]);
    const answer = round.answer;
    if (answer <= 0n) {
      return { ok: false, detail: `feed answer=${answer}` };
    }
    const price = Number(formatUnits(answer, Number(decimals)));
    const latest = await publicClient.getBlock({ blockTag: "latest" });
    const age = latest.timestamp > round.updatedAt ? latest.timestamp - round.updatedAt : 0n;
    const fresh = age <= BigInt(ETH_USD_MAX_STALENESS_SECONDS);
    return {
      ok: fresh,
      detail: `$${price}/ETH age=${age}s${override > 0 ? ` override=$${override}` : ""}`,
    };
  });

  const fatal = checks.some((c) => !c.ok && FATAL.has(c.name));
  const ok = checks.every((c) => c.ok);
  return { ok, fatal, checks };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  return resolve(entry).toLowerCase() === resolve(self).toLowerCase();
}

async function main() {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`preflight: config error: ${e.message}`);
      process.exitCode = 1;
      return;
    }
    throw e;
  }

  let walletAddress = "";
  const privateKey = process.env.KEEPER_PRIVATE_KEY?.trim();
  if (privateKey) {
    try {
      walletAddress = privateKeyToAccount(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`)
        .address;
    } catch {
      console.error("preflight: KEEPER_PRIVATE_KEY is not a valid key; wallet check skipped");
    }
  }

  const publicClient = createPublicClient({
    transport: http(config.rpc.url, {
      timeout: config.rpc.timeoutMs,
      retryCount: config.rpc.retries,
    }),
  });

  console.log(
    `preflight: chain=${config.rpc.chainId} vault=${config.addresses.vault || "(unset)"} ` +
      `dryRun=${config.preflight.dryRun} strict=${config.preflight.strict}`,
  );

  const result = await runPreflight({ publicClient, config, walletAddress });
  console.log(formatReport(result));
  process.exitCode = result.fatal ? 1 : 0;
}

if (isMain()) {
  main().catch((e) => {
    console.error(`preflight: ${shortError(e)}`);
    process.exitCode = 1;
  });
}
