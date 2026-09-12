# Verification Guide

End-to-end checks for everything built so far. Requires `.env` (see `.env.example`)
with `DEPLOYER_ADDRESS`, `DEPLOYER_PRIVATE_KEY`, `ARC_RPC_URL`, `ORACLE_ADDRESS`.

## 1. Contracts

```bash
forge fmt --check
forge build --sizes
forge test
```

Expected: 27 tests pass (18 oracle + 4 router + 5 smoke hook).

## 2. Deployed state (Arc Testnet)

```bash
RPC=https://rpc.testnet.arc.network

# x402 oracle: price + validity
cast call 0x2D58dE768ABff2da0e4a00BE92f63DFB6CE0738A \
  "getPrice()((int192,int192,int192,uint32,uint8,uint32,uint256,bytes32,bool))" --rpc-url $RPC

# v4 core (PoolManager owner)
cast call 0xFc4146c0de93B518Ce60158e2eD0943697c3Ae67 "owner()(address)" --rpc-url $RPC

# periphery wiring
cast call 0x7Cdfa5f9369c3869c63B0fF0Ca89165Ae2B2b111 "poolManager()(address)" --rpc-url $RPC
cast call 0x7Cdfa5f9369c3869c63B0fF0Ca89165Ae2B2b111 "permit2()(address)" --rpc-url $RPC
cast call 0x7Cdfa5f9369c3869c63B0fF0Ca89165Ae2B2b111 "tokenDescriptor()(address)" --rpc-url $RPC
cast call 0xb60F573748341F202818B09730d59333392b8CcC "poolManager()(address)" --rpc-url $RPC
cast call 0x8f9ba259d70aF45c26Ef56A713Fb6F0159C4526B "poolManager()(address)" --rpc-url $RPC

# hook proof (beforeSwap/afterSwap fired; hookData delivered verbatim)
cast call 0x3Cee7340818FD498e54D44DA2E634d02a72800C0 \
  "swapCount(bytes32)(uint256)" 0x092c224a431c94b955394fcdd56fcccae4970b2223fcbd9796737e631a023677 --rpc-url $RPC
cast call 0x3Cee7340818FD498e54D44DA2E634d02a72800C0 \
  "lastHookDataHash(bytes32)(bytes32)" 0x092c224a431c94b955394fcdd56fcccae4970b2223fcbd9796737e631a023677 --rpc-url $RPC
cast keccak 0xfeed   # must equal lastHookDataHash
```

Expected: oracle `valid = true` during market hours; all periphery accessors return
`0xFc41…Ae67` (PoolManager) / permit2 `0x0000…78BA3` / descriptor `0x449d…7a4f`;
hook `swapCount = 1` and `lastHookDataHash = keccak256(0xfeed)`.

## 3. USDC/EURC FX pool

```bash
node scripts/seed-usdc-eurc.mjs            # read-only status
node scripts/seed-usdc-eurc.mjs --execute  # idempotent: approve/init/add
cast call 0xb60F573748341F202818B09730d59333392b8CcC \
  "getSlot0(bytes32)(uint160,int24,uint24,uint24)" \
  0xa88885c010d00afae2cc9db9e7f6c56e6c5a8fbaa22a1141fedbbdda6993ebd4 --rpc-url $RPC
```

Expected: `initialized = true`, `liquidity = 214639290`, `lpFee = 100`, tick near `-1499`.
Note: real-USDC flows must be sent via the viem script or `cast send` — Foundry's local
EVM does not emulate Arc's compliance precompile used by USDC `transferFrom`.

## 4. x402 payment loop (Circle Gateway on Arc)

```bash
node scripts/x402-price.mjs --gateway-balances

# terminal A: local Gateway-accepting seller ($0.001/call)
node scripts/x402-seller.mjs

# terminal B: pay on Arc, get NVDA, push onchain
X402_STOCK_URL=http://127.0.0.1:4021/api/nvda node scripts/x402-price.mjs --gateway --push
```

Expected: seller logs `[settled]`, keeper prints `pushed onchain: 0x…`, Gateway balance
decreases by `0.001`, oracle `getPrice()` shows the new mid with a fresh `paymentRef`
equal to `keccak256(settlementId)`.

If Gateway balance is empty: `node scripts/x402-price.mjs --gateway-deposit 1`.

## 5. Subgraph

```bash
cd subgraph
npm install
npm run codegen
npm run build
```

Expected: `Build completed`. With a Graph Studio key:

```bash
npx graph deploy tranch-stock --node https://api.studio.thegraph.com/deploy/ \
  --deploy-key <DEPLOY_KEY> --version-label v0.1.0
GRAPH_URL="https://api.studio.thegraph.com/query/<id>/tranch-stock/<version>" \
GRAPH_API_KEY=<key> npm run graph:query
```

## 6. CI

`.github/workflows/ci.yml` runs contract checks and subgraph builds on every push.
