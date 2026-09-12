# Frontend Integration

Everything a frontend needs: addresses, ABIs, chain config, flows, and gotchas.

## Files

| Artifact | Location |
|---|---|
| Deployment manifest (source of truth) | `deployments/arc-testnet.json` |
| ABIs (trimmed JSON) | `docs/abis/*.json` |
| Copy-paste snippets | `examples/` |
| Regenerate pack after redeploys | `npm run export:pack` |

## Dependencies

```bash
npm install viem
# optional: wagmi @tanstack/react-query
# Circle passkey + gasless wallets:
npm install @circle-fin/modular-wallets-core
```

## Chain config

```ts
import { defineChain } from "viem";

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
  blockExplorers: { default: { name: "ArcScan", url: "https://testnet.arcscan.app" } },
  testnet: true,
});
```

Wallets need `wallet_addEthereumChain` with `{ chainId: "0x4CEF52", chainName: "Arc Testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: ["https://rpc.testnet.arc.network"] }`.

**Decimals gotcha:** native USDC (gas) uses 18 decimals; the ERC-20 interface at
`0x3600…0000` uses **6 decimals** and shares the same balance. Always use the ERC-20
interface for balances/transfers and format fees as USDC (never "ETH"/"gwei").

## Reading

```ts
import { createPublicClient, http } from "viem";
import { arcTestnet } from "./arc";
import manifest from "../deployments/arc-testnet.json";
import oracleAbi from "../docs/abis/NVDAPriceOracle.json";
import stateViewAbi from "../docs/abis/StateView.json";

const client = createPublicClient({ chain: arcTestnet, transport: http(manifest.network.rpc) });

// Stock price (tuple decodes to a named object)
const p = await client.readContract({
  address: manifest.oracle.address,
  abi: oracleAbi,
  functionName: "getPrice",
});
// p.mid (8 decimals), p.marketStatus (1 pre / 2 regular / 3 post / 4 overnight / 5 closed),
// p.valid requires fresh (300s) + market open

// v4 pool state by poolId
const [sqrtPriceX96, tick, protocolFee, lpFee] = await client.readContract({
  address: manifest.contracts.stateView,
  abi: stateViewAbi,
  functionName: "getSlot0",
  args: [manifest.pools.usdcEurc.poolId],
});
const liquidity = await client.readContract({
  address: manifest.contracts.stateView,
  abi: stateViewAbi,
  functionName: "getLiquidity",
  args: [manifest.pools.usdcEurc.poolId],
});
```

Quoting: `V4Quoter.quoteExactInputSingle(poolKey, zeroForOne, exactAmount, hookData)`
(ABI in `docs/abis/V4Quoter.json`). PoolKey is
`{ currency0, currency1, fee, tickSpacing, hooks }` — take it from the manifest
(`pools.*.key`); a pool is identified by the full key, not just the pair.

## Writing

### Swaps (DemoRouter, MIT, hookData-capable)

```ts
import { maxUint256, parseUnits } from "viem";
import erc20Abi from "../docs/abis/ERC20.json";
import routerAbi from "../docs/abis/DemoRouter.json";

await wallet.writeContract({
  address: manifest.contracts.usdc,
  abi: erc20Abi,
  functionName: "approve",
  args: [manifest.contracts.demoRouter, maxUint256],
});

await wallet.writeContract({
  address: manifest.contracts.demoRouter,
  abi: routerAbi,
  functionName: "swapExactIn",
  args: [
    manifest.pools.usdcEurc.key,
    true,                      // zeroForOne: USDC -> EURC
    parseUnits("1", 6),        // exact input
    0n,                        // minAmountOut (use a quote in production)
    account.address,           // recipient
    "0x",                      // hookData (forwarded verbatim to hooks)
  ],
});
```

Liquidity: `addLiquidity(key, tickLower, tickUpper, liquidityDelta, amount0Max, amount1Max, recipient, hookData)`.

### Standard v4 LP (PositionManager)

For NFT positions use `PositionManager` (`0x7Cdf…`) with the actions API
(`MINT_POSITION`, `SETTLE_PAIR`, …) and Permit2 approvals
(`manifest.contracts.permit2`). This mirrors the canonical Uniswap v4 periphery; the
ABI is in `docs/abis/PositionManager.json`.

## Tranche stack (v3, dual-token USDC/equity)

**Source of truth:** `deployments/arc-testnet.json` (`stack`). Addresses change on every redeploy —
read them from the manifest (or `npm run export:pack` output), never hardcode. ABIs live in
`docs/abis/` (`TranchePipeModule`, `SeniorVault`, `JuniorVault`, `TrancheAccountant`, `HookShareToken`,
`StrategyController`, `StrategyAgent`).

Current test deployment (v2, **test-only**; v3 replaces these):

| Contract | Address |
|---|---|
| `TrancheJITHook` | `0xB229976cB5F64C6f747033c26217299AeCD42Ac0` |
| `TranchePipeModule` (v2 pipe is the hook; v3 uses this module) | pending v3 redeploy |
| `HookShareToken` | `0x917386b70E03cdC2026B612fd1388d9DfC349C96` |
| `TrancheAccountant` | `0x3903C50fB7066C9a2d473d772e4dA48cfb4563a4` |
| `SeniorVault` / `JuniorVault` | `0x708C2FF1d6829cf1980da8Ad4f6A1f14F958018e` / `0x19858E406Eb262CdD899AF8Dc2aa866521b3135c` |
| `StrategyController` / `StrategyAgent` | `0x6ea148829e32ba3051869f73092c015d34661edd` / `0x636bfd9e072c9ba93453a2d798cb7d09b8fe1e8c` |

### Deposit (USDC-only entry)

```ts
await wallet.writeContract({ address: usdc, abi: erc20Abi, functionName: "approve",
  args: [vault, parseUnits("100", 6)] });
const shares = await wallet.writeContract({ address: vault, abi: seniorVaultAbi,
  functionName: "depositUSDC", args: [parseUnits("100", 6), account.address] });
// gate with vault.maxDeposit(receiver) (0 when paused or at cap)
```

### Redeem (async, keeper-fulfilled, then claim in the chosen asset)

1. `requestRedeem(shares, controller, owner)` — locks shares; track with
   `pendingRedeemRequest(0, user)`.
2. Keeper calls `TrancheAccountant.fulfillRedeem(senior, user)` → `Rebalance` + rate lock;
   check `claimableRedeemRequest(0, user)` / `maxRedeem(user)`.
3. Claim-and-unwrap (one tx):
   - `claimAndUnwrapUSDC(shares, receiver, controller)` — both tranches
   - `claimAndUnwrapEquity(shares, receiver, controller, minEquityOut)` — **junior only** (in-kind equity, oracle-priced, conversion fee stays in pool)
   - `claimAndUnwrapProportional(shares, receiver, controller, minUsdcOut, minEquityOut)` — **junior only** (oracle-free unit fractions; always available)

Senior vaults revert `SeniorUsdcOnly` for the equity/proportional paths.

### Reads for UI

| Value | Call |
|---|---|
| Book composition + hard cap | `TranchePipeModule.assetComposition()` → `(usdcValue, equityValue, equityBps)`, `hardMaxEquityBps()` |
| Tranche entitlements | `TrancheAccountant.seniorClaim()`, `juniorClaim()`, `escrowFunded()` |
| Quoting state | `TrancheJITHook.previewQuote(zeroForOne)`, `quoteState()`, `effectiveMaxDeploy()` |
| Share NAV | `TrancheJITHook.convertToUsdc(shares)` (USDC-denominated) |

Oracle staleness (`getPrice().valid`, 300s) blocks in-kind equity exits and rebalancing; proportional
exits remain available when the oracle is stale.

## Circle Modular Wallets (passkey + gasless)

```ts
import {
  toPasskeyTransport,
  toWebAuthnCredential,
  toModularTransport,
  toCircleSmartAccount,
  WebAuthnMode,
} from "@circle-fin/modular-wallets-core";
import { createPublicClient } from "viem";
import { createBundlerClient, toWebAuthnAccount } from "viem/account-abstraction";
import { arcTestnet } from "./arc";

const clientUrl = "https://modular-sdk.circle.com/v1/rpc/w3s/buidl";
const clientKey = process.env.NEXT_PUBLIC_CIRCLE_CLIENT_KEY!;

const passkeyTransport = toPasskeyTransport(clientUrl, clientKey);
const credential = await toWebAuthnCredential({
  transport: passkeyTransport,
  mode: WebAuthnMode.Register, // or Login for returning users
  username: "user@example.com",
});

const modularTransport = toModularTransport(`${clientUrl}/arcTestnet`, clientKey);
const client = createPublicClient({ chain: arcTestnet, transport: modularTransport });
const smartAccount = await toCircleSmartAccount({ client, owner: toWebAuthnAccount({ credential }) });
const bundlerClient = createBundlerClient({ account: smartAccount, chain: arcTestnet, transport: modularTransport });

// gasless contract call (testnet sponsorship is automatic)
const userOpHash = await bundlerClient.sendUserOperation({
  calls: [{ to: manifest.contracts.demoRouter, data: encodedSwapCalldata }],
  paymaster: true,
});
```

Requirements: Circle Console **Client Key** + a **passkey domain** matching its web
domain. Use `encodeFunctionData` from viem to build `calls[].data`.

## Keeper / oracle freshness

`oracle.getPrice().valid` is `false` when the price is older than 300s or the market is
closed. The keeper (`scripts/x402-price.mjs --gateway --push`) refreshes it. The UI
should show "stale / market closed" from `valid`, `marketStatus`, and
`sourceTimestamp`.

## Events & errors

- Oracle: `PriceUpdated(writer, mid, marketStatus, sourceTimestamp, paymentRef, updatedAt)`
- PoolManager: `Initialize(...)`, `Swap(id, sender, amount0, amount1, sqrtPriceX96, liquidity, tick, fee)`
- DemoRouter errors: `SlippageExceeded()`, `AmountExceeded(amount0, amount1)`, `DeadlineExpired()`,
  `ZeroAmount()`
- Oracle errors: `NotWriter(caller)`, `IsPaused()`, `InvalidPrice(mid)`, `InvalidMarketStatus(status)`

Subgraph (indexed values/history): live at `manifest.subgraph.url` (Graph Studio `tranch-stock`,
`version/latest`); see `docs/GRAPH.md`.

## Critical gotchas

1. **Arc compliance precompile:** USDC `transferFrom` calls `0x1800…0001 isBlocklisted`,
   which local EVM simulators (Foundry) cannot emulate. Do not gate real-USDC flows on
   local simulation — send via a node RPC (viem) and verify receipts.
2. **Pool keys:** always use `pools.*.key` from the manifest; different fee/tickSpacing/hooks
   means a different pool.
3. **Oracle tuple:** viem returns a named object for `getPrice()` (not an array).
4. **Native vs ERC-20 USDC:** 18 vs 6 decimals — only use the ERC-20 interface.
5. **Permit2:** required for `PositionManager` flows.
6. **Hook pools:** the live mNVDA/mUSDC and USDC/EURC pools have `hooks: 0x0`; a hook-bound
   pool is a different poolId (see `pools.smokeHookPool`).

## Env template

```bash
NEXT_PUBLIC_ARC_RPC=https://rpc.testnet.arc.network
NEXT_PUBLIC_MANIFEST=../deployments/arc-testnet.json
NEXT_PUBLIC_CIRCLE_CLIENT_KEY=
NEXT_PUBLIC_GRAPH_URL=
```

## Checklist

- [ ] Arc chain added to wallet (`0x4CEF52`)
- [ ] USDC balance shown from ERC-20 `balanceOf` (6d), gas in native 18d
- [ ] Oracle price read with staleness/session handling
- [ ] Pool state read via StateView
- [ ] Swap flow uses pool key from manifest + minOut from a quote
- [ ] Passkey onboarding via Circle Modular Wallets
- [ ] No local simulation of real-USDC flows
