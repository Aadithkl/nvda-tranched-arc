import { encodeFunctionData, maxUint256, parseAbi, parseUnits, type Abi, type Address, type Hex } from "viem";
import {
  ADDR,
  abis,
  AGENT_URL,
  marketPools,
  CLIENT_KEY,
  explorerAddr,
  explorerTx,
  fmtAmount,
  fmtBps,
  fmtCompactUsd,
  fmtEquity,
  fmtPctRay,
  fmtPrice8,
  fmtShares,
  fmtUsdc,
  graphEndpoint,
  GRAPH_API_KEY,
  ARC_SUBGRAPH_URL,
  isUnlimited,
  manifest,
  MARKET_STATUS,
  publicClient,
  QUOTE_STATE,
  shortAddr,
  strategyPools,
  testTokenAbi,
  tokenDecimals,
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

const timeAgo = (unixSeconds: number) => {
  if (!unixSeconds) return "never";
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (secs < 90) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
};

const fmtDuration = (seconds: number) => {
  if (seconds >= 86400 && seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
};

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
  "function decimals() view returns (uint8)",
  "function expiry() view returns (uint64)",
  "function expired() view returns (bool)",
  "function matured() view returns (bool)",
  "function usdcPerShare1e18() view returns (uint256)",
  "function equityPerShare1e18() view returns (uint256)",
  "function redeemAtExpiry(uint256 shares, address receiver) returns (uint256, uint256)",
]);

const hookValueAbi = parseAbi([
  "function convertToUsdc(uint256 shares) view returns (uint256)",
]);

const boundsNewAbi = parseAbi([
  "function bounds() view returns (uint16, uint16, uint32, uint32, uint128, uint128, uint32)",
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
    set("wmKind", session.kind === "passkey" ? "Passkey wallet (gasless)" : "Browser wallet");
  } else {
    pill.classList.add("hidden");
    btn.textContent = "Connect";
    info.classList.add("hidden");
  }
}

(window as never as Record<string, unknown>).connectInjectedWallet = () =>
  run("connect wallet", async () => {
    session = await connectInjected();
    renderWallet();
    $("walletMenu").classList.add("hidden");
    toast(`Connected <b>${shortAddr(session.address)}</b>`, "👛");
    await refresh();
  });

(window as never as Record<string, unknown>).connectPasskeyWallet = (mode: "register" | "login") =>
  run("connect passkey", async () => {
    const username = ($("wmUsername") as HTMLInputElement).value;
    session = await connectPasskey(username, mode);
    renderWallet();
    $("walletMenu").classList.add("hidden");
    toast(`Passkey wallet <b>${shortAddr(session.address)}</b> ready`, "🔑");
    await refresh();
  });

(window as never as Record<string, unknown>).disconnectWallet = () => {
  session = null;
  renderWallet();
  $("walletMenu").classList.add("hidden");
  toast("Wallet disconnected", "👛");
};

/* ─────────── tabs ─────────── */

const PAGES = ["vaults", "price", "strategy", "markets"];

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
let redeemPending = 0n;
let isKeeperWallet = false;
let maturedRates: { usdc: bigint; equity: bigint } = { usdc: 0n, equity: 0n };
const vaultDecimals: Record<Side, number> = { senior: 21, junior: 21 };
const vaultMaturity: Record<Side, { expiry: number; expired: boolean; matured: boolean }> = {
  senior: { expiry: 0, expired: false, matured: false },
  junior: { expiry: 0, expired: false, matured: false },
};

function fmtCountdown(expirySeconds: number): string {
  if (expirySeconds <= 0) return "no expiry";
  const seconds = expirySeconds - Math.floor(Date.now() / 1000);
  if (seconds <= 0) return "matured";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${minutes}m`;
  return `in ${minutes}m`;
}

function renderMaturityLabels() {
  for (const side of ["senior", "junior"] as const) {
    const state = vaultMaturity[side];
    const el = $(side === "senior" ? "senExpiry" : "junExpiry");
    if (!el) continue;
    if (state.expiry <= 0) {
      el.textContent = "no expiry";
    } else {
      const date = new Date(state.expiry * 1000).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
      el.textContent = state.matured ? `matured ${date}` : `${date} · ${fmtCountdown(state.expiry)}`;
    }
  }
}

// Vault shares -> hook-share assets (ERC-4626) -> USDC, so the UI never prints raw engine units.
async function vaultUsdcValue(addr: Address, shares: bigint): Promise<bigint> {
  if (shares <= 0n) return 0n;
  const assets = await safe(readContract<bigint>(addr, vaultAbi, "convertToAssets", [shares]), 0n);
  if (assets <= 0n || !ADDR.hook) return 0n;
  return safe(readContract<bigint>(ADDR.hook, hookValueAbi, "convertToUsdc", [assets]), 0n);
}

async function updateRedeemEstimate() {
  const hint = $("redValueHint");
  if (!hint) return;
  const side = ($("redVault") as HTMLSelectElement).value as Side;
  const addr = vaultAddr(side);
  const value = ($("redAmt") as HTMLInputElement).value || "0";
  if (!addr || !session) {
    hint.textContent = "Connect a wallet to estimate the payout.";
    return;
  }
  let shares: bigint;
  try {
    shares = parseUnits(value, vaultDecimals[side]);
  } catch {
    shares = 0n;
  }
  if (shares <= 0n) {
    hint.textContent = "Enter shares to see the estimated payout.";
    return;
  }
  const usdc = await vaultUsdcValue(addr, shares);
  hint.textContent = `≈ $${fmtUsdc(usdc)} at the current share value.`;
}

// Maturity mode: payouts are frozen at the settled per-share rates (1e18-scaled per share).
function updateMaturedEstimate() {
  const hint = $("redMaturedHint");
  const button = $("redRedeemExpiry") as HTMLButtonElement;
  if (!hint || !button) return;
  const side = ($("redVault") as HTMLSelectElement).value as Side;
  if (!session) {
    hint.textContent = "Connect a wallet to redeem at expiry.";
    button.disabled = true;
    return;
  }
  let shares: bigint;
  try {
    shares = parseUnits(($("redMaturedAmt") as HTMLInputElement).value || "0", vaultDecimals[side]);
  } catch {
    shares = 0n;
  }
  if (shares <= 0n) {
    hint.textContent = "Enter shares to see the payout.";
    button.disabled = true;
    return;
  }
  const usdcOut = (shares * maturedRates.usdc) / 10n ** 18n;
  const equityOut = side === "junior" ? (shares * maturedRates.equity) / 10n ** 18n : 0n;
  hint.textContent =
    side === "junior"
      ? `Payout ≈ $${fmtUsdc(usdcOut)} + ${fmtEquity(equityOut, 6)} NVDA.`
      : `Payout ≈ $${fmtUsdc(usdcOut)} USDC.`;
  button.disabled = false;
}

async function redeemAtExpiryAction() {
  await run("redeem at expiry", async () => {
    if (!session) throw new Error("connect a wallet first");
    const side = ($("redVault") as HTMLSelectElement).value as Side;
    const addr = vaultAddr(side);
    if (!addr) throw new Error("vault not deployed");
    if (!vaultMaturity[side].matured) throw new Error("settlement is not finalized yet");
    const shares = parseUnits(($("redMaturedAmt") as HTMLInputElement).value || "0", vaultDecimals[side]);
    if (shares <= 0n) throw new Error("enter an amount");
    const hash = (
      await session.sendCalls([
        {
          to: addr,
          data: encodeFunctionData({
            abi: vaultAbi,
            functionName: "redeemAtExpiry",
            args: [shares, session.address],
          }),
        },
      ])
    )[0];
    toast(
      `Redeemed at expiry · <a href="${explorerTx(hash)}" target="_blank" rel="noreferrer">${shortHash(hash)}</a>`,
      "🏁",
    );
    await refresh();
  });
}

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
    const [expiry, expired, matured] = await Promise.all([
      safe(readContract<bigint>(addr, vaultAbi, "expiry"), 0n),
      safe(readContract<boolean>(addr, vaultAbi, "expired"), false),
      safe(readContract<boolean>(addr, vaultAbi, "matured"), false),
    ]);
    vaultMaturity[side] = { expiry: Number(expiry), expired, matured };
    renderMaturityLabels();
    const badge = $(`${prefix}Badge`);
    if (badge) {
      if (matured) {
        badge.textContent = "MATURED";
        badge.className = "badge badge-dark";
      } else if (expired) {
        badge.textContent = "EXPIRED · SETTLING";
        badge.className = "badge badge-warn";
      } else {
        badge.textContent = paused ? "DEPOSITS PAUSED" : side === "senior" ? "OPEN" : "OPEN · first-loss";
        if (side === "senior") badge.className = `badge ${paused ? "badge-stale" : "badge-live"}`;
      }
    }
    const depositsBlocked = paused || expired || matured;
    const depositBtn = $(side === "senior" ? "senDeposit" : "junDeposit") as HTMLButtonElement;
    depositBtn.disabled = depositsBlocked;
    if (depositsBlocked) {
      set(
        `${prefix}Note`,
        matured || expired
          ? "Tranche matured — deposits are closed. Use Redeem at expiry below."
          : "Deposits are paused by the guardian.",
      );
    }
    if (!user) {
      set(`${prefix}Value`, "—");
      set(`${prefix}Shares`, "—");
      set(`${prefix}Max`, depositsBlocked ? (matured || expired ? "closed" : "paused") : "—");
      set(`${prefix}Paused`, paused ? "yes" : "no");
      continue;
    }
    const shares = await safe(readContract<bigint>(addr, vaultAbi, "balanceOf", [user]), 0n);
    const decimals = Number(await safe(readContract<number>(addr, vaultAbi, "decimals"), 21));
    vaultDecimals[side] = decimals;
    const value = await vaultUsdcValue(addr, shares);
    const maxDep = await safe(readContract<bigint>(addr, vaultAbi, "maxDeposit", [user]), 0n);
    set(`${prefix}Value`, `$${fmtUsdc(value)}`);
    set(`${prefix}Shares`, fmtShares(shares, decimals));
    set(`${prefix}Max`, isUnlimited(maxDep) ? "Unlimited" : `${fmtUsdc(maxDep)} USDC`);
    set(`${prefix}Paused`, paused ? "yes" : "no");
  }
}

function renderRedeemStepper(stage: number) {
  document.querySelectorAll("#redStepper .red-step").forEach((el) => {
    const step = Number(el.getAttribute("data-step"));
    el.className = `red-step${step < stage ? " done" : step === stage ? " active" : ""}`;
  });
  const stageBadge = $("redStageBadge");
  const receiveBadge = $("redReceiveBadge");
  if (stageBadge) {
    stageBadge.textContent = stage === 1 ? "idle" : stage === 2 ? "waiting for manager" : "finalized";
    stageBadge.className = `badge ${stage === 1 ? "badge-info" : stage === 2 ? "badge-warn" : "badge-live"}`;
  }
  if (receiveBadge) {
    receiveBadge.textContent = stage === 3 ? "ready ✓" : "not ready";
    receiveBadge.className = `badge ${stage === 3 ? "badge-live" : "badge-warn"}`;
  }
}

async function readRedeem() {
  const side = ($("redVault") as HTMLSelectElement).value as Side;
  const addr = vaultAddr(side);
  const user = session?.address;
  const receiveButtons = ["redReceiveUsdc", "redReceiveEquity", "redReceiveMix"] as const;
  if (!addr || !user) {
    redeemClaimable = 0n;
    redeemPending = 0n;
    isKeeperWallet = false;
    $("redActivePanel").classList.remove("hidden");
    $("redMaturingPanel").classList.add("hidden");
    $("redMaturityPanel").classList.add("hidden");
    renderRedeemStepper(1);
    set("redPending", "—");
    set("redReady", "—");
    set("redManagerAddr", "—");
    set("redStatusNote", "Connect a wallet to see your withdrawals.");
    ($("redRequest") as HTMLButtonElement).disabled = true;
    ($("redFinalize") as HTMLButtonElement).disabled = true;
    receiveButtons.forEach((id) => (($(id) as HTMLButtonElement).disabled = true));
    updateRedeemEstimate().catch(() => undefined);
    return;
  }
  const [pending, claimable] = await Promise.all([
    safe(readContract<bigint>(addr, vaultAbi, "pendingRedeemRequest", [0n, user]), 0n),
    safe(readContract<bigint>(addr, vaultAbi, "claimableRedeemRequest", [0n, user]), 0n),
  ]);
  redeemPending = pending;
  redeemClaimable = claimable;
  const decimals = vaultDecimals[side];
  const maturity = vaultMaturity[side];
  const activePanel = $("redActivePanel");
  const maturingPanel = $("redMaturingPanel");
  const maturityPanel = $("redMaturityPanel");

  if (maturity.expired || maturity.matured) {
    ($("redRequest") as HTMLButtonElement).disabled = true;
    ($("redFinalize") as HTMLButtonElement).disabled = true;
    receiveButtons.forEach((id) => (($(id) as HTMLButtonElement).disabled = true));
    set("redPending", "—");
    set("redReady", "—");
    const keeperExpired = await safe(
      readContract<Address>(ADDR.accountant as Address, abis.accountant, "keeper"),
      null as never,
    );
    set("redManagerAddr", keeperExpired ? shortAddr(keeperExpired) : "—");
    if (maturity.matured) {
      activePanel.classList.add("hidden");
      maturingPanel.classList.add("hidden");
      maturityPanel.classList.remove("hidden");
      const [usdcPerShare, equityPerShare] = await Promise.all([
        safe(readContract<bigint>(addr, vaultAbi, "usdcPerShare1e18"), 0n),
        safe(readContract<bigint>(addr, vaultAbi, "equityPerShare1e18"), 0n),
      ]);
      maturedRates = { usdc: usdcPerShare, equity: equityPerShare };
      const rateParts = [`$${fmtUsdc(usdcPerShare * 1000n)} / share`];
      if (side === "junior" && equityPerShare > 0n) {
        rateParts.push(`${fmtEquity(equityPerShare * 1000n, 6)} NVDA / share`);
      }
      set("redMaturedRate", rateParts.join(" + "));
      renderRedeemStepper(4);
      set("redStatusNote", "Matured — payout rates are frozen. Redeem at expiry pays USDC directly.");
      updateMaturedEstimate();
    } else {
      activePanel.classList.add("hidden");
      maturityPanel.classList.add("hidden");
      maturingPanel.classList.remove("hidden");
      renderRedeemStepper(2);
      set("redStageBadge", "settling");
      $("redStageBadge").className = "badge badge-warn";
      set("redReceiveBadge", "pending settlement");
      $("redReceiveBadge").className = "badge badge-warn";
      set("redStatusNote", "Expiry reached — the protocol is finalizing the terminal settlement.");
    }
    return;
  }

  activePanel.classList.remove("hidden");
  maturingPanel.classList.add("hidden");
  maturityPanel.classList.add("hidden");
  const stage = claimable > 0n ? 3 : pending > 0n ? 2 : 1;
  renderRedeemStepper(stage);
  set("redPending", pending > 0n ? `${fmtShares(pending, decimals)} shares` : "nothing waiting");
  set("redReady", claimable > 0n ? `${fmtShares(claimable, decimals)} shares` : "nothing ready");

  const keeper = await safe(readContract<Address>(ADDR.accountant as Address, abis.accountant, "keeper"), null as never);
  isKeeperWallet = !!keeper && keeper.toLowerCase() === user.toLowerCase();
  set("redManagerAddr", keeper ? `${shortAddr(keeper)}${isKeeperWallet ? " (you)" : ""}` : "—");

  ($("redRequest") as HTMLButtonElement).disabled = false;
  ($("redFinalize") as HTMLButtonElement).disabled = !(isKeeperWallet && pending > 0n);
  $("redReceiveUsdc").toggleAttribute("disabled", claimable <= 0n);
  $("redReceiveEquity").toggleAttribute("disabled", claimable <= 0n || side === "senior");
  $("redReceiveMix").toggleAttribute("disabled", claimable <= 0n || side === "senior");

  if (claimable > 0n) {
    set("redStatusNote", "Final amount locked — choose how you want to receive it.");
  } else if (pending > 0n) {
    set("redStatusNote", "Waiting for the manager to finalize. Your request is recorded onchain.");
  } else {
    set("redStatusNote", "Nothing in progress. Request a withdrawal to start.");
  }
  updateRedeemEstimate().catch(() => undefined);
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
      toast(`Depositing ${fmtUsdc(amount)} USDC into ${side}…`, "⏳");
      const hashes = await session.sendCalls(calls);
      const tx = hashes[hashes.length - 1];
      toast(
        `<b>${side} deposit confirmed</b> · <a href="${explorerTx(tx)}" target="_blank" rel="noreferrer">${shortHash(tx)}</a>`,
        "💰",
      );
      await refresh();
    } finally {
      button.disabled = false;
    }
  });
}

async function requestWithdrawal() {
  await run("request withdrawal", async () => {
    if (!session) throw new Error("connect a wallet first");
    const side = ($("redVault") as HTMLSelectElement).value as Side;
    const addr = vaultAddr(side);
    if (!addr) throw new Error("vault not deployed");
    const shares = parseUnits(($("redAmt") as HTMLInputElement).value || "0", vaultDecimals[side]);
    if (shares <= 0n) throw new Error("enter an amount");
    const hash = (
      await session.sendCalls([
        {
          to: addr,
          data: encodeFunctionData({
            abi: vaultAbi,
            functionName: "requestRedeem",
            args: [shares, session.address, session.address],
          }),
        },
      ])
    )[0];
    toast(`Withdrawal requested · <a href="${explorerTx(hash)}" target="_blank" rel="noreferrer">${shortHash(hash)}</a>`, "↩");
    await refresh();
  });
}

async function finalizeWithdrawal() {
  await run("finalize withdrawal", async () => {
    if (!session) throw new Error("connect a wallet first");
    if (!isKeeperWallet) throw new Error("only the manager wallet can finalize");
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
    toast(`Amount finalized · <a href="${explorerTx(hash)}" target="_blank" rel="noreferrer">${shortHash(hash)}</a>`, "🔒");
    await refresh();
  });
}

async function receive(kind: "usdc" | "equity" | "mix") {
  await run("receive", async () => {
    if (!session) throw new Error("connect a wallet first");
    const side = ($("redVault") as HTMLSelectElement).value as Side;
    const addr = vaultAddr(side);
    if (!addr) throw new Error("vault not deployed");
    if (redeemClaimable <= 0n) throw new Error("nothing ready yet — the manager finalizes first");
    if (side === "senior" && kind !== "usdc") throw new Error("senior withdrawals are USDC-only");
    const fn =
      kind === "usdc" ? "claimAndUnwrapUSDC" : kind === "equity" ? "claimAndUnwrapEquity" : "claimAndUnwrapProportional";
    const hash = (
      await session.sendCalls([
        {
          to: addr,
          data: encodeFunctionData({
            abi: vaultAbi,
            functionName: fn,
            args: [redeemClaimable, session.address, session.address],
          }),
        },
      ])
    )[0];
    const label = kind === "usdc" ? "USDC" : kind === "equity" ? "NVDA" : "USDC + NVDA";
    toast(
      `Received ${label} · <a href="${explorerTx(hash)}" target="_blank" rel="noreferrer">${shortHash(hash)}</a>`,
      "💸",
    );
    await refresh();
  });
}

async function mintEquity() {
  await run("test tokens", async () => {
    if (!session) throw new Error("connect a wallet first");
    if (!ADDR.equity) throw new Error("test token not configured");
    const hash = (
      await session.sendCalls([
        {
          to: ADDR.equity,
          data: encodeFunctionData({
            abi: testTokenAbi,
            functionName: "mint",
            args: [session.address, parseUnits("100", 18)],
          }),
        },
      ])
    )[0];
    toast(`Got 100 test mNVDA · <a href="${explorerTx(hash)}" target="_blank" rel="noreferrer">${shortHash(hash)}</a>`, "🚰");
    await refresh();
  });
}

/* ─────────── price feed ─────────── */

type OracleRaw = {
  mid: bigint;
  bid: bigint;
  ask: bigint;
  marketStatus: number;
  session: number;
  sourceTimestamp: number;
  updatedAt: number;
  paymentRef: Hex;
  valid: boolean;
  paused: boolean;
  maxStaleness: number;
};

let oracleRaw: OracleRaw | null = null;
let quoteStateValue = 0;

async function readPrice() {
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
    const [paused, maxStaleness] = await Promise.all([
      safe(readContract<boolean>(ADDR.oracle, abis.oracle, "paused"), false),
      safe(readContract<number>(ADDR.oracle, abis.oracle, "maxStaleness"), 300),
    ]);
    oracleRaw = {
      mid: p.mid,
      bid: p.bid,
      ask: p.ask,
      marketStatus: Number(p.marketStatus),
      session: Number(p.session),
      sourceTimestamp: Number(p.sourceTimestamp),
      updatedAt: Number(p.updatedAt),
      paymentRef: p.paymentRef,
      valid: p.valid,
      paused,
      maxStaleness,
    };
    const statusLabel = MARKET_STATUS[Number(p.marketStatus)] ?? `status ${p.marketStatus}`;
    const age = Math.max(0, Math.floor(Date.now() / 1000) - Number(p.updatedAt));

    set("pxPrice", `$${fmtPrice8(p.mid)}`);
    set("pxBid", `$${fmtPrice8(p.bid)}`);
    set("pxAsk", `$${fmtPrice8(p.ask)}`);
    set("pxSession", String(p.session));
    set("pxPaused", paused ? "yes" : "no");
    set("pxStatus", statusLabel);
    set("pxUpdated", `${new Date(Number(p.updatedAt) * 1000).toLocaleString()} · ${timeAgo(Number(p.updatedAt))}`);
    set("pxStaleness", `${maxStaleness}s`);
    set("pxWriter", manifest.oracle.writer ? shortAddr(manifest.oracle.writer) : "—");
    set(
      "pxRef",
      p.paymentRef === `0x${"0".repeat(64)}` ? "—" : `${p.paymentRef.slice(0, 10)}…${p.paymentRef.slice(-6)}`,
    );

    const validBadge = $("pxValid");
    validBadge.className = `badge ${p.valid ? "badge-live" : "badge-stale"}`;
    validBadge.innerHTML = p.valid
      ? `<span class="pulse-dot inline-block w-1.5 h-1.5 rounded-full bg-current"></span>FRESH`
      : paused
        ? "FEED PAUSED"
        : age > maxStaleness
          ? "TOO OLD"
          : "MARKET CLOSED";

    set(
      "pxHint",
      p.valid
        ? "The price is fresh and the market is open — new risk is allowed."
        : `The market is ${statusLabel} and the price was last updated ${timeAgo(Number(p.updatedAt))}. New risk stays blocked.`,
    );

    const risk = $("pxRisk");
    risk.textContent = p.valid ? "TRADING ALLOWED" : "TRADING BLOCKED";
    risk.style.background = p.valid ? "#059669" : "#DC2626";
    set(
      "pxRiskNote",
      p.valid
        ? "The engine may take new positions right now."
        : "New positions are paused. USDC withdrawals and other de-risking still work.",
    );

    const chip = $("chipWindow");
    chip.className = `badge ${p.valid ? "badge-live" : "badge-warn"}`;
    chip.textContent = p.valid ? "open" : `blocked · ${statusLabel}`;

    tickFreshness();
  } catch {
    set("pxPrice", "unavailable");
    set("pxHint", "Could not reach the Arc RPC. Retrying…");
    const chip = $("chipWindow");
    chip.className = "badge badge-stale";
    chip.textContent = "rpc error";
  }
}

type MarketPoolRow = {
  venue: string;
  feeBps: number;
  pair: string;
  price: number;
  tvl: number;
  volume: number;
  pool: string;
};

async function fetchMarketPool(entry: (typeof marketPools)[number]): Promise<MarketPoolRow> {
  const query = `query ($id: ID!) {
    pool(id: $id) {
      id
      feeTier
      sqrtPrice
      totalValueLockedUSD
      volumeUSD
      token0 { id symbol decimals }
      token1 { id symbol decimals }
    }
  }`;
  const response = await fetch(graphEndpoint(entry.subgraph), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { id: entry.pool.toLowerCase() } }),
  });
  const json = (await response.json()) as {
    data?: {
      pool?: {
        feeTier: string;
        sqrtPrice: string;
        totalValueLockedUSD: string;
        volumeUSD: string;
        token0: { symbol: string; decimals: string };
        token1: { symbol: string; decimals: string };
      } | null;
    };
    errors?: { message: string }[];
  };
  if (!json.data?.pool) throw new Error(json.errors?.[0]?.message ?? "pool not indexed");
  const pool = json.data.pool;
  const sqrtP = Number(pool.sqrtPrice) / 2 ** 96;
  const price1Per0 = sqrtP * sqrtP * 10 ** (Number(pool.token0.decimals) - Number(pool.token1.decimals));
  // USD-quoted pools only: stable in token0 -> USD per token1, stable in token1 -> USD per token0.
  const usdPerEquity = /USD/i.test(pool.token0.symbol) ? 1 / price1Per0 : price1Per0;
  return {
    venue: entry.venue,
    feeBps: entry.feeBps,
    pair: `${pool.token1.symbol}/${pool.token0.symbol}`,
    price: usdPerEquity,
    tvl: Number(pool.totalValueLockedUSD),
    volume: Number(pool.volumeUSD),
    pool: entry.pool,
  };
}

// The outside market price: NVDAc pools read through The Graph (never our own Arc pool).
async function readOnchainPrice() {
  const badge = $("onBadge");
  if (!GRAPH_API_KEY) {
    set("onPrice", "unavailable");
    set("onHint", "Add VITE_GRAPH_API_KEY to read the NVDAc market price through The Graph.");
    badge.className = "badge badge-stale";
    badge.textContent = "NO GRAPH KEY";
    return;
  }
  try {
    const rows: MarketPoolRow[] = [];
    for (const entry of marketPools) {
      try {
        rows.push(await fetchMarketPool(entry));
      } catch (error) {
        console.warn(`[market-price] ${entry.id}: ${(error as Error).message}`);
      }
    }
    if (rows.length === 0) throw new Error("no NVDAc pool indexed");
    const primary = rows[0];
    set("onPrice", `$${primary.price.toFixed(2)}`);
    set("onPool", "NVDAc");
    set(
      "onHint",
      `NVDAc/USDC on ${primary.venue} (${(primary.feeBps / 100).toFixed(2)}% fee) through The Graph — the outside market reference, not our Arc pool.`,
    );
    set("onPair", primary.pair);
    set("onTvl", fmtCompactUsd(primary.tvl));
    set("onVolume", fmtCompactUsd(primary.volume));
    set("onVenue", `${primary.venue} · ${(primary.feeBps / 100).toFixed(2)}%`);
    set("onPoolId", `${primary.pool.slice(0, 10)}…${primary.pool.slice(-6)}`);
    set("onSource", "The Graph");
    $("onVenues").innerHTML = rows
      .map(
        (row, index) =>
          `<div class="kv"><span>${row.venue} · ${(row.feeBps / 100).toFixed(2)}%${
            index === 0 ? " (primary)" : ""
          }</span><span>$${row.price.toFixed(2)} · TVL ${fmtCompactUsd(row.tvl)}</span></div>`,
      )
      .join("");
    badge.className = "badge badge-live";
    badge.textContent = "INDEXED";
  } catch (error) {
    set("onPrice", "unavailable");
    set("onHint", `Market read failed: ${(error as Error).message.slice(0, 120)}`);
    badge.className = "badge badge-stale";
    badge.textContent = "GRAPH ERROR";
  }
}

/* ─────────── NVDA market stats: fees / TVL / volume (strategy page) ─────────── */

let parkedValueUsd = 0;
let jitRealizedUsd = 0;
let jitRealizedApy = 0;
let jitEpisodes = 0;

type MarketStats = {
  pair: string;
  feePct: number;
  tvl: number;
  volume6: number;
  volume24: number;
  fees6: number;
  fees24: number;
  lifetimeVolume: number;
  lifetimeFees: number;
  effFeeBps: number;
  feeApr: number;
};

async function fetchMarketStats(entry: (typeof strategyPools)[number]): Promise<MarketStats> {
  const id = entry.pool.toLowerCase();
  const query = `{
    pool(id: "${id}") { feeTier totalValueLockedUSD volumeUSD feesUSD token0 { symbol } token1 { symbol } }
    poolHourDatas(first: 24, orderBy: periodStartUnix, orderDirection: desc, where: { pool: "${id}" }) {
      periodStartUnix volumeUSD feesUSD
    }
  }`;
  const response = await fetch(graphEndpoint(entry.subgraph), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const json = (await response.json()) as {
    data?: {
      pool?: {
        feeTier: string;
        totalValueLockedUSD: string;
        volumeUSD?: string;
        feesUSD?: string;
        token0: { symbol: string };
        token1: { symbol: string };
      } | null;
      poolHourDatas?: { volumeUSD: string; feesUSD: string }[];
    };
    errors?: { message: string }[];
  };
  if (!json.data?.pool) throw new Error(json.errors?.[0]?.message ?? "no pool");
  const hours = json.data.poolHourDatas ?? [];
  const sum = (rows: { volumeUSD: string; feesUSD: string }[], key: "volumeUSD" | "feesUSD") =>
    rows.reduce((acc, row) => acc + Number(row[key]), 0);
  const volume24 = sum(hours, "volumeUSD");
  const fees24 = sum(hours, "feesUSD");
  const volume6 = sum(hours.slice(0, 6), "volumeUSD");
  const fees6 = sum(hours.slice(0, 6), "feesUSD");
  const tvl = Number(json.data.pool.totalValueLockedUSD);
  return {
    pair: `${json.data.pool.token0.symbol}/${json.data.pool.token1.symbol}`,
    feePct: Number(json.data.pool.feeTier) / 10_000,
    tvl,
    volume6,
    volume24,
    fees6,
    fees24,
    lifetimeVolume: Number(json.data.pool.volumeUSD ?? 0),
    lifetimeFees: Number(json.data.pool.feesUSD ?? 0),
    effFeeBps: volume24 > 0 ? (fees24 / volume24) * 10_000 : 0,
    feeApr: tvl > 0 ? (fees24 / tvl) * 365 * 100 : 0,
  };
}

async function readNvdaMarkets() {
  const badge = $("bmBadge");
  if (!badge) return;
  if (!GRAPH_API_KEY) {
    badge.className = "badge badge-stale";
    badge.textContent = "NO GRAPH KEY";
    $("bmRows").innerHTML =
      `<tr><td colspan="6">Add <b>VITE_GRAPH_API_KEY</b> to the repo-root <b>.env</b> to read NVDA market stats through The Graph.</td></tr>`;
    set("bmNote", "The Graph gateway key missing.");
    return;
  }
  try {
    const rows: string[] = [];
    for (const entry of strategyPools) {
      try {
        const stats = await fetchMarketStats(entry);
        rows.push(
          `<tr><td><b>${stats.pair}</b><div class="hint">${entry.venue} · ${(entry.feeBps / 100).toFixed(2)}% fee · ${entry.status}</div>` +
            `<div class="hint">lifetime ${fmtCompactUsd(stats.lifetimeVolume)} vol / $${stats.lifetimeFees.toFixed(2)} fees</div></td>` +
            `<td>${fmtCompactUsd(stats.tvl)}</td>` +
            `<td>${fmtCompactUsd(stats.volume6)} / ${fmtCompactUsd(stats.volume24)}</td>` +
            `<td>$${stats.fees6.toFixed(2)} / $${stats.fees24.toFixed(2)}</td>` +
            `<td>${(stats.effFeeBps / 100).toFixed(2)}% <span class="hint">(${stats.effFeeBps.toFixed(1)} bps)</span></td>` +
            `<td>${stats.feeApr.toFixed(1)}%</td></tr>`,
        );
      } catch (error) {
        const reason = (error as Error).message.slice(0, 80);
        rows.push(
          `<tr><td><b>${entry.id}</b><div class="hint">${entry.venue} · ${entry.status}</div></td>` +
            `<td colspan="5">${/no pool/i.test(reason) ? "not indexed yet" : `indexer unavailable`}</td></tr>`,
        );
      }
    }
    if (rows.length === 0) throw new Error("no NVDA pools in the registry");
    $("bmRows").innerHTML = rows.join("");
    badge.className = "badge badge-live";
    badge.textContent = "LIVE";
    set(
      "bmNote",
      `The Graph · 24h window (6h slice) · avg fee paid = realised fees ÷ volume (0.30% = 30 bps) · updated ${new Date().toLocaleTimeString()}`,
    );
  } catch (error) {
    badge.className = "badge badge-stale";
    badge.textContent = "GRAPH ERROR";
    $("bmRows").innerHTML = `<tr><td colspan="6">Market read failed: ${(error as Error).message.slice(0, 120)}</td></tr>`;
  }
}

/* ─────────── realised JIT fees (subgraph, not modelled) ─────────── */

async function readJit() {
  jitRealizedUsd = 0;
  jitRealizedApy = 0;
  jitEpisodes = 0;
  if (!ARC_SUBGRAPH_URL || !ADDR.hook) return;
  try {
    const query = `{
      hookStates { id activePoolId }
      jitDeployments(first: 200, orderBy: timestamp, orderDirection: asc) { poolId zeroForOne seed }
      jitRemovals(first: 200, orderBy: timestamp, orderDirection: asc) { poolId claim0 claim1 timestamp }
      pools { id currency0 currency1 }
    }`;
    const response = await fetch(ARC_SUBGRAPH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const json = (await response.json()) as {
      data?: {
        hookStates?: { id: string; activePoolId: string }[];
        jitDeployments?: { poolId: string; zeroForOne: boolean; seed: string }[];
        jitRemovals?: { poolId: string; claim0: string; claim1: string; timestamp: string }[];
        pools?: { id: string; currency0: string; currency1: string }[];
      };
    };
    const poolId = (json.data?.hookStates ?? [])
      .find((state) => state.id.toLowerCase() === ADDR.hook?.toLowerCase())
      ?.activePoolId?.toLowerCase();
    if (!poolId) return;
    const deployments = (json.data?.jitDeployments ?? []).filter((d) => d.poolId.toLowerCase() === poolId);
    const removals = (json.data?.jitRemovals ?? []).filter((r) => r.poolId.toLowerCase() === poolId);
    jitEpisodes = removals.length;
    if (removals.length === 0) return;
    const pool = (json.data?.pools ?? []).find((p) => p.id.toLowerCase() === poolId);
    if (!pool) return;

    const [currency0, currency1] = [pool.currency0, pool.currency1];
    const prices = new Map<string, number>();
    for (const currency of [currency0, currency1]) {
      const price = await safe(
        readContract<bigint>(ADDR.peggedOracle, peggedOracleAbi, "getAssetPrice", [currency]),
        0n,
      );
      prices.set(currency.toLowerCase(), Number(price) / 1e8);
    }
    const value = (currency: string, amount: bigint): number =>
      (Number(amount) / 10 ** tokenDecimals(currency)) * (prices.get(currency.toLowerCase()) ?? 0);

    // Episodes are sequential per pool: pair deployment i with removal i, net = proceeds − seed.
    let net = 0;
    let firstTs = 0;
    removals.forEach((removal, index) => {
      const deployment = deployments[index];
      const seedValue = deployment ? value(deployment.zeroForOne ? currency1 : currency0, BigInt(deployment.seed)) : 0;
      net += value(currency0, BigInt(removal.claim0)) + value(currency1, BigInt(removal.claim1)) - seedValue;
      const ts = Number(removal.timestamp);
      if (ts > 0 && (firstTs === 0 || ts < firstTs)) firstTs = ts;
    });
    jitRealizedUsd = net;
    if (firstTs > 0 && parkedValueUsd > 0) {
      const years = Math.max((Date.now() / 1000 - firstTs) / (365 * 24 * 3600), 1 / 365);
      jitRealizedApy = jitRealizedUsd / parkedValueUsd / years;
    }
  } catch {
    // Subgraph unreachable: keep realised JIT at zero rather than guessing.
  }
}

/* ─────────── manual agent check (local bridge) ─────────── */

// On the hosted site there is no local bridge; the agent ticks in GitHub Actions every 10 min.
const AGENT_HEARTBEAT_URL = "https://github.com/Aadithkl/nvda-tranched-arc/actions/workflows/agent-heartbeat.yml";
const agentBridgeIsLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//.test(`${AGENT_URL}/`);
const pageIsLocal = ["127.0.0.1", "localhost", "::1"].includes(location.hostname);

async function runAgentCheck() {
  const button = $("agentRun") as HTMLButtonElement;
  const resultBox = $("agentResult");
  button.disabled = true;
  button.textContent = "Checking…";
  $("agentStatus").textContent = "Running one agent tick…";
  try {
    const response = await fetch(`${AGENT_URL}/tick?refresh=1`, { method: "POST" });
    const payload = (await response.json()) as {
      ok?: boolean;
      error?: string;
      elapsedMs?: number;
      submitted?: boolean;
      regime?: string;
      oracleMid?: number;
      oracleValid?: boolean;
      deviationBps?: number;
      quoteState?: number;
      maxDeployUsd?: number;
      audit?: { verdict?: string; reason?: string };
      rebalance?: { action?: string; reason?: string };
      ai?: { decision?: string; confidence?: number; model?: string } | null;
      ownPool?: { available?: boolean; swapCount?: number; volumeUsd?: number; feesUsd?: number; feeApr?: number; lpValueUsd?: number } | null;
      marketRefresh?: { ok?: boolean; skipped?: string; elapsedMs?: number; ageSeconds?: number; error?: string };
      reasoningRefresh?: { ok?: boolean; skipped?: string; elapsedMs?: number; ageSeconds?: number; error?: string };
    };
    if (!response.ok || payload.ok === false) throw new Error(payload.error ?? `HTTP ${response.status}`);
    $("agentStatus").textContent = `Done in ${payload.elapsedMs ?? 0} ms · ${
      payload.submitted ? "submitted onchain" : "dry-run (no tx)"
    }`;
    resultBox.innerHTML = [
      row(
        "Market data",
        payload.marketRefresh?.ok
          ? `refreshed from The Graph in ${payload.marketRefresh.elapsedMs ?? 0} ms`
          : `cached${
              payload.marketRefresh?.skipped
                ? ` · ${payload.marketRefresh.skipped}`
                : payload.marketRefresh?.error
                  ? ` · ${payload.marketRefresh.error}`
                  : ""
            }`,
      ),
      row("Regime", String(payload.regime ?? "—")),
      row(
        "LLM reasoning",
        payload.reasoningRefresh?.ok
          ? `fresh paid verdict (${payload.reasoningRefresh.ageSeconds ?? 0}s old)`
          : `reused · ${payload.reasoningRefresh?.skipped ?? payload.reasoningRefresh?.error ?? "not refreshed"}`,
      ),
      row(
        "Oracle",
        `${payload.oracleMid !== undefined ? `$${Number(payload.oracleMid).toFixed(2)}` : "—"} · ${
          payload.oracleValid ? "fresh" : "stale/closed"
        }`,
      ),
      row("Deviation", `${payload.deviationBps ?? 0} bps`),
      row("Quote state", QUOTE_STATE[payload.quoteState ?? 0] ?? "—"),
      row("Max deploy", `$${Number(payload.maxDeployUsd ?? 0).toFixed(2)}`),
      row(
        "Own venue (Arc)",
        payload.ownPool?.available
          ? `${payload.ownPool.swapCount ?? 0} swaps · $${Number(payload.ownPool.volumeUsd ?? 0).toFixed(2)} vol · $${Number(
              payload.ownPool.feesUsd ?? 0,
            ).toFixed(4)} fees`
          : "n/a",
      ),
      row("Audit", `${payload.audit?.verdict ?? "—"} · ${payload.audit?.reason ?? ""}`),
      row("Rebalance", `${payload.rebalance?.action ?? "hold"} · ${payload.rebalance?.reason ?? ""}`),
      row("AI verdict", payload.ai ? `${payload.ai.decision ?? "—"} (${payload.ai.model ?? "?"})` : "not used"),
    ].join("");
    resultBox.classList.remove("hidden");
    refresh().catch(() => undefined);
  } catch (error) {
    $("agentStatus").textContent = pageIsLocal
      ? `Agent not reachable at ${AGENT_URL} — start it with "npm run agent:serve".`
      : `Agent bridge ${AGENT_URL} is not reachable from this site — the hosted agent ticks on GitHub Actions every 10 minutes.`;
    resultBox.classList.add("hidden");
    throw error;
  } finally {
    button.disabled = false;
    button.textContent = "Run agent check";
  }
}

function tickFreshness() {
  if (!oracleRaw) return;
  const now = Math.floor(Date.now() / 1000);
  const remaining = oracleRaw.updatedAt + oracleRaw.maxStaleness - now;
  const pct = Math.max(0, Math.min(100, (remaining / oracleRaw.maxStaleness) * 100));
  set("pxFresh", remaining > 0 ? `${remaining}s left` : `stale by ${-remaining}s`);
  const bar = $("pxFreshBar");
  bar.style.width = `${pct}%`;
  bar.style.background =
    remaining > oracleRaw.maxStaleness * 0.3 ? "#059669" : remaining > 0 ? "#D97706" : "#DC2626";
}

async function readEngineChip() {
  if (!ADDR.hook) return;
  const state = await safe(readContract<number>(ADDR.hook, abis.hook, "quoteState"), 0);
  quoteStateValue = Number(state);
  const chip = $("chipEngine");
  if (chip) {
    chip.className = `badge ${quoteStateValue === 2 ? "badge-live" : quoteStateValue === 1 ? "badge-warn" : "badge-stale"}`;
    chip.textContent = quoteStateValue === 2 ? "active" : quoteStateValue === 1 ? "reduced" : "parked";
  }
}

/* ─────────── strategy ─────────── */

function renderEngineHero(hasHook: boolean, quotingEnabled: boolean | null) {
  let state = "Engine offline";
  let why = "The risk engine is not deployed on this test stack yet.";
  if (hasHook) {
    if (!oracleRaw?.valid) {
      state = quoteStateValue === 0 ? "Parked in Aave — no new risk" : "Reduced — winding down";
      why = "The market is closed or the price is stale, so capital stays parked in Aave and the engine takes no new positions.";
    } else if (quoteStateValue === 0) {
      state = "Parked in Aave — no open quote";
      why = "The price is fresh, but quotes are turned off or have expired. Capital stays parked in Aave until the manager refreshes them.";
    } else if (quoteStateValue === 1) {
      state = "Reduced — grace period";
      why = "Quotes are past their freshness window, so the engine only allows reduced size until the next refresh.";
    } else {
      state = "Active — managing risk";
      why = "The market is open, the price is fresh, and quotes are live. The engine may take positions within its limits.";
      if (quotingEnabled === false) {
        state = "Quoting off";
        why = "The manager has turned off new quotes. Existing positions can still be reduced.";
      }
    }
  }
  set("engState", state);
  set("engWhy", why);
  const chips = $("engChips");
  const items: string[] = [];
  if (oracleRaw) items.push(oracleRaw.valid ? "price fresh" : "price stale/closed");
  items.push(["parked", "reduced", "active"][quoteStateValue] ?? "unknown");
  chips.innerHTML = items
    .map((t) => `<span class="badge ${t.includes("fresh") || t === "active" ? "badge-live" : "badge-warn"}">${t}</span>`)
    .join("");
}

async function readStrategy() {
  await readPrice();
  await readEngineChip();

  const adv: [string, string][] = [];

  let hasHook = !!ADDR.hook;
  let quotingEnabled: boolean | null = null;
  if (ADDR.hook) {
    const state = quoteStateValue;
    const preview =
      state === 0
        ? null
        : await safe(
            readContract<[number, boolean, number, number]>(ADDR.hook, abis.hook, "previewQuote", [true]),
            null,
          );
    const [maxDeploy, riskBudget, jit, managed, paused, params] = await Promise.all([
      safe(readContract<bigint>(ADDR.hook, abis.hook, "effectiveMaxDeploy"), 0n),
      safe(readContract<bigint>(ADDR.hook, abis.hook, "riskBudget"), 0n),
      safe(readContract<[boolean, boolean, number, number, bigint]>(ADDR.hook, abis.hook, "jitsState"), [
        false,
        false,
        0,
        0,
        0n,
      ] as [boolean, boolean, number, number, bigint]),
      safe(readContract<bigint>(ADDR.hook, abis.hook, "totalManagedAssets"), 0n),
      safe(readContract<boolean>(ADDR.hook, abis.hook, "paused"), false),
      safe(readContract<Record<string, unknown>>(ADDR.hook, abis.hook, "params"), {} as Record<string, unknown>),
    ]);
    quotingEnabled = params.quotingEnabled === undefined ? null : params.quotingEnabled === true;

    set(
      "stFee",
      preview
        ? `${(Number(preview[0]) / 10000).toFixed(2)}%${preview[1] ? " · toxic flow" : ""}`
        : "quoting off",
    );
    set("stMax", `$${fmtUsdc(maxDeploy)}`);
    set("stJit", jit[0] ? "yes — inside a narrow range" : "no");
    set("stManaged", `$${fmtUsdc(managed)}`);
    set("stPaused", paused ? "yes" : "no");

    adv.push(["quoteState()", `${state} (${QUOTE_STATE[state] ?? "?"})`]);
    adv.push(["previewQuote(true)", preview ? `${preview[0]}, ${preview[1]}, ${preview[2]}, ${preview[3]}` : "reverts in rest"]);
    adv.push(["effectiveMaxDeploy()", maxDeploy.toString()]);
    adv.push(["riskBudget()", riskBudget.toString()]);
    adv.push(["jitsState()", `${jit[0]}, ${jit[1]}, ${jit[2]}, ${jit[3]}, ${jit[4]}`]);
    adv.push(["totalManagedAssets()", managed.toString()]);
    adv.push(["paused()", String(paused)]);
    adv.push([
      "params()",
      `base ${params.baseFee ?? "?"}, band ${params.maxDeviationBps ?? "?"}, ttl ${
        params.ttl ?? "?"
      }, quoting ${params.quotingEnabled ? "on" : "off"}`,
    ]);
  } else {
    hasHook = false;
    set("stFee", "—");
    set("stMax", "—");
    set("stJit", "—");
    set("stManaged", "—");
    set("stPaused", "—");
  }
  renderEngineHero(hasHook, quotingEnabled);

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
    set("prSenior", `$${fmtUsdc(senior)}`);
    set("prJunior", `$${fmtUsdc(junior)}`);
    set("prReadyS", `$${fmtUsdc(claimS)}`);
    set("prReadyJ", `$${fmtUsdc(claimJ)}`);
    set("prBuffer", `${(escrowBps / 100).toFixed(1)}% ${escrow ? "· funded ✓" : "· not funded"}`);
    set("prPool", `$${fmtUsdc(poolValue)}`);
    set("prTarget", `$${fmtUsdc(effPool)}`);
    set("prLast", lastRebal > 0n ? new Date(Number(lastRebal) * 1000).toLocaleString() : "never");

    adv.push(["seniorClaim()", senior.toString()]);
    adv.push(["juniorClaim()", junior.toString()]);
    adv.push(["claimableSenior()", claimS.toString()]);
    adv.push(["claimableJunior()", claimJ.toString()]);
    adv.push(["escrowFunded()", String(escrow)]);
    adv.push(["escrowBps()", String(escrowBps)]);
    adv.push(["poolValue()", poolValue.toString()]);
    adv.push(["effectivePool()", effPool.toString()]);
    adv.push(["lastRebalanceAt()", lastRebal.toString()]);
  }

  // rest-state yield (lending markets) + tranche expiry
  if (ADDR.hook) {
    const hook = ADDR.hook;
    const expiry = await readContract<bigint>(hook, abis.hook, "expiry").catch(() => 0n);
    set("prExpiry", expiry > 0n ? `${new Date(Number(expiry) * 1000).toLocaleString()} · ${fmtCountdown(Number(expiry))}` : "no expiry");
    adv.push(["hook.expiry()", expiry.toString()]);

    const [aTokenAddr, aEquityAddr, equityToken] = await Promise.all([
      readContract<Address>(hook, abis.hook, "aToken").catch(() => null),
      readContract<Address>(hook, abis.hook, "aTokenEquity").catch(() => null),
      readContract<Address>(hook, abis.hook, "equity").catch(() => null),
    ]);
    const legs: [Address | null, Address | null][] = [
      [aTokenAddr, ADDR.usdc],
      [aEquityAddr, equityToken],
    ];
    let restValue = 0;
    let annualYield = 0;
    let accrued = 0;
    let usdcApr: number | null = null;
    let nvdaApr: number | null = null;
    for (const [aTokenAddress, underlying] of legs) {
      if (!aTokenAddress || !underlying || aTokenAddress.toLowerCase() === ZERO_ADDR) continue;
      const [balance, scaled, reserve, price] = await Promise.all([
        safe(readContract<bigint>(aTokenAddress, abis.erc20, "balanceOf", [hook]), 0n),
        safe(readContract<bigint>(aTokenAddress, marketAbi, "scaledBalanceOf", [hook]), 0n),
        readContract<ReserveData>(ADDR.lendingPool, abis.lendingPool, "getReserveData", [underlying]).catch(() => null),
        safe(readContract<bigint>(ADDR.peggedOracle, peggedOracleAbi, "getAssetPrice", [underlying]), 0n),
      ]);
      const decimals = tokenDecimals(underlying);
      const priceUsd = Number(price) / 1e8;
      const valueUsd = (Number(balance) / 10 ** decimals) * priceUsd;
      const apr = reserve ? Number(reserve.currentLiquidityRate) / 1e27 : 0;
      if (underlying.toLowerCase() === ADDR.usdc.toLowerCase()) usdcApr = apr;
      else nvdaApr = apr;
      restValue += valueUsd;
      annualYield += valueUsd * apr;
      accrued += (Number(balance - scaled) / 10 ** decimals) * priceUsd;
      adv.push([`aToken(${underlying.slice(0, 8)}…).balance`, balance.toString()]);
    }
    set("mkYieldValue", `$${restValue.toFixed(2)}`);
    set("mkYieldApr", restValue > 0 ? `${((annualYield / restValue) * 100).toFixed(2)}%` : "—");
    set("mkYieldAccrued", `$${accrued.toFixed(8)}`);
    set("mkYieldAnnual", `$${annualYield.toFixed(2)}`);
    parkedValueUsd = restValue;
    const aaveApy = restValue > 0 ? annualYield / restValue : 0;
    await readJit();
    set("syApy", restValue > 0 ? `${((aaveApy + jitRealizedApy) * 100).toFixed(2)}%` : "—");
    set("syAaveRate", restValue > 0 ? `${(aaveApy * 100).toFixed(2)}%` : "—");
    set("syJitRate", `${(jitRealizedApy * 100).toFixed(2)}%`);
    set(
      "syJitEarned",
      `${jitRealizedUsd < 0 ? "-$" : "$"}${Math.abs(jitRealizedUsd).toFixed(2)}${
        jitEpisodes > 0 ? ` · ${jitEpisodes} episode${jitEpisodes === 1 ? "" : "s"}` : " · no episodes yet"
      }`,
    );
    set("syParked", `$${restValue.toFixed(2)}`);
    set("syUsdc", usdcApr === null ? "—" : `${(usdcApr * 100).toFixed(2)}%`);
    set("syNvda", nvdaApr === null ? "—" : `${(nvdaApr * 100).toFixed(2)}%`);
    set(
      "syNote",
      "Strategy APY = Aave parked rate + JIT fees counted only after episodes settle. Capital is parked in Aave while the engine waits for a +EV window.",
    );
    adv.push(["parkedInAave(usd)", restValue.toFixed(4)]);
    adv.push(["parkedInAave.annualYield(usd)", annualYield.toFixed(4)]);
    adv.push(["parkedInAave.accrued(usd)", accrued.toFixed(8)]);
    adv.push(["jit.realised(usd)", jitRealizedUsd.toFixed(4)]);
    adv.push(["jit.episodes", String(jitEpisodes)]);
  } else {
    set("prExpiry", "—");
    set("mkYieldValue", "—");
    set("mkYieldApr", "—");
    set("mkYieldAccrued", "—");
    set("mkYieldAnnual", "—");
    set("syApy", "—");
    set("syAaveRate", "—");
    set("syJitRate", "—");
    set("syJitEarned", "—");
    set("syParked", "—");
    set("syUsdc", "—");
    set("syNvda", "—");
  }

  if (ADDR.controller) {
    // Current layout (no fee ceilings). The still-deployed controller returns the legacy layout,
    // detected by its first value (a fee bound) exceeding the onchain deviation maximum (5000 bps).
    const current = await safe(
      readContract<[number, number, number, number, bigint, bigint, number]>(ADDR.controller, boundsNewAbi, "bounds"),
      null,
    );
    let b: { maxTtl?: number; maxGracePeriod?: number; maxDeployPerSwap?: bigint } = {};
    if (current && Number(current[0]) <= 5_000) {
      b = { maxTtl: Number(current[2]), maxGracePeriod: Number(current[3]), maxDeployPerSwap: BigInt(current[4]) };
    } else {
      const legacy = await safe(
        readContract<[number, number, number, number, number, number, bigint]>(
          ADDR.controller,
          boundsLegacyAbi,
          "bounds",
        ),
        null,
      );
      if (legacy) {
        b = { maxTtl: legacy[4], maxGracePeriod: legacy[5], maxDeployPerSwap: legacy[6] };
      }
    }
    set("limTtl", b.maxTtl !== undefined ? fmtDuration(b.maxTtl) : "—");
    set("limGrace", b.maxGracePeriod !== undefined ? fmtDuration(b.maxGracePeriod) : "—");
    set("limTrade", b.maxDeployPerSwap ? `$${fmtUsdc(b.maxDeployPerSwap)}` : "—");
    const entries = (["maxTtl", "maxGracePeriod", "maxDeployPerSwap"] as const)
      .filter((k) => b[k] !== undefined)
      .map((k) => `${k}=${b[k]}`);
    if (entries.length) adv.push(["controller.bounds()", entries.join(", ")]);
  }

  if (oracleRaw) {
    adv.push(["oracle.getPrice().mid", oracleRaw.mid.toString()]);
    adv.push(["oracle.getPrice().updatedAt", String(oracleRaw.updatedAt)]);
    adv.push(["oracle.getPrice().marketStatus", String(oracleRaw.marketStatus)]);
    adv.push(["oracle.getPrice().valid", String(oracleRaw.valid)]);
  }

  $("advRows").innerHTML = adv
    .map(([label, value]) => `<tr><td>${label}</td><td>${value}</td></tr>`)
    .join("");
}

/* ─────────── lending markets (Aave fork) ─────────── */

const marketAbi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function symbol() view returns (string)",
  "function scaledBalanceOf(address owner) view returns (uint256)",
]);

const peggedOracleAbi = parseAbi(["function getAssetPrice(address asset) view returns (uint256)"]);

type ReserveData = {
  configuration: bigint;
  liquidityIndex: bigint;
  variableBorrowIndex: bigint;
  currentLiquidityRate: bigint;
  currentVariableBorrowRate: bigint;
  currentStableBorrowRate: bigint;
  lastUpdateTimestamp: number;
  aTokenAddress: Address;
  stableDebtTokenAddress: Address;
  variableDebtTokenAddress: Address;
  interestRateStrategyAddress: Address;
  id: number;
};

function decodeReserveConfig(configuration: bigint) {
  return {
    ltv: Number(configuration & 0xffffn),
    threshold: Number((configuration >> 16n) & 0xffffn),
    bonus: Number((configuration >> 32n) & 0xffffn),
    decimals: Number((configuration >> 48n) & 0xffn),
    active: ((configuration >> 56n) & 1n) === 1n,
    frozen: ((configuration >> 57n) & 1n) === 1n,
    borrowing: ((configuration >> 58n) & 1n) === 1n,
    reserveFactor: Number((configuration >> 64n) & 0xffffn),
  };
}

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const row = (label: string, value: string) => `<div class="kv"><span>${label}</span><span>${value}</span></div>`;

async function readMarkets() {
  const adv: [string, string][] = [];
  const user = session?.address;
  const cards: string[] = [];
  let usdc: { supplied: bigint; debt: bigint; util: number; apy: bigint } | null = null;

  try {
    const assets = await readContract<Address[]>(ADDR.lendingPool, abis.lendingPool, "getReservesList");

    for (const asset of assets) {
      const data = await readContract<ReserveData>(ADDR.lendingPool, abis.lendingPool, "getReserveData", [asset]);
      const {
        configuration,
        liquidityIndex,
        variableBorrowIndex: borrowIndex,
        currentLiquidityRate: liquidityRate,
        currentVariableBorrowRate: borrowRate,
        aTokenAddress: aToken,
        variableDebtTokenAddress: debtToken,
        interestRateStrategyAddress: strategyAddr,
      } = data;
      const cfg = decodeReserveConfig(BigInt(configuration));
      const symbol = await safe(readContract<string>(asset, marketAbi, "symbol"), "?");
      const hasDebtToken = debtToken.toLowerCase() !== ZERO_ADDR;
      const [supplied, debt, cash] = await Promise.all([
        safe(readContract<bigint>(aToken, marketAbi, "totalSupply"), 0n),
        hasDebtToken ? safe(readContract<bigint>(debtToken, marketAbi, "totalSupply"), 0n) : Promise.resolve(0n),
        safe(readContract<bigint>(asset, abis.erc20, "balanceOf", [aToken]), 0n),
      ]);
      const strategy =
        strategyAddr.toLowerCase() !== ZERO_ADDR
          ? await Promise.all([
              safe(readContract<bigint>(strategyAddr, abis.rateStrategy, "baseVariableBorrowRate"), 0n),
              safe(readContract<bigint>(strategyAddr, abis.rateStrategy, "variableRateSlope1"), 0n),
              safe(readContract<bigint>(strategyAddr, abis.rateStrategy, "variableRateSlope2"), 0n),
              safe(readContract<bigint>(strategyAddr, abis.rateStrategy, "optimalUtilization"), 0n),
            ])
          : [0n, 0n, 0n, 0n];
      const total = cash + debt;
      const util = total > 0n ? Number((debt * 10_000n) / total) / 100 : 0;
      const yourSupply = user ? await safe(readContract<bigint>(aToken, abis.erc20, "balanceOf", [user]), 0n) : null;
      const yourDebt =
        user && hasDebtToken
          ? await safe(readContract<bigint>(debtToken, abis.erc20, "balanceOf", [user]), 0n)
          : null;

      if (symbol === "USDC") usdc = { supplied: total, debt, util, apy: liquidityRate };

      adv.push([`${symbol}.supplied`, total.toString()]);
      adv.push([`${symbol}.borrowed`, debt.toString()]);
      adv.push([`${symbol}.liquidityIndex`, liquidityIndex.toString()]);
      adv.push([`${symbol}.borrowIndex`, borrowIndex.toString()]);
      adv.push([`${symbol}.currentLiquidityRate(ray)`, liquidityRate.toString()]);
      adv.push([`${symbol}.currentVariableBorrowRate(ray)`, borrowRate.toString()]);
      adv.push([`${symbol}.configuration`, configuration.toString()]);

      const status = !cfg.active
        ? "inactive"
        : cfg.frozen
          ? "frozen"
          : cfg.borrowing
            ? "active · borrowable"
            : "active";
      cards.push(`<div class="card p-6">
        <div class="flex items-center justify-between mb-3">
          <h2 class="font-bold text-[17px]">${symbol}</h2>
          <span class="badge ${cfg.active && !cfg.frozen ? "badge-info" : "badge-warn"}">${status}</span>
        </div>
        <div class="grid grid-cols-2 gap-2 mb-3">
          <div class="rounded-xl bg-[#F7F6F2] border border-[var(--line)] p-3"><div class="mono-label !text-[10px]">Supplied</div><div class="font-extrabold text-[16px] font-mono">${fmtAmount(total, cfg.decimals, 2)}</div></div>
          <div class="rounded-xl bg-[#F7F6F2] border border-[var(--line)] p-3"><div class="mono-label !text-[10px]">Borrowed</div><div class="font-extrabold text-[16px] font-mono">${fmtAmount(debt, cfg.decimals, 2)}</div></div>
          <div class="rounded-xl bg-[#F7F6F2] border border-[var(--line)] p-3"><div class="mono-label !text-[10px]">Available</div><div class="font-extrabold text-[16px] font-mono">${fmtAmount(cash, cfg.decimals, 2)}</div></div>
          <div class="rounded-xl bg-[#ECFDF5] border border-[#A7F3D0] p-3"><div class="mono-label !text-[10px] !text-[#059669]">Utilization</div><div class="font-extrabold text-[16px] font-mono">${util.toFixed(1)}%</div></div>
        </div>
        ${row("Supply APY", fmtPctRay(liquidityRate))}
        ${row("Borrow APY", fmtPctRay(borrowRate))}
        ${row("LTV", fmtBps(cfg.ltv))}
        ${row("Liquidation threshold", fmtBps(cfg.threshold))}
        ${row("Liquidation bonus", fmtBps(cfg.bonus))}
        ${row("Reserve factor", fmtBps(cfg.reserveFactor))}
        ${row("Liquidity index", (Number(liquidityIndex) / 1e27).toFixed(5))}
        ${row("Rate model", `base ${fmtPctRay(strategy[0])} · s1 ${fmtPctRay(strategy[1])} · s2 ${fmtPctRay(strategy[2])} · u* ${fmtPctRay(strategy[3], 0)}`)}
        ${yourSupply !== null ? row("Your supply", fmtAmount(yourSupply, cfg.decimals, 4)) : ""}
        ${yourDebt !== null && yourDebt > 0n ? row("Your debt", fmtAmount(yourDebt, cfg.decimals, 4)) : ""}
      </div>`);
    }

    $("mkCards").innerHTML = cards.join("");
    if (usdc) {
      set("mkSupplied", fmtAmount(usdc.supplied, 6, 2));
      set("mkBorrowed", fmtAmount(usdc.debt, 6, 2));
      set("mkUtil", `${usdc.util.toFixed(1)}%`);
      set("mkApy", fmtPctRay(usdc.apy));
    }
  } catch (error) {
    $("mkCards").innerHTML =
      `<div class="card p-6"><div class="mono-label mb-2">[ .MARKETS ]</div>` +
      `<p class="hint">Markets unavailable: ${(error as Error).message.slice(0, 120)}</p></div>`;
  }

  if (user) {
    const empty: [bigint, bigint, bigint, bigint, bigint, bigint] = [0n, 0n, 0n, 0n, 0n, 0n];
    const [collateral, debt, available, threshold, ltv, hf] = await safe(
      readContract<[bigint, bigint, bigint, bigint, bigint, bigint]>(
        ADDR.lendingPool,
        abis.lendingPool,
        "getUserAccountData",
        [user],
      ),
      empty,
    );
    const hfLabel = hf > 10n ** 30n ? "∞" : (Number(hf) / 1e18).toFixed(2);
    $("mkUser").innerHTML = [
      row("Collateral", `$${fmtPrice8(collateral)}`),
      row("Debt", `$${fmtPrice8(debt)}`),
      row("Available to borrow", `$${fmtPrice8(available)}`),
      row("Liquidation threshold", fmtBps(Number(threshold))),
      row("Your LTV", fmtBps(Number(ltv))),
      row("Health factor", hfLabel),
    ].join("");
    adv.push(["getUserAccountData(you)", `${collateral}, ${debt}, ${available}, ${threshold}, ${ltv}, ${hf}`]);
  } else {
    $("mkUser").textContent = "Connect a wallet to see your position.";
  }

  $("mkAdvRows").innerHTML = adv.map(([label, value]) => `<tr><td>${label}</td><td>${value}</td></tr>`).join("");
}

function renderContracts() {
  const rows: [string, string | null][] = [
    ["Risk engine (hook)", ADDR.hook],
    ["Settlement module (pipe)", ADDR.pipe],
    ["Claims accountant", ADDR.accountant],
    ["Senior vault", ADDR.seniorVault],
    ["Junior vault", ADDR.juniorVault],
    ["Strategy controller", ADDR.controller],
    ["Engine shares", ADDR.shareToken],
    ["Price feed", ADDR.oracle],
    ["USDC", ADDR.usdc],
    ["mNVDA (test stock)", ADDR.equity],
  ];
  $("advContracts").innerHTML = rows
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
    await Promise.all([readBalances(), readVaults(), readRedeem(), readPrice()]);
  } else if (currentPage === "price") {
    await Promise.all([readPrice(), readOnchainPrice()]);
    } else if (currentPage === "strategy") {
      await readNvdaMarkets();
      await readStrategy();
    } else if (currentPage === "markets") {
      await readMarkets();
    }
}

/* ─────────── boot ─────────── */

function wire() {
  $("connectBtn").addEventListener("click", () => {
    $("walletMenu").classList.toggle("hidden");
  });
  if (CLIENT_KEY) $("passkeyWrap").classList.remove("hidden");

  $("senDeposit").addEventListener("click", () => deposit("senior"));
  $("junDeposit").addEventListener("click", () => deposit("junior"));
  $("redRequest").addEventListener("click", requestWithdrawal);
  $("redFinalize").addEventListener("click", finalizeWithdrawal);
  $("redReceiveUsdc").addEventListener("click", () => receive("usdc"));
  $("redReceiveEquity").addEventListener("click", () => receive("equity"));
  $("redReceiveMix").addEventListener("click", () => receive("mix"));
  $("redVault").addEventListener("change", () => refresh());
  $("redAmt").addEventListener("input", () => updateRedeemEstimate().catch(() => undefined));
  $("redMaturedAmt").addEventListener("input", () => updateMaturedEstimate());
  $("redRedeemExpiry").addEventListener("click", redeemAtExpiryAction);
  $("faucetBtn").addEventListener("click", mintEquity);
  if (agentBridgeIsLocal && !pageIsLocal) {
    const button = $("agentRun") as HTMLButtonElement;
    button.textContent = "Open heartbeat runs";
    $("agentStatus").innerHTML =
      `The agent is hosted on GitHub Actions and ticks every 10 minutes. ` +
      `<a class="underline" href="${AGENT_HEARTBEAT_URL}" target="_blank" rel="noreferrer">View the latest heartbeat run</a> ` +
      `for the last tick, audit verdict and any submitted transactions.`;
    button.addEventListener("click", () => window.open(AGENT_HEARTBEAT_URL, "_blank", "noopener,noreferrer"));
  } else {
    $("agentRun").addEventListener("click", () => run("agent check", runAgentCheck));
  }

  document.addEventListener("click", (event) => {
    const menu = $("walletMenu");
    const target = event.target as Node;
    if (!menu.classList.contains("hidden") && !menu.contains(target) && target !== $("connectBtn")) {
      menu.classList.add("hidden");
    }
  });

  window.addEventListener("hashchange", () => {
    const id = location.hash.replace("#", "");
    if (PAGES.includes(id) && id !== currentPage) {
      (window as never as Record<string, (page: string) => void>).showPage(id);
    }
  });
}

renderWallet();
renderContracts();
wire();
const initialPage = location.hash.replace("#", "");
(window as never as Record<string, (id: string) => void>).showPage(PAGES.includes(initialPage) ? initialPage : "vaults");
setInterval(() => {
  tickFreshness();
  renderMaturityLabels();
}, 1000);
setInterval(() => refresh().catch(() => undefined), 12000);
