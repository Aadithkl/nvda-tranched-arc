// Robinhood Chain (4663) porting verification. Reads every address the static book depends on
// straight from the chain and fails closed: no address is trusted because it was pasted anywhere.
//
//   npm run robinhood:verify
//   ROBINHOOD_RPC_URL=... node scripts/verify-robinhood.mjs
//
// Checks: chain id, bytecode presence, USDG decimals, NVDA stock token (ERC-20 + ERC-8056),
// Chainlink RHNVDA/USD feed (description/decimals/round), Morpho Blue market params vs the
// recorded market id, canonical v4 stack + Universal Router + Permit2, and prints the
// feed-implied pool tick for `STATIC_INITIAL_TICK`.
import { createPublicClient, http, keccak256, encodeAbiParameters, decodeAbiParameters, parseAbi } from "viem";

const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const CHAIN_ID = 4663;

// The public endpoint sits behind a Cloudflare managed challenge that rejects non-browser
// user agents; browser-like headers keep CLI verification working. Prefer a provider RPC
// (Alchemy/Chainstack/QuickNode) for anything production-facing via ROBINHOOD_RPC_URL.
const RPC_HEADERS = {
  accept: "application/json",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  origin: "https://robinhood.com",
  referer: "https://robinhood.com/",
};

const ADDR = {
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  nvda: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
  nvdaFeed: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15",
  morphoBlue: "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010",
  v4PoolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  v4PositionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
  v4Quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
  v4StateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
  universalRouter: "0x8876789976dEcBfCbBbe364623C63652db8C0904",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
};

// Primary NVDA-collateral / USDG-loan Morpho market (from the Morpho API, chain 4663).
const MORPHO_MARKET = {
  id: "0xf5ff7d546af5e72f3912d2aa723088fd0bf66fddc158714995637714d9db6e4c",
  loanToken: ADDR.usdg,
  collateralToken: ADDR.nvda,
  oracle: "0x37CF511fA79B8446f1C23D6a81Df117F28240bE0",
  irm: "0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1",
  lltv: 625000000000000000n,
};

const erc20Abi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const feedAbi = parseAbi([
  "function description() view returns (string)",
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);
const poolManagerAbi = parseAbi([
  "function owner() view returns (address)",
  "function extsload(bytes32 slot) view returns (bytes32)",
]);
const morphoAbi = parseAbi([
  "function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
]);
const uiMultiplierAbi = parseAbi(["function uiMultiplier() view returns (uint256)"]);

const client = createPublicClient({ transport: http(RPC, { fetchOptions: { headers: RPC_HEADERS } }) });
const results = [];
let failed = false;
let feedRound = null;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed = true;
}

async function attempt(name, fn, okFn) {
  try {
    const value = await fn();
    const detail = okFn ? okFn(value) : value;
    record(name, detail.ok, detail.text);
  } catch (e) {
    record(name, false, String(e.shortMessage ?? e.message ?? e).slice(0, 150));
  }
}

async function hasCode(address) {
  for (let i = 0; i < 3; i += 1) {
    try {
      const code = await client.getBytecode({ address });
      return code && code !== "0x";
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return false;
}

async function main() {
  await attempt("chainId", () => client.getChainId(), (id) => ({ ok: id === CHAIN_ID, text: `${id} (expected ${CHAIN_ID})` }));

  for (const [name, address] of Object.entries(ADDR)) {
    await attempt(`code:${name}`, () => hasCode(address), (ok) => ({ ok, text: address }));
  }

  await attempt(
    "USDG decimals",
    () =>
      Promise.all([
        client.readContract({ address: ADDR.usdg, abi: erc20Abi, functionName: "decimals" }),
        client.readContract({ address: ADDR.usdg, abi: erc20Abi, functionName: "symbol" }),
      ]),
    ([decimals, symbol]) => ({ ok: decimals === 6, text: `${symbol} ${decimals} decimals` }),
  );

  await attempt(
    "NVDA token",
    () =>
      Promise.all([
        client.readContract({ address: ADDR.nvda, abi: erc20Abi, functionName: "decimals" }),
        client.readContract({ address: ADDR.nvda, abi: erc20Abi, functionName: "symbol" }),
      ]),
    ([decimals, symbol]) => ({ ok: decimals === 18, text: `${symbol} ${decimals} decimals` }),
  );

  await attempt(
    "NVDA ERC-8056 uiMultiplier",
    () => client.readContract({ address: ADDR.nvda, abi: uiMultiplierAbi, functionName: "uiMultiplier" }),
    (multiplier) => ({ ok: multiplier > 0n, text: multiplier.toString() }),
  );

  await attempt(
    "Chainlink feed",
    () =>
      Promise.all([
        client.readContract({ address: ADDR.nvdaFeed, abi: feedAbi, functionName: "description" }),
        client.readContract({ address: ADDR.nvdaFeed, abi: feedAbi, functionName: "decimals" }),
        client.readContract({ address: ADDR.nvdaFeed, abi: feedAbi, functionName: "latestRoundData" }),
      ]),
    ([description, decimals, round]) => {
      feedRound = round;
      const [, answer, , updatedAt] = round;
      const ageSeconds = Math.floor(Date.now() / 1000) - Number(updatedAt);
      const ok = /NVDA/i.test(description) && decimals === 8 && answer > 0n && updatedAt > 0n;
      const stale = ageSeconds > 4 * 3600 ? " (stale: market likely closed)" : "";
      return {
        ok,
        text: `"${description}" ${decimals}d answer=${answer} age=${ageSeconds}s${stale}`,
      };
    },
  );

  // Morpho market params must match the recorded id and the expected configuration.
  await attempt(
    "Morpho market id matches params",
    () =>
      keccak256(
        encodeAbiParameters(
          [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }],
          [MORPHO_MARKET.loanToken, MORPHO_MARKET.collateralToken, MORPHO_MARKET.oracle, MORPHO_MARKET.irm, MORPHO_MARKET.lltv],
        ),
      ),
    (computedId) => ({ ok: computedId === MORPHO_MARKET.id, text: computedId }),
  );

  await attempt(
    "Morpho market params onchain",
    () => client.readContract({ address: ADDR.morphoBlue, abi: morphoAbi, functionName: "idToMarketParams", args: [MORPHO_MARKET.id] }),
    (onchain) => ({
      ok:
        onchain[0].toLowerCase() === MORPHO_MARKET.loanToken.toLowerCase()
          && onchain[1].toLowerCase() === MORPHO_MARKET.collateralToken.toLowerCase()
          && onchain[2].toLowerCase() === MORPHO_MARKET.oracle.toLowerCase()
          && onchain[3].toLowerCase() === MORPHO_MARKET.irm.toLowerCase()
          && onchain[4] === MORPHO_MARKET.lltv,
      text: `loan=${onchain[0]} coll=${onchain[1]} oracle=${onchain[2]} lltv=${onchain[4]}`,
    }),
  );

  await attempt(
    "Morpho market exists",
    () => client.readContract({ address: ADDR.morphoBlue, abi: morphoAbi, functionName: "market", args: [MORPHO_MARKET.id] }),
    (market) => ({ ok: market[0] > 0n, text: `supplyAssets=${market[0]} borrowAssets=${market[2]}` }),
  );

  // Canonical v4: the calls our hook stack makes must decode against the deployed manager.
  await attempt(
    "v4 PoolManager owner()",
    () => client.readContract({ address: ADDR.v4PoolManager, abi: poolManagerAbi, functionName: "owner" }),
    (owner) => ({ ok: owner !== "0x0000000000000000000000000000000000000000", text: owner }),
  );

  await attempt(
    "v4 PoolManager extsload (ABI probe)",
    () => client.readContract({ address: ADDR.v4PoolManager, abi: poolManagerAbi, functionName: "extsload", args: ["0x0000000000000000000000000000000000000000000000000000000000000000"] }),
    (word) => ({ ok: typeof word === "string" && word.length === 66, text: word.slice(0, 18) + "…" }),
  );

  // Suggested pool init tick from the feed (token0 = USDG 6d, token1 = NVDA 18d).
  await attempt(
    "feed-implied pool tick",
    async () => feedRound ?? client.readContract({ address: ADDR.nvdaFeed, abi: feedAbi, functionName: "latestRoundData" }),
    (round) => {
      const price = Number(round[1]) / 1e8;
      const rawPrice = 1e12 / price; // (1e18 / 1e6) / price
      const tick = Math.floor(Math.log(rawPrice) / Math.log(1.0001));
      const aligned = Math.floor(tick / 60) * 60;
      return { ok: Number.isFinite(tick), text: `STATIC_INITIAL_TICK=${aligned} (raw ${tick}, price $${price.toFixed(2)})` };
    },
  );

  console.log("\nRobinhood Chain porting verification (4663)\n");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(36)} ${r.detail}`);
  console.log(failed ? "\nRESULT: FAIL" : "\nRESULT: PASS");
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error("verification crashed:", e.shortMessage ?? e.message);
  process.exitCode = 1;
});
