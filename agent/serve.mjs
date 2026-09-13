// Minimal HTTP bridge so the frontend can trigger one agent tick on demand.
//
//   npm run agent:serve              # dry-run ticks only (safe)
//   npm run agent:serve -- --submit  # allow broadcasting through StrategyAgent
//
// GET  /health -> { ok, running }
// POST /tick   -> runs one perceive+act cycle, returns the agent summary as JSON
// POST /tick?refresh=1 -> also forces a fresh Graph market snapshot (agent/market.mjs)
import http from "node:http";
import { tick } from "./index.mjs";

const port = Number(process.env.AGENT_HTTP_PORT || 8787);
const submit = process.argv.includes("--submit");
const forceMarket = process.argv.includes("--force-market");
let running = false;

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", ...cors });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  const url = req.url ?? "/";

  if (url.startsWith("/health")) {
    json(res, 200, { ok: true, running, submit });
    return;
  }

  if (url.startsWith("/tick")) {
    if (running) {
      json(res, 429, { ok: false, error: "a tick is already running" });
      return;
    }
    running = true;
    const startedAt = Date.now();
    try {
      const refresh = forceMarket || /[?&]refresh=1/.test(url);
      const summary = await tick({ forceRefresh: refresh });
      json(res, 200, { ok: true, elapsedMs: Date.now() - startedAt, ...summary });
    } catch (error) {
      json(res, 500, { ok: false, error: error.shortMessage || error.message });
    } finally {
      running = false;
    }
    return;
  }

  json(res, 404, { ok: false, error: "use GET /health or POST /tick" });
});

server.listen(port, "127.0.0.1", () => {
  console.log(
    `[agent-serve] listening on http://127.0.0.1:${port} (${submit ? "SUBMIT" : "dry-run"} mode${
      forceMarket ? ", always refreshing market data" : ""
    })`,
  );
});
