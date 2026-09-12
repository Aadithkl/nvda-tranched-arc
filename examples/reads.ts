import { formatUnits } from "viem";
import { publicClient } from "./client";
import { contracts, oracleAbi, pools, stateViewAbi, quoterAbi } from "./contracts";

// Stock price: viem returns a named object; mid has 8 decimals
export async function readStockPrice() {
  const p = await publicClient.readContract({
    address: contracts.nvdAPriceOracle as `0x${string}`,
    abi: oracleAbi,
    functionName: "getPrice",
  });
  return {
    mid: formatUnits(p.mid, 8),
    marketStatus: Number(p.marketStatus),
    session: Number(p.session),
    valid: p.valid,
    paymentRef: p.paymentRef,
  };
}

// v4 pool state: prefers the USDC/NVDA venue pool, falls back to the live demo pool
export async function readUsdcNvdaPool() {
  const pool = pools.usdcNvda ?? pools.demoNvdaUsdc;
  const poolId = pool.poolId as `0x${string}`;
  const [sqrtPriceX96, tick, , lpFee] = await publicClient.readContract({
    address: contracts.stateView as `0x${string}`,
    abi: stateViewAbi,
    functionName: "getSlot0",
    args: [poolId],
  });
  const liquidity = await publicClient.readContract({
    address: contracts.stateView as `0x${string}`,
    abi: stateViewAbi,
    functionName: "getLiquidity",
    args: [poolId],
  });
  // human price = raw price * 10^(dec0 - dec1); NVDA is 18d, USDC is 6d
  const nvdaIsToken0 =
    pool.key.currency0.toLowerCase() === contracts.mNvda.toLowerCase() ||
    (contracts.nvda != null && pool.key.currency0.toLowerCase() === contracts.nvda.toLowerCase());
  const dec0 = nvdaIsToken0 ? 18 : 6;
  const dec1 = nvdaIsToken0 ? 6 : 18;
  const human = 1.0001 ** Number(tick) * 10 ** (dec0 - dec1); // token1 per token0
  const usdPerNvda = nvdaIsToken0 ? human : 1 / human;
  return {
    tick: Number(tick),
    lpFee: Number(lpFee),
    liquidity: liquidity.toString(),
    usdPerNvda,
    sqrtPriceX96: sqrtPriceX96.toString(),
  };
}

// Quote an exact-input swap (see V4Quoter ABI for the tuple shape)
export async function quoteUsdcToNvda(amountIn: bigint) {
  const pool = pools.usdcNvda ?? pools.demoNvdaUsdc;
  const tokenIn = [pool.key.currency0, pool.key.currency1].some(
    (currency) => currency.toLowerCase() === contracts.usdc.toLowerCase(),
  )
    ? contracts.usdc
    : contracts.mUsdc;
  const zeroForOne = pool.key.currency0.toLowerCase() === tokenIn.toLowerCase();
  return publicClient.readContract({
    address: contracts.v4Quoter as `0x${string}`,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [pool.key, zeroForOne, amountIn, "0x"],
  });
}
