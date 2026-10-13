// Zero-dependency static server for the testnet frontend.
// Usage: npm run frontend  (serves ./frontend on http://127.0.0.1:5173)
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../frontend/", import.meta.url));
// Explicitly mounted read-only data (never the repo root — .env holds keys).
const DEPLOY_JSON = fileURLToPath(new URL("../deployments/robinhood-testnet.json", import.meta.url));
const PORT = Number(process.env.PORT || 5173);
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

const server = createServer(async (req, res) => {
  try {
    const reqPath = new URL(req.url, "http://x").pathname;
    if (reqPath.includes("..")) throw new Error("bad path");
    if (reqPath === "/deployments/robinhood-testnet.json") {
      const body = await readFile(DEPLOY_JSON);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
      return;
    }
    // Normalize URL separators, then resolve strictly inside ROOT.
    const rel = normalize(reqPath).replace(/^[/\\]+/, "").split("/").join(sep);
    const file = rel === "" ? join(ROOT, "index.html") : join(ROOT, rel);
    const st = await stat(file);
    if (!st.isFile()) throw new Error("not found");
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`frontend on http://127.0.0.1:${PORT}`));
