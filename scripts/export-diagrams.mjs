// Export every Mermaid diagram source in docs/diagrams to an SVG in docs/assets.
//
//   npm run diagrams:export
//
// Uses @mermaid-js/mermaid-cli via npx. If a system Chrome/Edge exists, point puppeteer
// at it to skip the Chromium download:
//
//   PowerShell:  $env:PUPPETEER_EXECUTABLE_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"
//   bash:        export PUPPETEER_EXECUTABLE_PATH="/usr/bin/google-chrome"
//
// Without that variable, puppeteer downloads its own Chromium on first run.
import { execSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const srcDir = path.join(root, "docs", "diagrams");
const outDir = path.join(root, "docs", "assets");

mkdirSync(outDir, { recursive: true });

const files = readdirSync(srcDir).filter((file) => file.endsWith(".mmd")).sort();
let failed = 0;

for (const file of files) {
  const out = path.join(outDir, file.replace(/\.mmd$/, ".svg"));
  const cmd = `npx -y @mermaid-js/mermaid-cli -i "${path.join(srcDir, file)}" -o "${out}" -b transparent`;
  try {
    execSync(cmd, { stdio: ["ignore", "ignore", "pipe"] });
    console.log(`ok   ${file} -> docs/assets/${path.basename(out)}`);
  } catch (error) {
    failed += 1;
    const detail = String(error.stderr || error.message || "").trim().split("\n").slice(-3).join(" ");
    console.error(`fail ${file}: ${detail}`);
  }
}

if (failed > 0) {
  console.error(`${failed} diagram(s) failed to export`);
  process.exit(1);
}
console.log(`exported ${files.length} diagrams`);
