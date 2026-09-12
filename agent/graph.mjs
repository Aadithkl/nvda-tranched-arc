// Minimal Graph gateway client: API key, retries with backoff, error classification.
const RETRYABLE = /bad indexers|too far behind|Timeout|TimeoutError|indexing_error|503|502|504|429/i;

export function apiKey() {
  const key = process.env.GRAPH_API_KEY;
  if (!key) throw new Error("GRAPH_API_KEY not set");
  return key;
}

export function endpoint(subgraphId) {
  return `https://gateway.thegraph.com/api/${apiKey()}/subgraphs/id/${subgraphId}`;
}

export async function gql(url, query, variables = {}, { retries = 4, backoffMs = 1500, timeoutMs = 30000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
        if (RETRYABLE.test(String(response.status))) throw lastError;
        throw Object.assign(lastError, { fatal: true });
      }
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        lastError = new Error(`invalid JSON: ${text.slice(0, 160)}`);
        throw lastError;
      }
      if (json.errors?.length) {
        const message = json.errors.map((e) => e.message).join("; ");
        lastError = new Error(message);
        if (!RETRYABLE.test(message)) throw Object.assign(lastError, { fatal: true });
        throw lastError;
      }
      return json.data;
    } catch (error) {
      lastError = error;
      if (error.fatal || attempt === retries) break;
      await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
    }
  }
  throw Object.assign(lastError ?? new Error("graph request failed"), { graph: true });
}

// v3-schema pool state (Uniswap v3 / Aerodrome Slipstream compatible).
export async function fetchPool(url, poolId) {
  const data = await gql(
    url,
    `query ($id: ID!) {
      pool(id: $id) {
        id
        feeTier
        tick
        liquidity
        sqrtPrice
        totalValueLockedUSD
        volumeUSD
        feesUSD
        token0Price
        token1Price
        totalValueLockedToken0
        totalValueLockedToken1
        token0 { id symbol decimals }
        token1 { id symbol decimals }
      }
    }`,
    { id: poolId.toLowerCase() },
  );
  return data.pool;
}

export async function fetchPoolHours(url, poolId, hours = 336) {
  const data = await gql(
    url,
    `query ($id: String!, $first: Int!, $skip: Int!) {
      poolHourDatas(
        first: $first
        skip: $skip
        orderBy: periodStartUnix
        orderDirection: desc
        where: { pool: $id }
      ) {
        periodStartUnix
        open
        high
        low
        close
        volumeUSD
        feesUSD
        tvlUSD
      }
    }`,
    { id: poolId.toLowerCase(), first: Math.min(hours, 1000), skip: 0 },
  );
  return data.poolHourDatas;
}

export async function fetchPoolDays(url, poolId, days = 30) {
  const data = await gql(
    url,
    `query ($id: String!, $first: Int!) {
      poolDayDatas(
        first: $first
        orderBy: date
        orderDirection: desc
        where: { pool: $id }
      ) {
        date
        volumeUSD
        feesUSD
        tvlUSD
        open
        high
        low
        close
      }
    }`,
    { id: poolId.toLowerCase(), first: days },
  );
  return data.poolDayDatas;
}

// Total liquidity gross across initialized ticks (used for the active-share proxy).
export async function fetchTicks(url, poolId) {
  const data = await gql(
    url,
    `query ($id: String!, $first: Int!) {
      ticks(first: $first, orderBy: tickIdx, orderDirection: asc, where: { pool: $id }) {
        tickIdx
        liquidityGross
        liquidityNet
      }
    }`,
    { id: poolId.toLowerCase(), first: 1000 },
  );
  return data.ticks;
}
