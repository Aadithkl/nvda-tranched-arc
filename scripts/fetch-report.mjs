import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const FEEDS = {
  regular: "0x000b1d444945231e44dd47736c6abe288b10cb1b53941c7c68012fbdd2b1755c",
  extended: "0x000bf689e4aa5c006c89c207eb155ae99184e433a518753eb745cc552391a743",
  overnight: "0x000b99b86a91cc317e2db8370f1466844dd9460cb51c3bf12fcc8d19d53d97bb",
};

const HOST = "api.testnet-dataengine.chain.link";

function loadEnv(file = ".env") {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match) process.env[match[1]] ??= match[2].replace(/^["']|["']$/g, "");
  }
}

function authHeaders(method, fullPath, apiKey, apiSecret) {
  const timestamp = Date.now();
  const bodyHash = crypto.createHash("sha256").update("").digest("hex");
  const stringToSign = `${method} ${fullPath} ${bodyHash} ${apiKey} ${timestamp}`;
  const signature = crypto.createHmac("sha256", apiSecret).update(stringToSign).digest("hex");
  return {
    Authorization: apiKey,
    "X-Authorization-Timestamp": String(timestamp),
    "X-Authorization-Signature-SHA256": signature,
  };
}

async function fetchLatest(feedID, apiKey, apiSecret) {
  const fullPath = `/api/v1/reports/latest?feedID=${feedID}`;
  const res = await fetch(`https://${HOST}${fullPath}`, {
    headers: authHeaders("GET", fullPath, apiKey, apiSecret),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body}`);
  return JSON.parse(body).report;
}

async function main() {
  loadEnv();
  const apiKey = process.env.CHAINLINK_DATASTREAMS_KEY;
  const apiSecret = process.env.CHAINLINK_DATASTREAMS_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error("Set CHAINLINK_DATASTREAMS_KEY and CHAINLINK_DATASTREAMS_SECRET in .env");
  }

  const which = process.argv[2] ?? "all";
  const names = which === "all" ? Object.keys(FEEDS) : [which];
  const outDir = path.join("test", "fixtures");
  fs.mkdirSync(outDir, { recursive: true });

  for (const name of names) {
    const feedID = FEEDS[name];
    if (!feedID) throw new Error(`Unknown feed: ${name}`);
    const report = await fetchLatest(feedID, apiKey, apiSecret);
    const payload = { ...report, fetchedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(outDir, `nvda-report-${name}.json`), JSON.stringify(payload, null, 2));
    console.log(
      `${name}: observationsTimestamp=${report.observationsTimestamp} fullReport=${report.fullReport.slice(0, 22)}...`
    );
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
