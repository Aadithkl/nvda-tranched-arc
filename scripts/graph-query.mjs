import fs from "node:fs";

const DEFAULT_QUERY = `{
  oracleState(id: "global") {
    primarySource
    lastSource
    marketStatus
    lastMid
    lastBid
    lastAsk
    lastObservationsTimestamp
    lastPaymentRef
    totalUpdates
  }
  pools {
    id
    sqrtPriceX96
    tick
    liquidity
    swapCount
  }
}`;

const url = process.env.GRAPH_URL;
if (!url) {
  console.error("Set GRAPH_URL to the subgraph query endpoint (Graph Studio or gateway)");
  process.exit(1);
}

const apiKey = process.env.GRAPH_API_KEY;
const queryFile = process.argv[2];
const query = queryFile && fs.existsSync(queryFile) ? fs.readFileSync(queryFile, "utf8") : DEFAULT_QUERY;

const response = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  },
  body: JSON.stringify({ query }),
});

const payload = await response.json();
if (!response.ok || payload.errors) {
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(payload.data, null, 2));
