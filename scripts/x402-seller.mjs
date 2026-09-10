import fs from "node:fs";
import express from "express";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";

function loadEnv(file = ".env") {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match) process.env[match[1]] ??= match[2].replace(/^["']|["']$/g, "");
  }
}

async function fetchNvdaFromYahoo() {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/NVDA?interval=1m&range=1d";
  const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`yahoo HTTP ${response.status}`);
  const payload = await response.json();
  const meta = payload?.chart?.result?.[0]?.meta;
  if (!meta || typeof meta.regularMarketPrice !== "number") throw new Error("yahoo: no regularMarketPrice");
  return {
    symbol: "NVDA",
    price: meta.regularMarketPrice,
    previousClose: meta.chartPreviousClose ?? null,
    exchange: meta.exchangeName ?? null,
    asOf: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : new Date().toISOString(),
    source: "yahoo-finance",
  };
}

loadEnv();

const sellerAddress = process.env.X402_SELLER_ADDRESS;
if (!sellerAddress) throw new Error("Set X402_SELLER_ADDRESS in .env (must differ from the payer wallet)");

const price = process.env.X402_SELLER_PRICE || "$0.001";
const port = Number(process.env.X402_SELLER_PORT || 4021);
const facilitatorUrl = process.env.GATEWAY_FACILITATOR_URL || "https://gateway-api-testnet.circle.com";

const gateway = createGatewayMiddleware({
  sellerAddress,
  networks: ["eip155:5042002"],
  facilitatorUrl,
  description: "NVDA/USD stock quote (x402 on Arc Testnet)",
});

gateway.onAfterSettle(() => {
  console.log(`[settled] ${new Date().toISOString()}`);
});

const app = express();

app.get("/health", (_req, res) => {
  res.json({ ok: true, seller: sellerAddress, price, facilitatorUrl });
});

app.get("/api/nvda", gateway.require(price), async (_req, res) => {
  try {
    const quote = await fetchNvdaFromYahoo();
    res.json({ ticker: "NVDA", data: quote, source: "x402-seller", as_of: quote.asOf });
  } catch (error) {
    res.status(502).json({ error: `quote unavailable: ${error.message}` });
  }
});

app.listen(port, () => {
  console.log(`x402 seller listening on http://127.0.0.1:${port}`);
  console.log(`  seller:    ${sellerAddress}`);
  console.log(`  price:     ${price} per call`);
  console.log(`  facilitator: ${facilitatorUrl}`);
});
