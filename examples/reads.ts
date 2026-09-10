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

// v4 pool state (works for any pool in the manifest)
export async function readUsdcEurcPool() {
  const poolId = pools.usdcEurc.poolId as `0x${string}`;
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
  const price = 1.0001 ** Number(tick); // EURC per USDC
  return {
    tick: Number(tick),
    lpFee: Number(lpFee),
    liquidity: liquidity.toString(),
    usdPerEurc: 1 / price,
    sqrtPriceX96: sqrtPriceX96.toString(),
  };
}

// Quote an exact-input swap (see V4Quoter ABI for the tuple shape)
export async function quoteUsdcToEurc(amountIn: bigint) {
  return publicClient.readContract({
    address: contracts.v4Quoter as `0x${string}`,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [pools.usdcEurc.key, true, amountIn, "0x"],
  });
}
