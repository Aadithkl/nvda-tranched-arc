# Verification Guide

End-to-end checks for everything built so far. Requires `.env` (see `.env.example`)
with `DEPLOYER_ADDRESS`, `DEPLOYER_PRIVATE_KEY`, `ARC_RPC_URL`, `ORACLE_ADDRESS`.

## 1. Contracts

```bash
forge fmt --check
forge build
forge test
```

Expected: 22 tests pass (18 oracle + 4 router).

## 2. Deployed state (Arc Testnet)

```bash
RPC=https://rpc.testnet.arc.network

# x402 oracle: price + validity
cast call 0x2D58dE768ABff2da0e4a00BE92f63DFB6CE0738A \
  "getPrice()((int192,int192,int192,uint32,uint8,uint32,uint256,bytes32,bool))" --rpc-url $RPC

# writer allowlist
cast call 0x2D58dE768ABff2da0e4a00BE92f63DFB6CE0738A \
  "writers(address)(bool)" 0x749E3A3a743889beC27584C1C8212f4cf926b431 --rpc-url $RPC

# v4 fork: pool swap count (read via subgraph when deployed, or verify code exists)
cast code 0xF570d08D4388D6487E348C28c00D714a347D33c4 --rpc-url $RPC | wc -c
cast code 0x2022D0876132E26f32Df4a3bDdF2cFcB96010B28 --rpc-url $RPC | wc -c
```

Expected: `getPrice()` mid > 0, `valid = true` during market hours; writer `true`;
both contracts have code.

## 3. x402 payment loop (Circle Gateway on Arc)

```bash
# wallet + Gateway balances
node scripts/x402-price.mjs --gateway-balances

# terminal A: local Gateway-accepting seller ($0.001/call)
node scripts/x402-seller.mjs

# terminal B: pay on Arc, get NVDA, push onchain
X402_STOCK_URL=http://127.0.0.1:4021/api/nvda node scripts/x402-price.mjs --gateway --push
```

Expected: seller logs `[settled]`, keeper prints `pushed onchain: 0x…`, Gateway balance
decreases by `0.001`, and `getPrice()` shows the new mid with a fresh `paymentRef` equal
to `keccak256(settlementTx)`.

If Gateway balance is empty: `node scripts/x402-price.mjs --gateway-deposit 1`.

## 4. Subgraph

```bash
cd subgraph
npm install
npm run codegen
npm run build
```

Expected: `Build completed`. With a Graph Studio key:

```bash
npx graph auth --studio <DEPLOY_KEY>
npm run deploy:studio
GRAPH_URL="https://api.studio.thegraph.com/query/<id>/nvda-tranched-arc/<version>" \
GRAPH_API_KEY=<key> npm run graph:query
```

## 5. CI

`.github/workflows/ci.yml` runs contract checks and subgraph builds on every push.
