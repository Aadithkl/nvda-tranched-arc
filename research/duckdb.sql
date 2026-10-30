-- DuckDB scale path for the research swaps.
-- Install DuckDB, then: duckdb < research/duckdb.sql
--
-- The JSONL downloader writes one file per block chunk. DuckDB reads the glob,
-- dedupes the overlap, and writes Parquet partitioned by target/date.

CREATE OR REPLACE TABLE raw AS
SELECT *
FROM read_json_auto('research/data/swaps-60d/*/*.jsonl', union_by_name = true);

-- Keep one row per (txHash, logIndex) even if a resumed run overlaps a chunk.
CREATE OR REPLACE TABLE swaps AS
SELECT
  target,
  kind,
  CAST(feePips AS INTEGER) AS fee_pips,
  CAST(blockNumber AS BIGINT) AS block_number,
  CAST(logIndex AS INTEGER) AS log_index,
  txHash AS tx_hash,
  to_timestamp(CAST(timestamp AS DOUBLE)) AS ts,
  CAST(amount0 AS HUGEINT) AS amount0,
  CAST(amount1 AS HUGEINT) AS amount1,
  CAST(sqrtPriceX96 AS HUGEINT) AS sqrt_price_x96,
  CAST(liquidity AS HUGEINT) AS liquidity,
  CAST(tick AS INTEGER) AS tick,
  CAST(fee AS INTEGER) AS fee
FROM raw
QUALIFY row_number() OVER (PARTITION BY txHash, logIndex ORDER BY blockNumber) = 1;

CREATE OR REPLACE TABLE hourly AS
SELECT
  target,
  date_trunc('hour', ts) AS hour,
  count(*) AS swaps,
  sum(abs(amount0)) / 1e6 AS usdg_abs_volume,
  sum(abs(amount0)) / 1e6 * any_value(fee_pips) / 1e6 AS fee_usd_on_abs_usdg,
  avg(tick) AS avg_tick,
  min(tick) AS min_tick,
  max(tick) AS max_tick,
  stddev_pop(tick) AS tick_stddev
FROM swaps
GROUP BY 1, 2
ORDER BY 1, 2;

-- Example: 24h fee/volume per pool.
SELECT
  target,
  min(hour) AS from_hour,
  max(hour) AS to_hour,
  sum(usdg_abs_volume) AS volume_usd,
  sum(fee_usd_on_abs_usdg) AS fees_usd
FROM hourly
GROUP BY 1
ORDER BY 1;

COPY (SELECT * FROM swaps) TO 'research/data/parquet/swaps.parquet'
  (FORMAT PARQUET, PARTITION_BY (target, year(ts), month(ts)));
COPY (SELECT * FROM hourly) TO 'research/data/parquet/hourly.parquet'
  (FORMAT PARQUET, PARTITION_BY (target));
