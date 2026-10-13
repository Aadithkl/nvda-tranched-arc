import { readFile } from "node:fs/promises";
const html = await readFile(new URL("../frontend/index.html", import.meta.url), "utf8");
const js = await readFile(new URL("../frontend/app.js", import.meta.url), "utf8");
const idsHtml = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const usedList = [
  ...[...js.matchAll(/\$\("([^"]+)"\)|\$\('([^']+)'\)/g)].map((m) => m[1] || m[2]),
  ...[...js.matchAll(/\bval\("([^"]+)"\)|\bval\('([^']+)'\)/g)].map((m) => m[1] || m[2]),
  ...[...js.matchAll(/\bon\("([^"]+)",|\bon\('([^']+)',/g)].map((m) => m[1] || m[2]),
];
const used = new Set(usedList);
console.log(`call sites: ${usedList.length}, unique: ${used.size}`);
let bad = 0;
for (const u of used) {
  if (!idsHtml.has(u)) {
    console.log("MISSING IN HTML:", u);
    bad++;
  }
}
console.log(`${used.size} ids used, ${bad} missing`);
process.exit(bad ? 1 : 0);
