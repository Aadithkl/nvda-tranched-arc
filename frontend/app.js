// Robinhood testnet frontend for the static-fee book (LedgerVault + tranches).
// Static page, no build step. Reads via public client, writes via the browser
// wallet (MetaMask). viem is pinned to the repo's version via esm.sh.
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  formatUnits,
  parseUnits,
} from "https://esm.sh/viem@2.56.3";
import {
  erc20ABI,
  hookABI,
  vaultABI,
  trancheABI,
  accountantABI,
  oracleABI,
  entryABI,
  routerABI,
} from "./abis.js";
import {
  CHAIN_ID,
  CHAIN,
  RPC_OPTIONS,
  FAUCET_URL,
  EXPLORER_URL,
  DEPLOYMENT_FIELDS,
  defaultDeployment,
  loadDeployment,
  saveDeployment,
  clearDeployment,
  loadRpc,
  saveRpc,
} from "./config.js";

const $ = (id) => document.getElementById(id);
const isAddr = (x) => typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x);
const SESSION_NAMES = ["None", "Regular", "Extended", "Overnight"];
const MIN_SQRT = 4295128739n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n;
const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";

const S = {
  rpc: loadRpc(),
  public: null,
  wallet: null,
  account: null,
  chainId: null,
  dep: loadDeployment(),
  dec: {}, // token decimals cache
  auto: false,
  timer: null,
};

function status(msg, isErr = false) {
  const el = $("status");
  el.textContent = msg;
  el.className = "status " + (isErr ? "err" : "ok");
}
function txLink(hash) {
  return `${EXPLORER_URL}/tx/${hash}`;
}
function addrLink(a) {
  return `${EXPLORER_URL}/address/${a}`;
}
function short(a) {
  return a ? a.slice(0, 6) + "…" + a.slice(-4) : "—";
}
async function decOf(token) {
  const k = token.toLowerCase();
  if (!(k in S.dec)) S.dec[k] = Number(await S.public.readContract({ address: token, abi: erc20ABI, functionName: "decimals" }));
  return S.dec[k];
}
function parseTok(str, dec) {
  return parseUnits(str.trim(), dec);
}
async function read(addr, abi, fn, args = []) {
  if (!isAddr(addr)) return null;
  try {
    return await S.public.readContract({ address: addr, abi, functionName: fn, args });
  } catch (e) {
    console.warn(fn, e?.shortMessage || e?.message || e);
    return null;
  }
}
async function write(label, addr, abi, fn, args = []) {
  if (!S.wallet || !S.account) throw new Error("connect a wallet first");
  if (!isAddr(addr)) throw new Error(`missing address for ${label}`);
  status(`${label}: sending…`);
  const hash = await S.wallet.writeContract({ address: addr, abi, functionName: fn, args, account: S.account });
  status(`${label}: ${hash} (waiting…)`);
  const rcpt = await S.public.waitForTransactionReceipt({ hash });
  status(`${label}: confirmed in block ${rcpt.blockNumber} — ${txLink(hash)}`);
  return rcpt;
}
async function send(label, fn) {
  try {
    await fn();
  } catch (e) {
    const msg = e?.shortMessage || e?.details || e?.message || String(e);
    status(`${label} failed: ${msg}`, true);
  }
  refreshAll();
}

// ---------- connection ----------

function chainConfig() {
  return { ...CHAIN, rpcUrls: { default: { http: [S.rpc] } } };
}
function rebuildClients() {
  S.public = createPublicClient({ chain: chainConfig(), transport: http(S.rpc) });
}
async function connect() {
  if (!window.ethereum) {
    status("no browser wallet found (install MetaMask)", true);
    return;
  }
  try {
    const [account] = await window.ethereum.request({ method: "eth_requestAccounts" });
    S.wallet = createWalletClient({ chain: chainConfig(), transport: custom(window.ethereum) });
    S.account = account;
    // Switch chain if needed.
    const idHex = await window.ethereum.request({ method: "eth_chainId" });
    if (parseInt(idHex, 16) !== CHAIN_ID) {
      try {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x" + CHAIN_ID.toString(16) }],
        });
      } catch (sw) {
        if (sw?.code === 4902) {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: "0x" + CHAIN_ID.toString(16),
                chainName: CHAIN.name,
                nativeCurrency: CHAIN.nativeCurrency,
                rpcUrls: [S.rpc],
                blockExplorerUrls: [EXPLORER_URL],
              },
            ],
          });
        } else throw sw;
      }
    }
    S.chainId = CHAIN_ID;
    status(`connected ${short(account)} on Robinhood testnet`);
  } catch (e) {
    status(`connect failed: ${e?.shortMessage || e?.message || e}`, true);
  }
  renderConn();
  refreshAll();
}
function renderConn() {
  $("btnConnect").textContent = S.account ? `Connected ${short(S.account)}` : "Connect wallet";
  $("rpcSel").value = S.rpc;
  const blk = $("blockNum");
  if (blk && S.lastBlock) blk.textContent = `block ${S.lastBlock}`;
}

// ---------- deployment config ----------

function renderDepForm() {
  const wrap = $("depForm");
  wrap.innerHTML = "";
  for (const [key, label, hint] of DEPLOYMENT_FIELDS) {
    const row = document.createElement("div");
    row.className = "dep-row";
    row.innerHTML = `<label title="${hint}">${label}<input data-dep="${key}" placeholder="0x…" spellcheck="false"></label>
      <a data-explink="${key}" target="_blank" rel="noreferrer" class="mini-link">↗</a>`;
    wrap.appendChild(row);
  }
  for (const inp of wrap.querySelectorAll("input[data-dep]")) {
    inp.value = S.dep[inp.dataset.dep] || "";
    inp.addEventListener("change", () => {
      S.dep[inp.dataset.dep] = inp.value.trim();
      saveDeployment(S.dep);
      paintExplinks();
    });
  }
  paintExplinks();
}
function paintExplinks() {
  for (const a of document.querySelectorAll("a[data-explink]")) {
    const v = S.dep[a.dataset.explink];
    if (isAddr(v)) {
      a.href = addrLink(v);
      a.style.visibility = "visible";
    } else a.style.visibility = "hidden";
  }
}
async function loadRepoJson() {
  try {
    // Relative to the page so it works both locally (`npm run frontend`,
    // which mounts this exact path) and on GitHub Pages.
    const res = await fetch("./deployments/robinhood-testnet.json");
    if (!res.ok) throw new Error(`HTTP ${res.status} (serve over http, not file://)`);
    const j = await res.json();
    const c = (j.contracts || {});
    const s = (j.stack || {});
    const map = {
      poolManager: c.v4PoolManager, router: c.demoRouter, quote: c.usdg, equity: c.nvdaStockToken,
      oracle: c.nvdaOracle, hook: s.hook, vault: s.vault, senior: s.senior, junior: s.junior,
      accountant: s.accountant, entry: s.entry, controller: s.controller, agent: s.agent,
      strategyModule: s.strategyModule, poolFee: s.poolFee, poolTickSpacing: s.poolTickSpacing,
    };
    for (const [k, v] of Object.entries(map)) if (v) S.dep[k] = String(v);
    saveDeployment(S.dep);
    renderDepForm();
    status("loaded deployments/robinhood-testnet.json into the form");
  } catch (e) {
    status(`repo JSON load failed: ${e.message}`, true);
  }
  refreshAll();
}
function downloadJson() {
  const blob = new Blob([JSON.stringify({ network: "robinhood-testnet", chainId: CHAIN_ID, contracts: S.dep }, null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "robinhood-testnet.local.json";
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- overview ----------

function card(title, rows) {
  return `<div class="card"><h3>${title}</h3><table>${rows
    .map(([k, v]) => `<tr><td>${k}</td><td>${v ?? "—"}</td></tr>`)
    .join("")}</table></div>`;
}
const yn = (b) => (b === null || b === undefined ? "—" : b ? "yes" : "no");

async function refreshAll() {
  if (!S.public) rebuildClients();
  try {
    S.lastBlock = String(await S.public.getBlockNumber());
  } catch {
    S.lastBlock = null;
  }
  renderConn();
  paintExplinks();
  const d = S.dep;
  const acct = S.account;
  const out = [];

  // Token decimals once (cached) so every amount below is scaled right.
  let qd = 6, ed = 18, sd = 24, jd = 24;
  try {
    if (isAddr(d.quote)) qd = await decOf(d.quote);
    if (isAddr(d.equity)) ed = await decOf(d.equity);
    if (isAddr(d.senior)) sd = Number(await S.public.readContract({ address: d.senior, abi: trancheABI, functionName: "decimals" }));
    if (isAddr(d.junior)) jd = Number(await S.public.readContract({ address: d.junior, abi: trancheABI, functionName: "decimals" }));
  } catch {}

  // Balances header
  if (acct && isAddr(d.quote) && isAddr(d.equity)) {
    const [qb, eb, eth] = await Promise.all([
      read(d.quote, erc20ABI, "balanceOf", [acct]),
      read(d.equity, erc20ABI, "balanceOf", [acct]),
      S.public.getBalance({ address: acct }).catch(() => null),
    ]);
    out.push(
      card("Wallet", [
        ["account", `<a target=_blank href="${addrLink(acct)}">${short(acct)}</a>`],
        ["ETH", eth === null ? "—" : formatUnits(eth, 18)],
        ["quote", qb === null ? "—" : formatUnits(qb, qd)],
        ["equity", eb === null ? "—" : formatUnits(eb, ed)],
      ])
    );
  }

  // Hook
  if (isAddr(d.hook)) {
    const [st, price, dev, ostat, gp, qi, ei] = await Promise.all([
      read(d.hook, hookABI, "guardState"),
      read(d.hook, hookABI, "poolPrice1e18"),
      read(d.hook, hookABI, "oracleDeviationBps"),
      read(d.hook, hookABI, "oracleStatus"),
      read(d.hook, hookABI, "guardParams"),
      read(d.hook, hookABI, "quoteIdle"),
      read(d.hook, hookABI, "equityIdle"),
    ]);
    out.push(
      card("Book (hook)", [
        ["guard present", st ? yn(st[0]) : "—"],
        ["exited", st ? yn(st[3]) : "—"],
        ["deploy enabled", st ? yn(st[2]) : "—"],
        ["pool price (1e18)", price === null ? "—" : formatUnits(price, 18)],
        ["deviation", dev ? (dev[0] ? `${dev[1]} bps` : "n/a") : "—"],
        ["oracle", ostat ? `${yn(ostat[0])} · session ${SESSION_NAMES[Number(ostat[2])] ?? ostat[2]}` : "—"],
        ["hook quote idle", qi === null ? "—" : formatUnits(qi, qd)],
        ["hook equity idle", ei === null ? "—" : formatUnits(ei, ed)],
        ["guard liq", gp ? String(gp.guardLiquidity) : "—"],
        ["base liq", gp ? String(gp.baseLiquidity) : "—"],
        ["minEvBps", gp ? String(gp.minEvBps) : "—"],
      ])
    );
  }

  // Oracle
  if (isAddr(d.oracle)) {
    const p = await read(d.oracle, oracleABI, "getPrice");
    out.push(
      card("Oracle", [
        ["valid", p ? yn(p.valid) : "—"],
        ["mid (1e8)", p ? String(p.mid) : "—"],
        ["marketStatus", p ? String(p.marketStatus) : "—"],
        ["session", p ? SESSION_NAMES[Number(p.session)] ?? String(p.session) : "—"],
        ["updatedAt", p ? new Date(Number(p.updatedAt) * 1000).toLocaleString() : "—"],
      ])
    );
  }

  // Vault
  if (isAddr(d.vault)) {
    const [exp, set, halt, tma, ke, ow] = await Promise.all([
      read(d.vault, vaultABI, "expired"),
      read(d.vault, vaultABI, "settled"),
      read(d.vault, vaultABI, "halted"),
      read(d.vault, vaultABI, "totalManagedAssets"),
      read(d.vault, vaultABI, "keeper"),
      read(d.vault, vaultABI, "owner"),
    ]);
    const roles = [];
    if (acct && ow && acct.toLowerCase() === ow.toLowerCase()) roles.push("vault-owner");
    if (acct && ke && acct.toLowerCase() === ke.toLowerCase()) roles.push("vault-keeper");
    out.push(
      card("Vault", [
        ["expired / settled / halted", `${yn(exp)} / ${yn(set)} / ${yn(halt)}`],
        ["totalManagedAssets", tma === null ? "—" : formatUnits(tma, qd)],
        ["keeper", ke ? short(ke) : "—"],
        ["your roles", roles.length ? roles.join(", ") : "none"],
      ])
    );
  }

  // Tranches + accountant
  for (const [key, label, tdec] of [["senior", "Senior", sd], ["junior", "Junior", jd]]) {
    if (!isAddr(d[key])) continue;
    const [sup, bal, mat, rate] = await Promise.all([
      read(d[key], trancheABI, "totalSupply"),
      acct ? read(d[key], trancheABI, "balanceOf", [acct]) : null,
      read(d[key], trancheABI, "matured"),
      read(d[key], trancheABI, "quotePerShare1e18"),
    ]);
    out.push(card(label, [["supply", sup === null ? "—" : formatUnits(sup, tdec)], ["your balance", bal === null ? "—" : formatUnits(bal, tdec)], ["matured", yn(mat)], ["quote/share", rate === null ? "—" : formatUnits(rate, 18)]]));
  }
  if (isAddr(d.accountant)) {
    const [sc, jc, sp, jp, g, ef, fr] = await Promise.all([
      read(d.accountant, accountantABI, "seniorClaim"),
      read(d.accountant, accountantABI, "juniorClaim"),
      read(d.accountant, accountantABI, "seniorPrincipal"),
      read(d.accountant, accountantABI, "juniorPrincipal"),
      read(d.accountant, accountantABI, "seniorGuaranteeQuote"),
      read(d.accountant, accountantABI, "escrowFunded"),
      read(d.accountant, accountantABI, "frozen"),
    ]);
    out.push(
      card("Accountant", [
        ["senior claim / principal", `${sc === null ? "—" : formatUnits(sc, qd)} / ${sp === null ? "—" : formatUnits(sp, qd)}`],
        ["junior claim / principal", `${jc === null ? "—" : formatUnits(jc, qd)} / ${jp === null ? "—" : formatUnits(jp, qd)}`],
        ["guarantee", g === null ? "—" : formatUnits(g, qd)],
        ["escrow funded / frozen", `${yn(ef)} / ${yn(fr)}`],
      ])
    );
  }

  $("overview").innerHTML = out.join("") || `<p class="hint">Fill deployment addresses above, then Refresh.</p>`;
}

// ---------- generic form helpers ----------

function val(id) {
  return $(id).value.trim();
}
async function needTokenMeta() {
  const d = S.dep;
  if (!isAddr(d.quote) || !isAddr(d.equity)) throw new Error("set quote + equity addresses first");
  const [qd, ed] = await Promise.all([decOf(d.quote), decOf(d.equity)]);
  return { qd, ed };
}
async function ensureAllowance(token, owner, spender, amount) {
  const cur = await S.public.readContract({ address: token, abi: erc20ABI, functionName: "allowance", args: [owner, spender] });
  if (cur < amount) {
    await write("approve", token, erc20ABI, "approve", [spender, amount]);
  }
}

// ---------- tab actions ----------

async function doFaucetMint(which) {
  const d = S.dep;
  const token = which === "quote" ? d.quote : d.equity;
  const amt = parseTok(val(which === "quote" ? "faucetQuoteAmt" : "faucetEquityAmt") || "1000", await decOf(token));
  await send("mint", () => write("mint", token, erc20ABI, "mint", [S.account, amt]));
}
async function doWatch(which) {
  const d = S.dep;
  const token = which === "quote" ? d.quote : d.equity;
  const [sym, dec] = await Promise.all([
    S.public.readContract({ address: token, abi: erc20ABI, functionName: "symbol" }),
    decOf(token),
  ]);
  await window.ethereum.request({ method: "wallet_watchAsset", params: { type: "ERC20", options: { address: token, symbol: sym, decimals: dec } } });
  status(`asset ${sym} added to wallet`);
}

async function doDeposit(which) {
  const d = S.dep;
  const tv = which === "senior" ? d.senior : d.junior;
  const { qd } = await needTokenMeta();
  const amt = parseTok(val(which === "senior" ? "depSeniorAmt" : "depJuniorAmt"), qd);
  await send("deposit", async () => {
    await ensureAllowance(d.quote, S.account, tv, amt);
    await write("depositQuote", tv, trancheABI, "depositQuote", [amt, S.account]);
  });
}

async function doRequest(which) {
  const d = S.dep;
  const tv = which === "senior" ? d.senior : d.junior;
  const bal = await S.public.readContract({ address: tv, abi: trancheABI, functionName: "balanceOf", args: [S.account] });
  const amtStr = val(which === "senior" ? "redSeniorAmt" : "redJuniorAmt");
  // tranche shares use hook-share decimals; default to full balance when empty.
  const td = Number(await S.public.readContract({ address: tv, abi: trancheABI, functionName: "decimals" }));
  const amt = amtStr ? parseTok(amtStr, td) : bal;
  await send("requestRedeem", () => write("requestRedeem", tv, trancheABI, "requestRedeem", [amt, S.account, S.account]));
}
async function doClaimUnwrap(which) {
  const d = S.dep;
  const tv = which === "senior" ? d.senior : d.junior;
  const td = Number(await S.public.readContract({ address: tv, abi: trancheABI, functionName: "decimals" }));
  const amtStr = val(which === "senior" ? "redSeniorAmt" : "redJuniorAmt");
  const amt = amtStr
    ? parseTok(amtStr, td)
    : await S.public.readContract({ address: tv, abi: trancheABI, functionName: "maxRedeem", args: [S.account] });
  await send("claimAndUnwrapQuote", () =>
    write("claimAndUnwrapQuote", tv, trancheABI, "claimAndUnwrapQuote", [amt, S.account, S.account, 0n])
  );
}
async function doFulfill(which) {
  const d = S.dep;
  await send("fulfillRedeem", () =>
    write("fulfillRedeem", d.accountant, accountantABI, "fulfillRedeem", [which === "senior", S.account])
  );
}
async function doClaimEpoch(which) {
  const d = S.dep;
  await send("claimEpoch", () => write("claimEpoch", d.accountant, accountantABI, "claimEpoch", [which === "senior", S.account]));
}
async function doExecuteEpoch() {
  await send("executeEpoch", () => write("executeEpoch", S.dep.accountant, accountantABI, "executeEpoch", []));
}
async function doRebalance() {
  await send("rebalance", () => write("rebalance", S.dep.accountant, accountantABI, "rebalance", []));
}
async function doUnwrapDirect() {
  const d = S.dep;
  const hst = await S.public.readContract({ address: d.vault, abi: vaultABI, functionName: "shareToken" });
  const hd = Number(await S.public.readContract({ address: hst, abi: erc20ABI, functionName: "decimals" }));
  const amt = parseTok(val("unwrapAmt"), hd);
  await send("unwrapQuote", () => write("unwrapQuote", d.vault, vaultABI, "unwrapQuote", [amt, S.account, 0n]));
}
async function entryShareToken() {
  return S.public.readContract({ address: S.dep.vault, abi: vaultABI, functionName: "shareToken" });
}
async function doEntryPreview() {
  const d = S.dep;
  const { qd } = await needTokenMeta();
  const hst = await entryShareToken();
  const sd = Number(await S.public.readContract({ address: hst, abi: erc20ABI, functionName: "decimals" }));
  const sh = val("entryShares") ? parseTok(val("entryShares"), sd) : 0n;
  const as = val("entryAssets") ? parseTok(val("entryAssets"), qd) : 0n;
  const [pr, pw] = await Promise.all([
    sh ? read(d.entry, entryABI, "previewRedeem", [sh]) : null,
    as ? read(d.entry, entryABI, "previewWithdraw", [as]) : null,
  ]);
  $("entryOut").innerHTML =
    `previewRedeem = ${pr === null ? "—" : formatUnits(pr, qd)} quote<br>previewWithdraw = ${pw === null ? "—" : formatUnits(pw, sd)} shares`;
  status("entry preview done");
}
async function doEntryRedeem() {
  const d = S.dep;
  const hst = await entryShareToken();
  const sd = Number(await S.public.readContract({ address: hst, abi: erc20ABI, functionName: "decimals" }));
  const sh = parseTok(val("entryShares"), sd);
  await send("entry.redeem", async () => {
    await ensureAllowance(hst, S.account, d.entry, sh);
    await write("redeem", d.entry, entryABI, "redeem", [sh, S.account, S.account]);
  });
}
async function doEntryWithdraw() {
  const d = S.dep;
  const { qd } = await needTokenMeta();
  const as = parseTok(val("entryAssets"), qd);
  const hst = await entryShareToken();
  const need = await S.public.readContract({ address: d.entry, abi: entryABI, functionName: "previewWithdraw", args: [as] });
  await send("entry.withdraw", async () => {
    await ensureAllowance(hst, S.account, d.entry, need);
    await write("withdraw", d.entry, entryABI, "withdraw", [as, S.account, S.account]);
  });
}
async function doMatured(which) {
  const d = S.dep;
  const tv = which === "senior" ? d.senior : d.junior;
  const op = val("maturedOp");
  await send(op, async () => {
    if (op === "fulfillRedeemMatured") await write(op, tv, trancheABI, op, [S.account]);
    else if (op === "claimMatured") await write(op, tv, trancheABI, op, [S.account]);
    else {
      const bal = await S.public.readContract({ address: tv, abi: trancheABI, functionName: "balanceOf", args: [S.account] });
      await write(op, tv, trancheABI, op, [bal, S.account, 0n, 0n]);
    }
  });
}

function poolKey() {
  const d = S.dep;
  const q = d.quote.toLowerCase(), e = d.equity.toLowerCase();
  const t0 = q < e ? d.quote : d.equity;
  const t1 = q < e ? d.equity : d.quote;
  return {
    currency0: t0,
    currency1: t1,
    fee: Number(d.poolFee || 3000),
    tickSpacing: Number(d.poolTickSpacing || 60),
    hooks: d.hook,
  };
}
async function doSimulate() {
  const d = S.dep;
  const dir = val("swapDir"); // "buy" = pay quote, receive equity
  const { qd, ed } = await needTokenMeta();
  const inDec = dir === "buy" ? qd : ed;
  const amt = parseTok(val("swapAmt") || "10", inDec);
  const q = d.quote.toLowerCase();
  const t0 = q < d.equity.toLowerCase() ? d.quote : d.equity;
  const zeroForOne = dir === "buy" ? d.quote.toLowerCase() === t0.toLowerCase() : d.equity.toLowerCase() === t0.toLowerCase();
  const limit = zeroForOne ? MIN_SQRT + 1n : MAX_SQRT - 1n;
  const r = await S.public.readContract({
    address: d.hook, abi: hookABI, functionName: "simulateEv",
    args: [{ zeroForOne, amountSpecified: -amt, sqrtPriceLimitX96: limit }],
  });
  if (!r) return status("simulate failed (hook address?)", true);
  const [ok, ev, ourNot, totEv, totNot] = r;
  $("simOut").innerHTML =
    `ok=${yn(ok)} ev=${ev} ourNotional=${ourNot}<br>totalEv=${totEv} totalNotional=${totNot}`;
  status("simulation done");
}
async function doSwap() {
  const d = S.dep;
  const dir = val("swapDir");
  const { qd, ed } = await needTokenMeta();
  const inTok = dir === "buy" ? d.quote : d.equity;
  const inDec = dir === "buy" ? qd : ed;
  const amt = parseTok(val("swapAmt") || "10", inDec);
  const minOut = parseTok(val("swapMinOut") || "0", dir === "buy" ? ed : qd);
  const key = poolKey();
  const q = d.quote.toLowerCase();
  const t0 = q < d.equity.toLowerCase() ? d.quote : d.equity;
  const zeroForOne = dir === "buy" ? d.quote.toLowerCase() === t0.toLowerCase() : d.equity.toLowerCase() === t0.toLowerCase();
  await send("swap", async () => {
    await ensureAllowance(inTok, S.account, d.router, amt);
    await write("swapExactIn", d.router, routerABI, "swapExactIn", [key, zeroForOne, amt, minOut, S.account]);
  });
}

async function doRecheck() {
  await send("recheckGuard", () => write("recheckGuard", S.dep.hook, hookABI, "recheckGuard", []));
}
async function doSetGuardParams() {
  const d = S.dep;
  const p = {
    guardTickWidth: Number(val("gp_gtw")), baseTickWidth: Number(val("gp_btw")),
    guardLiquidity: BigInt(val("gp_gl")), baseLiquidity: BigInt(val("gp_bl")),
    minEvBps: Number(val("gp_minev")), recheckMaxDeviationBps: Number(val("gp_dev")),
    recheckInterval: Number(val("gp_int")), maxPriceAge: Number(val("gp_age")),
    allowedSessionsMask: Number(val("gp_mask")),
  };
  await send("setGuardParams", () => write("setGuardParams", d.vault, vaultABI, "setGuardParams", [p]));
}
async function prefillGuardParams() {
  const cur = await S.public
    .readContract({ address: S.dep.hook, abi: hookABI, functionName: "guardParams" })
    .catch(() => null);
  if (!cur) return status("cannot read guard params", true);
  $("gp_gtw").value = cur.guardTickWidth; $("gp_btw").value = cur.baseTickWidth;
  $("gp_gl").value = cur.guardLiquidity.toString(); $("gp_bl").value = cur.baseLiquidity.toString();
  $("gp_minev").value = cur.minEvBps; $("gp_dev").value = cur.recheckMaxDeviationBps;
  $("gp_int").value = cur.recheckInterval; $("gp_age").value = cur.maxPriceAge;
  $("gp_mask").value = cur.allowedSessionsMask;
  status("guard params loaded");
}
async function doFundHook() {
  const { qd, ed } = await needTokenMeta();
  const q = val("fundQ") ? parseTok(val("fundQ"), qd) : 0n;
  const e = val("fundE") ? parseTok(val("fundE"), ed) : 0n;
  await send("fundHook", () => write("fundHook", S.dep.vault, vaultABI, "fundHook", [q, e]));
}
async function doInitHook() {
  const key = poolKey();
  const tick = Number(val("initTick"));
  const sqrtX96 = tickToSqrtX96(tick);
  await send("initializeHook", () => write("initializeHook", S.dep.vault, vaultABI, "initializeHook", [key, sqrtX96]));
}
function tickToSqrtX96(tick) {
  // P = 1.0001^tick as fixed point; sqrtPriceX96 = sqrt(P) * 2^96, computed in doubles
  // with ample precision for a UI helper (onchain init checks the band anyway).
  const p = Math.pow(1.0001, tick);
  return BigInt(Math.floor(Math.sqrt(p) * 2 ** 96));
}
function tickFromPrice() {
  try {
    const price = parseFloat(val("tickPrice"));
    const qd = Number(val("tickQDec") || 6), ed = Number(val("tickEDec") || 18);
    const spacing = Number(val("tickSpacing") || 60);
    const equityIs1 = $("tickOrder").value === "eq1";
    const scale = Math.pow(10, 18 + ed - qd);
    const P = equityIs1 ? scale / price : price / scale;
    const tick = Math.floor(Math.log(P) / Math.log(1.0001) / spacing) * spacing;
    $("tickOut").textContent = `suggested tick: ${tick} (P=${P.toExponential(4)}) — verify deviation ≈ 0 after init`;
  } catch (e) {
    $("tickOut").textContent = `error: ${e.message}`;
  }
}
async function doOraclePush() {
  const mid = BigInt(val("oracleMid"));
  const st = Number(val("oracleStatus") || 2);
  const ts = Math.floor(Date.now() / 1000);
  await send("updatePrice", () =>
    write("updatePrice", S.dep.oracle, oracleABI, "updatePrice", [mid, st, ts, ZERO_HASH])
  );
}
async function doSetExitFees() {
  await send("setExitFees", () =>
    write("setExitFees", S.dep.vault, vaultABI, "setExitFees", [Number(val("feeBps")), Number(val("fineBps"))])
  );
}
async function doHaltExpired() {
  await send("haltIfExpired", () => write("haltIfExpired", S.dep.vault, vaultABI, "haltIfExpired", []));
}
async function doFinalize(haircut) {
  await send(haircut ? "finalizeSettlementHaircut" : "finalizeSettlement", () =>
    write(haircut ? "finalizeSettlementHaircut" : "finalizeSettlement", S.dep.vault, vaultABI, haircut ? "finalizeSettlementHaircut" : "finalizeSettlement", [])
  );
}
async function doSimple(fn, addr, abi, args, label) {
  await send(label || fn, async () => write(label || fn, addr, abi, fn, await args));
}

// ---------- wiring ----------

function on(id, ev, fn) {
  $(id).addEventListener(ev, fn);
}
function init() {
  rebuildClients();
  renderDepForm();
  // rpc select
  const sel = $("rpcSel");
  sel.innerHTML = "";
  const opts = [...new Set([S.rpc, ...RPC_OPTIONS.map((o) => o.url)])];
  for (const u of opts) {
    const o = document.createElement("option");
    o.value = u;
    o.textContent = (RPC_OPTIONS.find((r) => r.url === u) || {}).label || u;
    sel.appendChild(o);
  }
  sel.value = S.rpc;
  sel.addEventListener("change", () => {
    S.rpc = sel.value;
    saveRpc(S.rpc);
    rebuildClients();
    status(`RPC: ${S.rpc}`);
    refreshAll();
  });
  $("faucetLink").href = FAUCET_URL;
  $("explorerLink").href = EXPLORER_URL;

  on("btnConnect", "click", connect);
  on("btnRefresh", "click", refreshAll);
  on("btnAuto", "click", () => {
    S.auto = !S.auto;
    $("btnAuto").textContent = `Auto: ${S.auto ? "on" : "off"}`;
    if (S.auto) S.timer = setInterval(refreshAll, 15000);
    else clearInterval(S.timer);
  });
  on("btnSaveDep", "click", () => {
    for (const inp of document.querySelectorAll("input[data-dep]")) S.dep[inp.dataset.dep] = inp.value.trim();
    saveDeployment(S.dep);
    status("deployment saved locally");
    refreshAll();
  });
  on("btnClearDep", "click", () => {
    clearDeployment();
    S.dep = defaultDeployment();
    renderDepForm();
    refreshAll();
  });
  on("btnLoadRepo", "click", loadRepoJson);
  on("btnDlJson", "click", downloadJson);

  // tabs
  for (const b of document.querySelectorAll("[data-tab]")) {
    b.addEventListener("click", () => {
      for (const x of document.querySelectorAll("[data-tab]")) x.classList.remove("active");
      for (const p of document.querySelectorAll("[data-pane]")) p.classList.remove("active");
      b.classList.add("active");
      document.querySelector(`[data-pane="${b.dataset.tab}"]`).classList.add("active");
    });
  }

  on("btnFaucetQ", "click", () => doFaucetMint("quote"));
  on("btnFaucetE", "click", () => doFaucetMint("equity"));
  on("btnWatchQ", "click", () => doWatch("quote").catch((e) => status(String(e?.message || e), true)));
  on("btnWatchE", "click", () => doWatch("equity").catch((e) => status(String(e?.message || e), true)));

  on("btnDepS", "click", () => doDeposit("senior"));
  on("btnDepJ", "click", () => doDeposit("junior"));
  on("btnReqS", "click", () => doRequest("senior"));
  on("btnReqJ", "click", () => doRequest("junior"));
  on("btnClaimUWS", "click", () => doClaimUnwrap("senior"));
  on("btnClaimUWJ", "click", () => doClaimUnwrap("junior"));
  on("btnFulS", "click", () => doFulfill("senior"));
  on("btnFulJ", "click", () => doFulfill("junior"));
  on("btnEpochS", "click", () => doClaimEpoch("senior"));
  on("btnEpochJ", "click", () => doClaimEpoch("junior"));
  on("btnExecEpoch", "click", doExecuteEpoch);
  on("btnRebalance", "click", doRebalance);
  on("btnUnwrap", "click", doUnwrapDirect);
  on("btnEntryPrev", "click", () => doEntryPreview().catch((e) => status(String(e?.message || e), true)));
  on("btnEntryRedeem", "click", doEntryRedeem);
  on("btnEntryWithdraw", "click", doEntryWithdraw);
  on("btnMatured", "click", () => doMatured(val("maturedSide")));
  on("btnSim", "click", () => doSimulate().catch((e) => status(String(e?.message || e), true)));
  on("btnSwap", "click", doSwap);

  on("btnRecheck", "click", doRecheck);
  on("btnLoadGP", "click", prefillGuardParams);
  on("btnSetGP", "click", doSetGuardParams);
  on("btnFund", "click", doFundHook);
  on("btnInit", "click", doInitHook);
  on("btnOraclePush", "click", doOraclePush);
  on("btnSetFees", "click", doSetExitFees);
  const k = (id, fn, addr, abi, args, label) => on(id, "click", () => doSimple(fn, addr(), abi, args(), label));
  k("btnRecall", "recallFromHook", () => S.dep.vault, vaultABI, () => []);
  k("btnDeployG", "deployGuard", () => S.dep.vault, vaultABI, () => []);
  k("btnRecenter", "recenterGuard", () => S.dep.vault, vaultABI, () => []);
  k("btnRearm", "rearmHook", () => S.dep.vault, vaultABI, () => []);
  k("btnDeployEn", "setHookDeployEnabled", () => S.dep.vault, vaultABI, () => [$("deployEn").value === "true"]);
  k("btnSupply", "supplyIdle", () => S.dep.vault, vaultABI, () => []);
  k("btnWithdrawV", "withdrawFromVenue", () => S.dep.vault, vaultABI, async () => {
    const { qd } = await needTokenMeta();
    return [parseTok(val("venueAmt") || "0", qd)];
  });
  k("btnHalt", "haltIfExpired", () => S.dep.vault, vaultABI, () => []);
  k("btnFinalize", "finalizeSettlement", () => S.dep.vault, vaultABI, () => []);
  k("btnHaircut", "finalizeSettlementHaircut", () => S.dep.vault, vaultABI, () => []);
  on("btnTickCalc", "click", tickFromPrice);

  if (window.ethereum) {
    window.ethereum.on?.("accountsChanged", () => connect());
    window.ethereum.on?.("chainChanged", () => window.location.reload());
  }
  refreshAll();
}

document.addEventListener("DOMContentLoaded", init);
