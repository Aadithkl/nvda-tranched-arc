// Local JSON-RPC proxy for Robinhood Chain. The public endpoint sits behind a Cloudflare
// managed challenge that rejects non-browser user agents, which breaks `forge --fork-url`
// and anvil. This proxy forwards JSON-RPC POSTs upstream with browser-like headers so
// foundry can fork through http://127.0.0.1:8546.
//
//   npm run robinhood:proxy            # terminal 1 (leave running)
//   ROBINHOOD_RPC_URL=http://127.0.0.1:8546 forge test --match-path test/fork/RobinhoodFork.t.sol
//
// Upstream is the public RPC unless UPSTREAM_RPC_URL is set (use a provider RPC if you have one).
import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 8546);
const UPSTREAM = process.env.UPSTREAM_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";

const HEADERS = {
  accept: "application/json",
  "content-type": "application/json",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  origin: "https://robinhood.com",
  referer: "https://robinhood.com/",
};

const server = createServer(async (req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`rpc-proxy -> ${UPSTREAM}\n`);
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const started = Date.now();
  try {
    const upstream = await fetch(UPSTREAM, { method: "POST", headers: HEADERS, body });
    const text = await upstream.text();
    res.writeHead(upstream.status, { "content-type": "application/json" });
    res.end(text);
    let method = "?";
    try {
      method = JSON.parse(body.toString()).method;
    } catch {}
    if (process.env.VERBOSE) console.log(`${method} ${upstream.status} ${Date.now() - started}ms`);
  } catch (err) {
    console.error(`proxy error: ${err.message}`);
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: err.message }, id: null }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`rpc-proxy listening on http://127.0.0.1:${PORT} -> ${UPSTREAM}`);
  console.log(`fork with: ROBINHOOD_RPC_URL=http://127.0.0.1:${PORT} forge test --match-path test/fork/RobinhoodFork.t.sol`);
});
