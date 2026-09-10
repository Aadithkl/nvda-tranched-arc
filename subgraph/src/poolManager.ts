import { BigInt } from "@graphprotocol/graph-ts";
import { Initialize, Swap } from "../generated/PoolManager/PoolManager";
import { Pool, PoolSwap } from "../generated/schema";

export function handleInitialize(event: Initialize): void {
  let pool = new Pool(event.params.id.toHexString());
  pool.currency0 = event.params.currency0;
  pool.currency1 = event.params.currency1;
  pool.fee = BigInt.fromI32(event.params.fee);
  pool.tickSpacing = BigInt.fromI32(event.params.tickSpacing);
  pool.hooks = event.params.hooks;
  pool.sqrtPriceX96 = event.params.sqrtPriceX96;
  pool.tick = BigInt.fromI32(event.params.tick);
  pool.liquidity = BigInt.zero();
  pool.volume0 = BigInt.zero();
  pool.volume1 = BigInt.zero();
  pool.swapCount = BigInt.zero();
  pool.initializedAtTimestamp = event.block.timestamp;
  pool.updatedAtTimestamp = event.block.timestamp;
  pool.save();
}

export function handleSwap(event: Swap): void {
  let pool = Pool.load(event.params.id.toHexString());
  if (pool == null) return;

  pool.sqrtPriceX96 = event.params.sqrtPriceX96;
  pool.tick = BigInt.fromI32(event.params.tick);
  pool.liquidity = event.params.liquidity;
  pool.volume0 = pool.volume0.plus(event.params.amount0);
  pool.volume1 = pool.volume1.plus(event.params.amount1);
  pool.swapCount = pool.swapCount.plus(BigInt.fromI32(1));
  pool.updatedAtTimestamp = event.block.timestamp;
  pool.save();

  let swap = new PoolSwap(event.transaction.hash.toHexString() + "-" + event.logIndex.toString());
  swap.pool = pool.id;
  swap.sender = event.params.sender;
  swap.amount0 = event.params.amount0;
  swap.amount1 = event.params.amount1;
  swap.sqrtPriceX96 = event.params.sqrtPriceX96;
  swap.liquidity = event.params.liquidity;
  swap.tick = BigInt.fromI32(event.params.tick);
  swap.fee = BigInt.fromI32(event.params.fee);
  swap.transactionHash = event.transaction.hash;
  swap.timestamp = event.block.timestamp;
  swap.blockNumber = event.block.number;
  swap.save();
}
