# Subgraph MCP — cross-protocol analysis

The agent stack uses The Graph's hosted **Subgraph MCP** as a second Graph product: same API key,
tools for discovery (search 15,000+ subgraphs), schema lookup and query execution in natural
language. This is what makes the cross-protocol story one query pattern: the standardized
Messari `vaults { ... }` query runs against our Arc subgraph and any live Messari-standard
yield subgraph (e.g. Yearn v2) without writing a new integration.

## Endpoint

| | |
|---|---|
| Transport | SSE: `https://subgraphs.mcp.thegraph.com/sse` |
| Auth | `Authorization: Bearer <GRAPH_API_KEY>` (Studio gateway key) |
| Client bridge | `npx mcp-remote` (no local build) |

## Configure Claude Desktop

1. `Settings → Developer → Edit Config` (`%APPDATA%\Claude\claude_desktop_config.json` on Windows).
2. Paste the contents of `mcp/claude-desktop.json.example`, replacing `REPLACE_WITH_GRAPH_API_KEY`
   with your Studio gateway key (or paste the snippet below).
3. Restart Claude Desktop, start a chat, open the context menu and add the
   **"Subgraph Server Instructions"** resource (`graphql://subgraph`).
4. Cursor: same JSON under `Settings → MCP` (or `.cursor/mcp.json`).

```json
{
  "mcpServers": {
    "subgraph": {
      "command": "npx",
      "args": ["mcp-remote", "--header", "Authorization:${AUTH_HEADER}", "https://subgraphs.mcp.thegraph.com/sse"],
      "env": { "AUTH_HEADER": "Bearer <GRAPH_API_KEY>" }
    }
  }
}
```

## Tools exposed

- `search_subgraphs_by_keyword` — discovery (ordered by signal)
- `get_schema_by_subgraph_id` / `get_schema_by_deployment_id` / `get_schema_by_ipfs_hash`
- `execute_query_by_subgraph_id` / `execute_query_by_deployment_id` / `execute_query_by_ipfs_hash`
- `get_deployment_30_day_query_counts`
- `get_top_subgraph_deployments_for_contract`

## Demo script (for the video)

1. **Discovery**: "Find the top yield aggregator subgraphs on The Graph" → MCP returns candidates
   (Yearn v2, Gamma, Vesper…).
2. **Our protocol**: "Show the vaults and their TVL in subgraph `tranch-stock`" → the
   standardized `vaults` entities for the Arc share pipe.
3. **Cross-protocol, same query**: "Run the same `vaults` query against the Yearn v2 subgraph
   `FDLuaz69DbMADuBjJDEcLnTuPnjhZqNbFVrkNiBLGkEg` and compare cumulative revenue" → identical fields,
   different protocol/chain.
4. **Agent tie-in**: "Which pool currently offers the best fee-vs-IL edge for NVDAc?" — MCP reads
   the standardized data, the agent's model (`npm run market`) produces the verdict.

## Verified reference deployment (works today)

- Yearn v2 (Ethereum, Messari Yield Aggregator schema): `FDLuaz69DbMADuBjJDEcLnTuPnjhZqNbFVrkNiBLGkEg`
  — live via gateway (sample query returned `st-yCRV`, `yvWETH`, `yvUSDC` with TVL/revenue).

## Notes

- The MCP is a *read/analysis layer*; the agent's automated loop uses the gateway directly
  (`agent/graph.mjs`) so decisions never depend on an interactive client.
- No mock data: every MCP tool call hits The Graph Network.
