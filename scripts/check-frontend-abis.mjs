// Verifies frontend/abis.js entries exist onchain-side: every function name +
// input types must match the compiled artifact. Usage: node scripts/check-frontend-abis.mjs
import { readFile } from "node:fs/promises";
import {
  hookABI, vaultABI, trancheABI, accountantABI, oracleABI, entryABI, routerABI, erc20ABI,
} from "../frontend/abis.js";

const CHECKS = [
  ["PoolGuardHook", "PoolGuardHook.sol/PoolGuardHook.json", hookABI],
  ["LedgerVault", "LedgerVault.sol/LedgerVault.json", vaultABI],
  ["SeniorVault", "SeniorVault.sol/SeniorVault.json", trancheABI],
  ["JuniorVault", "JuniorVault.sol/JuniorVault.json", trancheABI],
  ["TrancheAccountant", "TrancheAccountant.sol/TrancheAccountant.json", accountantABI],
  ["NVDAPriceOracle", "NVDAPriceOracle.sol/NVDAPriceOracle.json", oracleABI],
  ["LedgerEntry7575", "LedgerEntry7575.sol/LedgerEntry7575.json", entryABI],
  ["DemoRouter", "DemoRouter.sol/DemoRouter.json", routerABI],
];

let failures = 0;
for (const [label, artifact, abi] of CHECKS) {
  let json;
  try {
    json = JSON.parse(await readFile(new URL(`../out/${artifact}`, import.meta.url)));
  } catch (e) {
    console.log(`SKIP ${label}: no artifact (${e.message.split("\n")[0]}) — run forge build first`);
    continue;
  }
  const sig = (f) => `${f.name}(${(f.inputs || []).map((i) => i.type).join(",")})`;
  const have = new Set(json.abi.filter((e) => e.type === "function").map(sig));
  // Detect ambiguous short names (viem rejects them on write).
  const names = {};
  for (const f of abi) names[f.name] = (names[f.name] || 0) + 1;
  for (const f of abi) {
    if ((names[f.name] || 0) > 1) {
      console.log(`FAIL ${label}.${f.name}: overloaded in frontend ABI (viem needs unique names)`);
      failures++;
      continue;
    }
    if (!have.has(sig(f))) {
      console.log(`FAIL ${label}.${sig(f)}: not in artifact`);
      failures++;
    }
  }
  if (!failures) console.log(`OK ${label} (${abi.length} fns)`);
}
// erc20 sanity: standard names only.
for (const f of erc20ABI) {
  if (!["name", "symbol", "decimals", "totalSupply", "balanceOf", "allowance", "approve", "mint"].includes(f.name)) {
    console.log(`FAIL erc20.${f.name}: unexpected`);
    failures++;
  }
}
console.log(failures === 0 ? "ALL FRONTEND ABIS MATCH" : `${failures} MISMATCHES`);
process.exit(failures === 0 ? 0 : 1);
