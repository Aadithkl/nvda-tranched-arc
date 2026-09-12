import { encodeFunctionData, formatUnits, maxUint256, parseAbi, parseUnits, type Abi, type Address, type Hex } from "viem";
import {
  ADDR,
  abis,
  CLIENT_KEY,
  explorerAddr,
  explorerTx,
  fmtEquity,
  fmtPrice8,
  fmtShares,
  fmtUsdc,
  manifest,
  MARKET_STATUS,
  publicClient,
  QUOTE_STATE,
  shortAddr,
  testTokenAbi,
  usdcPool,
} from "./config";
import { connectInjected, connectPasskey, type Call, type Session } from "./wallet";

/* ─────────── helpers ─────────── */

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const set = (id: string, text: string) => {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
};
const shortHash = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

function toast(msg: string, icon = "✓") {
  const box = document.getElementById("toasts");
  if (!box) return;
  const t = document.createElement("div");
  t.className = "toast";
  t.innerHTML =
    `<span style="background:#FF4D00;border-radius:8px;width:24px;height:24px;display:flex;align-items:center;` +
    `justify-content:center;flex-shrink:0;font-size:13px;">${icon}</span><span>${msg}</span>`;
  box.appendChild(t);
  setTimeout(() => {
    t.classList.add("out");
    setTimeout(() => t.remove(), 320);
  }, 4600);
}

async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

async function readContract<T = unknown>(
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[] = [],
): Promise<T> {
  return (await publicClient.readContract({ address, abi, functionName, args } as never)) as T;
}

async function run(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error) {
    const message = (error as Error)?.message ?? String(error);
    toast(`<b>${label}</b> — ${message.slice(0, 160)}`, "⛔");
  }
}

/* ─────────── minimal ABIs (avoid overload ambiguity) ─────────── */

const vaultAbi = parseAbi([
  "function depositUSDC(uint256 usdcAmount, address receiver) returns (uint256)",
  "function requestRedeem(uint256 shares, address controller, address owner) returns (uint256)",
  "function pendingRedeemRequest(uint256 requestId, address controller) view returns (uint256)",
  "function claimableRedeemRequest(uint256 requestId, address controller) view returns (uint256)",
  "function claimAndUnwrapUSDC(uint256 shares, address receiver, address ownerOrController) returns (uint256)",
  "function claimAndUnwrapEquity(uint256 shares, address receiver, address ownerOrController) returns (uint256)",
  "function claimAndUnwrapProportional(uint256 shares, address receiver, address ownerOrController) returns (uint256, uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function maxDeposit(address receiver) view returns (uint256)",
  "function depositsPaused() view returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
]);

const routerSwapAbi = parseAbi([
  "function swapExactIn((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, bool zeroForOne, uint256 amountIn, uint256 minAmountOut, address recipient, bytes hookData) returns (int256)",
]);

const metaAbi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

const boundsLegacyAbi = parseAbi([
  "function bounds() view returns (uint24, uint24, uint16, uint16, uint32, uint32, uint128)",
]);

/* ─────────── wallet ─────────── */

let session: Session | null = null;
let currentPage = "vaults";

function renderWallet() {
  const pill = $("walletPill");
  const btn = $("connectBtn");
  const info = $("walletInfo");
  if (session) {
    pill.textContent = `${shortAddr(session.address)} · ${session.kind === "passkey" ? "passkey" : "browser"}`;
    pill.classList.remove("hidden");
    btn.textContent = shortAddr(session.address);
    info.classList.remove("hidden");
    set("wmAddr", session.address);
    set("wmKind", session.kind === "passkey" ? "Circle passkey (gasless)" : "Browser wallet");
  } else {
    pill.classList.add("hidden");
    btn.textContent = "Connect";
    info.classList.add("hidden");
  }
}

function showMenu(show: boolean) {
  $("walletMenu").classList.toggle("hidden", !show);
}

(window as never as Record<string, unknown>).connectInjectedWallet = () =>
  run("connect wallet", async () => {
    session = await connectInjected();
    renderWallet();
    showMenu(false);
    toast(`Connected <b>${shortAddr(session.address)}</b>`, "👛");
    await refresh();
  });

(window as never as Record<string, unknown>).connectPasskeyWallet = (mode: "register" | "login") =>
  run("connect passkey", async () => {
    const username = ($("wmUsername") as HTMLInputElement).value;
    session = await connectPasskey(username, mode);
    renderWallet();
    showMenu(false);
    toast(`Passkey wallet <b>${shortAddr(session.address)}</b> ready`, "🔑");
    await refresh();
  });

(window as never as Record<string, unknown>).disconnectWallet = () => {
  session = null;
  renderWallet();
  showMenu(false);
  toast("Wallet disconnected", "👛");
};

/* ─────────── router ─────────── */

(window as never as Record<string, unknown>).showPage = (id: string) => {
  currentPage = id;
  if (location.hash !== `#${id}`) history.replaceState(null, "", `#${id}`);
  document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
  document.getElementById(`page-${id}`)?.classList.add("active");
  document.querySelectorAll(".nav-link").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(`[data-page="${id}"]`).forEach((b) => b.classList.add("active"));
  $("mobileMenu").classList.add("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
  refresh().catch(() => undefined);
};

/* ─────────── vaults ─────────── */

type Side = "senior" | "junior";
const vaultAddr = (side: Side): Address | null => (side === "senior" ? ADDR.seniorVault : ADDR.juniorVault);

let redeemClaimable = 0n;

async function readBalances() {
  const user = session?.address;
  if (!user) {
    set("balUsdc", "—");
    set("balEquity", "—");
    return;
  }
  const usdcBal = await safe(readContract<bigint>(ADDR.usdc, abis.erc20, "balanceOf", [user]), 0n);
  set("balUsdc", fmtUsdc(usdcBal));
  if (ADDR.equity) {
    const eq = await safe(readContract<bigint>(ADDR.equity, abis.erc20, "balanceOf", [user]), 0n);
    set("balEquity", fmtEquity(eq));
  }
}

async function readVaults() {
  const user = session?.address;
  for (const side of ["senior", "junior"] as const) {
    const addr = vaultAddr(side);
    if (!addr) continue;
    const prefix = side === "senior" ? "sen" : "jun";
    const paused = await safe(readContract<boolean>(addr, vaultAbi, "depositsPaused"), false);
    const badge = $(`${prefix}Badge`);
    if (badge) {
      badge.textContent = paused ? "PAUSED" : side === "senior" ? "OPEN" : "OPEN · 2×";
      if (side === "senior") badge.className = `badge ${paused ? "badge-stale" : "badge-live"}`;
    }
    if (!user) {
      set(`${prefix}Shares`, "—");
      set(`${prefix}Claim`, "—");
      set(`${prefix}Max`, paused ? "paused" : "—");
      set(`${prefix}Paused`, paused ? "yes" : "no");
      continue;
    }
    const shares = await safe(readContract<bigint>(addr, vaultAbi, "balanceOf", [user]), 0n);
    const claim =
      shares > 0n ? await safe(readContract<bigint>(addr, vaultAbi, "convertToAssets", [shares]), 0n) : 0n;
    const maxDep = await safe(readContract<bigint>(addr, vaultAbi, "maxDeposit", [user]), 0n);
    set(`${prefix}Shares`, fmtShares(shares));
    set(`${prefix}Claim`, `$${fmtUsdc(claim)}`);
    set(`${prefix}Max`, `${fmtUsdc(maxDep)} USDC`);
    set(`${prefix}Paused`, paused ? "yes" : "no");
  }
}

async function readRedeem() {
  const side = ($("redVault") as HTMLSelectElement).value as Side;
  const addr = vaultAddr(side);
  const user = session?.address;
  const buttons = ["redRequest", "redClaimUsdc", "redClaimEquity", "redClaimProp"] as const;
  if (!addr || !user) {
    redeemClaimable = 0n;
    set("redPending", "—");
    set("redClaimable", "—");
    buttons.forEach((id) => (($(id) as HTMLButtonElement).disabled = true));
    return;
  }
  const [pending, claimable] = await Promise.all([
    safe(readContract<bigint>(addr, vaultAbi, "pendingRedeemRequest", [0n, user]), 0n),
    safe(readContract<bigint>(addr, vaultAbi, "claimableRedeemRequest", [0n, user]), 0n),
  ]);
  redeemClaimable = claimable;
  set("redPending", `${fmtShares(pending, 6)} shares`);
  set("redClaimable", `${fmtShares(claimable, 6)} shares`);
  $("redRequest").toggleAttribute("disabled", false);
  $("redClaimUsdc").toggleAttribute("disabled", claimable <= 0n);
  $("redClaimEquity").toggleAttribute("disabled", claimable <= 0n || side === "senior");
  $("redClaimProp").toggleAttribute("disabled", claimable <= 0n || side === "senior");
  const keeper = await safe(readContract<Address>(ADDR.accountant as Address, abis.accountant, "keeper"), null as never);
  set("redKeeperAddr", keeper ? shortAddr(keeper) : "—");
  const isKeeper = keeper && session && keeper.toLowerCase() === session.address.toLowerCase();
  ($("redKeeper") as HTMLButtonElement).disabled = !isKeeper;
}

async function deposit(side: Side) {
  await run(`deposit ${side}`, async () => {
    if (!session) throw new Error("connect a wallet first");
    const addr = vaultAddr(side);
    if (!addr) throw new Error("vault not deployed");
    const input = $(side === "senior" ? "senAmt" : "junAmt") as HTMLInputElement;
    const amount = parseUnits(input.value || "0", 6);
    if (amount <= 0n) throw new Error("enter an amount");
    const button = $(side === "senior" ? "senDeposit" : "junDeposit") as HTMLButtonElement;
    button.disabled = true;
    try {
      const calls: Call[] = [];
      const allowance = await safe(
        readContract<bigint>(ADDR.usdc, abis.erc20, "allowance", [session.address, addr]),
        0n,
      );
      if (allowance < amount) {
        calls.push({
          to: ADDR.usdc,
          data: encodeFunctionData({ abi: abis.erc20, functionName: "approve", args: [addr, maxUint256] }),
        });
      }
      calls.push({
        to: addr,
        data: encodeFunctionData({ abi: vaultAbi, functionName: "depositUSDC", args: [amount, session.address] }),
      });
      toast(`Submitting ${side} deposit…`, "⏳");
      const hashes = await session.sendCalls(calls);
      const tx = hashes[hashes.length - 1];
      toast(`<b>${side} deposit confirmed</b> · <a href="${explorerTx(tx)}" target="_blank" rel="noreferrer">${shortHash(tx)}</a>`, "💰");
      await refresh();
    } finally {
      button.disabled = false;
    }
  });
}

async function requestRedeem() {
  await run("requestRedeem", async () => {
    if (!session) throw new Error("connect a wallet first");
    const side = ($("redVault") as HTMLSelectElement).value as Side;
    const addr = vaultAddr(side);
    if (!addr) throw new Error("vault not deployed");
    const shares = parseUnits(($("redAmt") as HTMLInputElement).value || "0", 18);
    if (shares <= 0n) throw new Error("enter shares");
    const hash = (
      await session.sendCalls([
        {
          to: addr,
          data: encodeFunctionData({ abi: vaultAbi, functionName: "requestRedeem", args: [shares, session.address, session.address] }),
        },
      ])
    )[0];
    toast(`Redeem requested · <a href="${explorerTx(hash)}" target="_blank" rel="noreferrer">${shortHash(hash)}</a>`, "↩");
    await refresh();
  });
}

async function claim(kind: "usdc" | "equity" | "proportional") {
  await run("claim", async () => {
    if (!session) throw new Error("connect a wallet first");
    const side = ($("redVault") as HTMLSelectElement).value as Side;
    const addr = vaultAddr(side);
    if (!addr) throw new Error("vault not deployed");
    if (redeemClaimable <= 0n) throw new Error("nothing claimable yet — keeper must fulfill first");
    if (side === "senior" && kind !== "usdc") throw new Error("SeniorUsdcOnly — senior exits are USDC-only");
    const fn =
      kind === "usdc" ? "claimAndUnwrapUSDC" : kind === "equity" ? "claimAndUnwrapEquity" : "claimAndUnwrapProportional";
    const hash = (
      await session.sendCalls([
        {
          to: addr,
          data: encodeFunctionData({ abi: vaultAbi, functionName: fn, args: [redeemClaimable, session.address, session.address] }),
        },
      ])
    )[0];
    toast(`Claimed (${kind}) · <a href="${explorerTx(hash)}" target="_blank" rel="noreferrer">${shortHash(hash)}</a>`, "💸");
    await refresh();
  });
}

async function keeperFulfill() {
  await run("fulfillRedeem", async () => {
    if (!session) throw new Error("connect a wallet first");
    const side = ($("redVault") as HTMLSelectElement).value as Side;
    if (!ADDR.accountant) throw new Error("accountant not deployed");
    const hash = (
      await session.sendCalls([
        {
          to: ADDR.accountant,
          data: encodeFunctionData({
            abi: abis.accountant,
            functionName: "fulfillRedeem",
            args: [side === "senior", session.address],
          }),
        },
      ])
    )[0];
    toast(`Keeper fulfilled · <a href="${explorerTx(hash)}" target="_blank" rel="noreferrer">${shortHash(hash)}</a>`, "🤖");
    await refresh();
  });
}

async function mintEquity() {
  await run("faucet", async () => {
    if (!session) throw new Error("connect a wallet first");
    if (!ADDR.equity) throw new Error("equity token not configured");
    const hash = (
      await session.sendCalls([
        {
          to: ADDR.equity,
          data: encodeFunctionData({ abi: testTokenAbi, functionName: "mint", args: [session.address, parseUnits("100", 18)] }),
        },
      ])
    )[0];
    toast(`Minted 100 mNVDA · <a href="${explorerTx(hash)}" target="_blank" rel="noreferrer">${shortHash(hash)}</a>`, "🚰");
    await refresh();
  });
}

/* ─────────── oracle ─────────── */

let oracleCache: { updatedAt: number; maxStaleness: number; valid: boolean } | null = null;

async function readOracle() {
  try {
    const p = (await readContract<Record<string, unknown>>(ADDR.oracle, abis.oracle, "getPrice")) as {
      mid: bigint;
      bid: bigint;
      ask: bigint;
      marketStatus: number;
      session: number;
      sourceTimestamp: number;
      updatedAt: bigint;
      paymentRef: Hex;
      valid: boolean;
    };
    const maxStaleness = await safe(readContract<number>(ADDR.oracle, abis.oracle, "maxStaleness"), 300);
    oracleCache = { updatedAt: Number(p.updatedAt), maxStaleness, valid: p.valid };
    set("orPrice", `$${fmtPrice8(p.mid)}`);
    set("orBid", `$${fmtPrice8(p.bid)}`);
    set("orAsk", `$${fmtPrice8(p.ask)}`);
    set("orSession", String(p.session));
    set("orStatus", MARKET_STATUS[Number(p.marketStatus)] ?? `status ${p.marketStatus}`);
    set("orUpdated", new Date(Number(p.updatedAt) * 1000).toLocaleString());
    set("orSrcTs", new Date(Number(p.sourceTimestamp) * 1000).toLocaleString());
    set("orRef", p.paymentRef === `0x${"0".repeat(64)}` ? "—" : `${p.paymentRef.slice(0, 10)}…${p.paymentRef.slice(-6)}`);
    set("orStaleness", `${maxStaleness}s`);
    set("orWriter", manifest.oracle.writer ? shortAddr(manifest.oracle.writer) : "—");
    const validBadge = $("orValid");
    validBadge.className = `badge ${p.valid ? "badge-live" : "badge-stale"}`;
    validBadge.innerHTML = p.valid
      ? `<span class="pulse-dot inline-block w-1.5 h-1.5 rounded-full bg-current"></span>LIVE`
      : "STALE / CLOSED";
    const risk = $("orRisk");
    risk.textContent = p.valid ? "RISK ALLOWED" : "RISK BLOCKED";
    risk.style.background = p.valid ? "#059669" : "#DC2626";
    const chip = $("chipOracle");
    chip.className = `badge ${p.valid ? "badge-live" : "badge-stale"}`;
    chip.textContent = p.valid ? `live · $${fmtPrice8(p.mid)}` : `stale · ${MARKET_STATUS[Number(p.marketStatus)] ?? "?"}`;
    tickFreshness();
  } catch {
    set("orPrice", "unavailable");
    const chip = $("chipOracle");
    chip.className = "badge badge-stale";
    chip.textContent = "rpc error";
  }
}

function tickFreshness() {
  if (!oracleCache) return;
  const now = Math.floor(Date.now() / 1000);
  const remaining = oracleCache.updatedAt + oracleCache.maxStaleness - now;
  const pct = Math.max(0, Math.min(100, (remaining / oracleCache.maxStaleness) * 100));
  set("orFresh", remaining > 0 ? `${remaining}s left` : `stale by ${-remaining}s`);
  const bar = $("orFreshBar");
  bar.style.width = `${pct}%`;
  bar.style.background = remaining > oracleCache.maxStaleness * 0.3 ? "#059669" : remaining > 0 ? "#D97706" : "#DC2626";
}

/* ─────────── swap ─────────── */

type SwapDirection = "usdc-in" | "equity-in";
let swapDirection: SwapDirection = "usdc-in";
let swapSymbols = { usdc: "USDC", equity: "mNVDA" };
let swapDecimals = { usdc: 6, equity: 18 };
let swapQuoteOut = 0n;

const poolKey = usdcPool?.key as
  | { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }
  | undefined;

function swapTokenIn(): Address {
  return swapDirection === "usdc-in" ? ADDR.usdc : (ADDR.equity as Address);
}
function swapTokenOut(): Address {
  return swapDirection === "usdc-in" ? (ADDR.equity as Address) : ADDR.usdc;
}
const isUsdc0 = () =>
  !!poolKey && poolKey.currency0.toLowerCase() === ADDR.usdc.toLowerCase();
const zeroForOne = () => (isUsdc0() ? swapDirection === "usdc-in" : swapDirection === "equity-in");

async function initSwap() {
  if (!usdcPool || !poolKey || !ADDR.equity) {
    $("swapEmpty").classList.remove("hidden");
    $("swapBody").classList.add("hidden");
    return;
  }
  $("swapEmpty").classList.add("hidden");
  $("swapBody").classList.remove("hidden");

  const [usdcSym, eqSym, usdcDec, eqDec] = await Promise.all([
    safe(readContract<string>(ADDR.usdc, metaAbi, "symbol"), "USDC"),
    safe(readContract<string>(ADDR.equity, metaAbi, "symbol"), "NVDA"),
    safe(readContract<number>(ADDR.usdc, metaAbi, "decimals"), 6),
    safe(readContract<number>(ADDR.equity, metaAbi, "decimals"), 18),
  ]);
  swapSymbols = { usdc: usdcSym, equity: eqSym };
  swapDecimals = { usdc: Number(usdcDec), equity: Number(eqDec) };
  set("swapPair", `${usdcSym} / ${eqSym}`);
  set("swapFee", `${poolKey.fee / 10000}%`);
  set("swapTs", String(poolKey.tickSpacing));
  set("swapHooks", poolKey.hooks === "0x0000000000000000000000000000000000000000" ? "none" : shortAddr(poolKey.hooks));
  set("swapPoolId", `${usdcPool.poolId.slice(0, 10)}…${usdcPool.poolId.slice(-6)}`);
  set("swapC0", shortAddr(poolKey.currency0));
  set("swapC1", shortAddr(poolKey.currency1));
  updateSwapLabels();
  await refreshSwap();
}

function updateSwapLabels() {
  set("swapInSym", swapDirection === "usdc-in" ? swapSymbols.usdc : swapSymbols.equity);
  set("swapOutSym", swapDirection === "usdc-in" ? swapSymbols.equity : swapSymbols.usdc);
  set("swapDir", swapDirection === "usdc-in" ? `${swapSymbols.usdc} → ${swapSymbols.equity}` : `${swapSymbols.equity} → ${swapSymbols.usdc}`);
}

async function refreshSwap() {
  if (!usdcPool || !poolKey) return;
  const [sqrtPriceX96, tick, , lpFee] = await safe(
    readContract<[bigint, number, number, number]>(ADDR.stateView, abis.stateView, "getSlot0", [usdcPool.poolId]),
    [0n, 0, 0, 0] as [bigint, number, number, number],
  );
  const liquidity = await safe(
    readContract<bigint>(ADDR.stateView, abis.stateView, "getLiquidity", [usdcPool.poolId]),
    0n,
  );
  set("swapTick", String(tick));
  set("swapLiq", liquidity > 0n ? `$${(Number(liquidity) / 1e12).toFixed(2)}M` : "—");
  set("swapPoolBadge", liquidity > 0n ? "INITIALIZED" : "EMPTY");
  if (Number(sqrtPriceX96) > 0) {
    const nvdaIsToken0 = poolKey.currency0.toLowerCase() === (ADDR.equity as Address).toLowerCase();
    const dec0 = nvdaIsToken0 ? swapDecimals.equity : swapDecimals.usdc;
    const dec1 = nvdaIsToken0 ? swapDecimals.usdc : swapDecimals.equity;
    const human = 1.0001 ** Number(tick) * 10 ** (dec0 - dec1);
    const usdPerNvda = nvdaIsToken0 ? human : 1 / human;
    set("swapPrice", `$${usdPerNvda.toFixed(2)} / ${swapSymbols.equity}`);
  }
  const user = session?.address;
  if (user) {
    const bal = await safe(readContract<bigint>(swapTokenIn(), abis.erc20, "balanceOf", [user]), 0n);
    const dec = swapDirection === "usdc-in" ? swapDecimals.usdc : swapDecimals.equity;
    set("swapBalIn", `${formatUnits(bal, dec)} ${swapDirection === "usdc-in" ? swapSymbols.usdc : swapSymbols.equity}`);
  } else {
    set("swapBalIn", "—");
  }
  await updateSwapQuote();
}

async function updateSwapQuote() {
  if (!usdcPool || !poolKey || !ADDR.equity) return;
  const input = ($("swapAmt") as HTMLInputElement).value || "0";
  const decIn = swapDirection === "usdc-in" ? swapDecimals.usdc : swapDecimals.equity;
  const decOut = swapDirection === "usdc-in" ? swapDecimals.equity : swapDecimals.usdc;
  let amountIn: bigint;
  try {
    amountIn = parseUnits(input, decIn);
  } catch {
    set("swapQuoteOut", "—");
    return;
  }
  if (amountIn <= 0n) {
    swapQuoteOut = 0n;
    set("swapQuoteOut", "—");
    return;
  }
  try {
    const result = await readContract<[bigint, bigint]>(ADDR.v4Quoter, abis.quoter, "quoteExactInputSingle", [
      { poolKey, zeroForOne: zeroForOne(), exactAmount: amountIn, hookData: "0x" },
    ]);
    swapQuoteOut = result[0];
    set("swapQuoteOut", formatUnits(result[0], decOut));
    set("swapQuoteWarn", "");
  } catch {
    swapQuoteOut = 0n;
    set("swapQuoteOut", "quote unavailable");
    set("swapQuoteWarn", "pool may lack liquidity for this size");
  }
}

async function executeSwap() {
  await run("swap", async () => {
    if (!session) throw new Error("connect a wallet first");
    if (!usdcPool || !poolKey) throw new Error("venue pool not available");
    const input = ($("swapAmt") as HTMLInputElement).value || "0";
    const decIn = swapDirection === "usdc-in" ? swapDecimals.usdc : swapDecimals.equity;
    const amountIn = parseUnits(input, decIn);
    if (amountIn <= 0n) throw new Error("enter an amount");
    if (swapQuoteOut <= 0n) throw new Error("no quote — try a smaller amount");
    const slippage = BigInt(($("swapSlip") as HTMLSelectElement).value);
    const minOut = (swapQuoteOut * (10000n - slippage)) / 10000n;
    const tokenIn = swapTokenIn();
    const calls: Call[] = [];
    const allowance = await safe(
      readContract<bigint>(tokenIn, abis.erc20, "allowance", [session.address, ADDR.demoRouter]),
      0n,
    );
    if (allowance < amountIn) {
      calls.push({
        to: tokenIn,
        data: encodeFunctionData({ abi: abis.erc20, functionName: "approve", args: [ADDR.demoRouter, maxUint256] }),
      });
    }
    calls.push({
      to: ADDR.demoRouter,
      data: encodeFunctionData({
        abi: routerSwapAbi,
        functionName: "swapExactIn",
        args: [poolKey, zeroForOne(), amountIn, minOut, session.address, "0x"],
      }),
    });
    toast("Submitting swap…", "⏳");
    const hashes = await session.sendCalls(calls);
    const tx = hashes[hashes.length - 1];
    toast(`<b>Swap confirmed</b> · <a href="${explorerTx(tx)}" target="_blank" rel="noreferrer">${shortHash(tx)}</a>`, "⚡");
    await refresh();
  });
}

/* ─────────── strategy ─────────── */

async function readQuoteChip() {
  if (!ADDR.hook) return;
  const state = await safe(readContract<number>(ADDR.hook, abis.hook, "quoteState"), 0);
  const chip = $("chipQuote");
  const label = QUOTE_STATE[Number(state)] ?? String(state);
  chip.className = `badge ${Number(state) === 2 ? "badge-live" : Number(state) === 1 ? "badge-warn" : "badge-stale"}`;
  chip.textContent = label;
}

async function readStrategy() {
  if (ADDR.hook) {
    const state = await safe(readContract<number>(ADDR.hook, abis.hook, "quoteState"), 0);
    const preview =
      Number(state) === 0
        ? null
        : await safe(
            readContract<[number, boolean, number, number]>(ADDR.hook, abis.hook, "previewQuote", [true]),
            null,
          );
    const [maxDeploy, riskBudget, jit, managed, paused, params] = await Promise.all([
      safe(readContract<bigint>(ADDR.hook, abis.hook, "effectiveMaxDeploy"), 0n),
      safe(readContract<bigint>(ADDR.hook, abis.hook, "riskBudget"), 0n),
      safe(readContract<[boolean, boolean, number, number, bigint]>(ADDR.hook, abis.hook, "jitsState"), [false, false, 0, 0, 0n] as [boolean, boolean, number, number, bigint]),
      safe(readContract<bigint>(ADDR.hook, abis.hook, "totalManagedAssets"), 0n),
      safe(readContract<boolean>(ADDR.hook, abis.hook, "paused"), false),
      safe(readContract<Record<string, unknown>>(ADDR.hook, abis.hook, "params"), {} as Record<string, unknown>),
    ]);
    const quoteBadge = $("stQuote");
    const label = QUOTE_STATE[Number(state)] ?? String(state);
    quoteBadge.className = `badge ${Number(state) === 2 ? "badge-live" : Number(state) === 1 ? "badge-warn" : "badge-stale"}`;
    quoteBadge.textContent = label;
    set(
      "stPreview",
      preview ? `fee ${preview[0]} · toxic ${preview[1] ? "yes" : "no"} · dev ${preview[2]} bps` : "quoting off (rest)",
    );
    set("stMaxDeploy", `$${fmtUsdc(maxDeploy)}`);
    set("stRiskBudget", `$${fmtUsdc(riskBudget)}`);
    set("stJit", jit[0] ? `active · ticks ${jit[2]}…${jit[3]} · liq ${jit[4].toString()}` : "idle");
    set("stManaged", `$${fmtUsdc(managed)}`);
    set("stPaused", paused ? "yes" : "no");
    const p = params ?? {};
    set(
      "stParams",
      `base ${p.baseFee ?? "?"} · surge ${p.maxSurgeFee ?? "?"} · ttl ${p.ttl ?? "?"}s · quoting ${p.quotingEnabled ? "on" : "off"}`,
    );
  }

  if (ADDR.accountant) {
    const [senior, junior, claimS, claimJ, escrow, escrowBps, poolValue, effPool, lastRebal] = await Promise.all([
      safe(readContract<bigint>(ADDR.accountant, abis.accountant, "seniorClaim"), 0n),
      safe(readContract<bigint>(ADDR.accountant, abis.accountant, "juniorClaim"), 0n),
      safe(readContract<bigint>(ADDR.accountant, abis.accountant, "claimableSenior"), 0n),
      safe(readContract<bigint>(ADDR.accountant, abis.accountant, "claimableJunior"), 0n),
      safe(readContract<boolean>(ADDR.accountant, abis.accountant, "escrowFunded"), false),
      safe(readContract<number>(ADDR.accountant, abis.accountant, "escrowBps"), 0),
      safe(readContract<bigint>(ADDR.accountant, abis.accountant, "poolValue"), 0n),
      safe(readContract<bigint>(ADDR.accountant, abis.accountant, "effectivePool"), 0n),
      safe(readContract<bigint>(ADDR.accountant, abis.accountant, "lastRebalanceAt"), 0n),
    ]);
    set("accSenior", `$${fmtUsdc(senior)}`);
    set("accJunior", `$${fmtUsdc(junior)}`);
    set("accClaimS", `$${fmtUsdc(claimS)}`);
    set("accClaimJ", `$${fmtUsdc(claimJ)}`);
    set("accEscrow", escrow ? "true ✓" : "false");
    set("accEscrowBps", `${escrowBps} bps`);
    set("accPool", `$${fmtUsdc(poolValue)}`);
    set("accEffPool", `$${fmtUsdc(effPool)}`);
    set("accLastRebal", lastRebal > 0n ? new Date(Number(lastRebal) * 1000).toLocaleString() : "never");
  }

  if (ADDR.pipe) {
    $("pipeBadge").className = "badge badge-live";
    $("pipeBadge").textContent = "LIVE";
    const [composition, hardCap, fee, slippage, venue] = await Promise.all([
      safe(readContract<[bigint, bigint, number]>(ADDR.pipe, abis.pipe, "assetComposition"), [0n, 0n, 0] as [bigint, bigint, number]),
      safe(readContract<number>(ADDR.pipe, abis.pipe, "hardMaxEquityBps"), 0),
      safe(readContract<number>(ADDR.pipe, abis.pipe, "conversionFeeBps"), 0),
      safe(readContract<number>(ADDR.pipe, abis.pipe, "maxRebalanceSlippageBps"), 0),
      safe(readContract<boolean>(ADDR.pipe, abis.pipe, "rebalanceVenueSet"), false),
    ]);
    set("pipeComposition", `$${fmtUsdc(composition[0])} USDC + $${fmtUsdc(composition[1])} equity (${composition[2]} bps)`);
    set("pipeHardCap", `${hardCap} bps`);
    set("pipeFee", `${fee} bps`);
    set("pipeSlippage", `${slippage} bps`);
    set("pipeVenue", venue ? "yes" : "no");
  } else {
    $("pipeBadge").className = "badge badge-warn";
    $("pipeBadge").textContent = "NOT DEPLOYED";
  }

  if (ADDR.controller) {
    let bounds = await safe(
      readContract<Record<string, bigint | number>>(ADDR.controller, abis.controller, "bounds"),
      null as Record<string, bigint | number> | null,
    );
    if (!bounds) {
      const legacy = await safe(
        readContract<[number, number, number, number, number, number, bigint]>(
          ADDR.controller,
          boundsLegacyAbi,
          "bounds",
        ),
        null,
      );
      if (legacy) {
        bounds = {
          maxBaseFee: legacy[0],
          maxSurgeFee: legacy[1],
          maxDeviationBps: legacy[2],
          maxToxicityMultiplierBps: legacy[3],
          maxTtl: legacy[4],
          maxGracePeriod: legacy[5],
          maxDeployPerSwap: legacy[6],
        };
      }
    }
    const b = bounds ?? {};
    set("ctlBaseFee", String(b.maxBaseFee ?? "—"));
    set("ctlSurgeFee", String(b.maxSurgeFee ?? "—"));
    set("ctlDeviation", `${b.maxDeviationBps ?? "—"} bps`);
    set("ctlTtl", `${b.maxTtl ?? "—"}s`);
    set("ctlGrace", `${b.maxGracePeriod ?? "—"}s`);
    set("ctlDeploy", b.maxDeployPerSwap ? `$${fmtUsdc(BigInt(b.maxDeployPerSwap))}` : "—");
    set("ctlAddr", shortAddr(ADDR.controller));
  }
}

/* ─────────── footer ─────────── */

function renderFooter() {
  const rows: [string, string | null][] = [
    ["TrancheJITHook", ADDR.hook],
    ["TranchePipeModule", ADDR.pipe],
    ["TrancheAccountant", ADDR.accountant],
    ["SeniorVault", ADDR.seniorVault],
    ["JuniorVault", ADDR.juniorVault],
    ["StrategyController", ADDR.controller],
  ];
  const box = $("footerLinks");
  box.innerHTML = rows
    .map(
      ([name, addr]) =>
        `<div class="kv"><span>${name}</span><span>${
          addr ? `<a href="${explorerAddr(addr)}" target="_blank" rel="noreferrer">${shortAddr(addr)}</a>` : "not deployed"
        }</span></div>`,
    )
    .join("");
}

/* ─────────── refresh loop ─────────── */

async function refresh() {
  if (currentPage === "vaults") {
    await Promise.all([readBalances(), readVaults(), readRedeem(), readOracle(), readQuoteChip()]);
  } else if (currentPage === "swap") {
    await Promise.all([readBalances(), refreshSwap()]);
  } else if (currentPage === "oracle") {
    await readOracle();
  } else if (currentPage === "strategy") {
    await readStrategy();
  }
}

/* ─────────── boot ─────────── */

function wire() {
  $("connectBtn").addEventListener("click", () => {
    const menu = $("walletMenu");
    menu.classList.toggle("hidden");
  });
  if (CLIENT_KEY) $("passkeyWrap").classList.remove("hidden");

  $("senDeposit").addEventListener("click", () => deposit("senior"));
  $("junDeposit").addEventListener("click", () => deposit("junior"));
  $("redRequest").addEventListener("click", requestRedeem);
  $("redClaimUsdc").addEventListener("click", () => claim("usdc"));
  $("redClaimEquity").addEventListener("click", () => claim("equity"));
  $("redClaimProp").addEventListener("click", () => claim("proportional"));
  $("redKeeper").addEventListener("click", keeperFulfill);
  $("redVault").addEventListener("change", () => refresh());
  $("faucetBtn").addEventListener("click", mintEquity);

  $("swapFlip").addEventListener("click", () => {
    swapDirection = swapDirection === "usdc-in" ? "equity-in" : "usdc-in";
    updateSwapLabels();
    refreshSwap().catch(() => undefined);
  });
  $("swapAmt").addEventListener("input", () => updateSwapQuote().catch(() => undefined));
  $("swapSlip").addEventListener("change", () => updateSwapQuote().catch(() => undefined));
  $("swapBtn").addEventListener("click", executeSwap);

  document.addEventListener("click", (event) => {
    const menu = $("walletMenu");
    const target = event.target as Node;
    if (!menu.classList.contains("hidden") && !menu.contains(target) && target !== $("connectBtn")) {
      menu.classList.add("hidden");
    }
  });

  window.addEventListener("hashchange", () => {
    const id = location.hash.replace("#", "");
    if (["vaults", "swap", "oracle", "strategy"].includes(id) && id !== currentPage) {
      (window as never as Record<string, (page: string) => void>).showPage(id);
    }
  });
}

renderWallet();
renderFooter();
wire();
const initialPage = location.hash.replace("#", "");
initSwap()
  .then(() => {
    const page = ["vaults", "swap", "oracle", "strategy"].includes(initialPage) ? initialPage : "vaults";
    (window as never as Record<string, (id: string) => void>).showPage(page);
  })
  .catch((error) => toast(`Init: ${(error as Error).message}`, "⛔"));
setInterval(tickFreshness, 1000);
setInterval(() => refresh().catch(() => undefined), 12000);
