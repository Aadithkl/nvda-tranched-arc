import { maxUint256, parseUnits } from "viem";
import { walletFromKey } from "./client";
import { contracts, erc20Abi, pools, routerAbi } from "./contracts";

// NOTE: real-USDC flows must run against an RPC node (Arc's compliance precompile
// is not emulated by local EVM simulators).
export async function swapUsdcToNvda(privateKey: `0x${string}`, amountUsdc = "1") {
  const { account, wallet } = walletFromKey(privateKey);
  const amountIn = parseUnits(amountUsdc, 6);
  const pool = pools.usdcNvda ?? pools.demoNvdaUsdc;
  const tokenIn = [pool.key.currency0, pool.key.currency1].some(
    (currency) => currency.toLowerCase() === contracts.usdc.toLowerCase(),
  )
    ? contracts.usdc
    : contracts.mUsdc;
  const zeroForOne = pool.key.currency0.toLowerCase() === tokenIn.toLowerCase();

  await wallet.writeContract({
    address: tokenIn as `0x${string}`,
    abi: erc20Abi,
    functionName: "approve",
    args: [contracts.demoRouter as `0x${string}`, maxUint256],
  });

  const hash = await wallet.writeContract({
    address: contracts.demoRouter as `0x${string}`,
    abi: routerAbi,
    functionName: "swapExactIn",
    args: [
      pool.key,
      zeroForOne, // USDC in, NVDA out (direction follows the sorted pool key)
      amountIn,
      0n, // set minAmountOut from a quote in production
      account.address,
      "0x", // hookData forwarded verbatim to hooks
    ],
  });
  return hash;
}
