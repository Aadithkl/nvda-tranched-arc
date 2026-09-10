# Deployments

## Arc Testnet (chainId 5042002, RPC `https://rpc.testnet.arc.network`)

### x402 / Circle Gateway

| Item | Value |
|---|---|
| Gateway Wallet | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` |
| Gateway Minter | `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B` |
| Gateway Domain ID | `26` |
| Testnet facilitator | `https://gateway-api-testnet.circle.com` |
| Demo seller (`scripts/x402-seller.mjs`) | `0x25E7D4287eCDCFA04BF59aBEd594e51dc3DabaF3` |
| Latest x402 oracle update | tx `0xe559c8475e5e6a44e5a41947414b1a0e2b78f02e708db7d9068812ebf9726ca0` (block `61455589`, mid 218.36e8, status 3 = post-market) |

### Oracle — `NVDAPriceOracle` (x402 push, no Chainlink)

| Contract | Address |
|---|---|
| `NVDAPriceOracle` | `0x2D58dE768ABff2da0e4a00BE92f63DFB6CE0738A` |

- Deployment block: `61455183`
- Owner: `0x749E3A3a743889beC27584C1C8212f4cf926b431`
- Writer (x402 push): `0x749E3A3a743889beC27584C1C8212f4cf926b431`
- `maxStaleness`: 300s
- Deploy txs: `broadcast/DeployOracle.s.sol/5042002/run-latest.json`

### Uniswap v4 fork (M2a)

| Contract | Address |
|---|---|
| `PoolManager` | `0xF570d08D4388D6487E348C28c00D714a347D33c4` |
| `DemoRouter` | `0x2022D0876132E26f32Df4a3bDdF2cFcB96010B28` |
| `MockUSDC` (test-only, 6d) | `0x071E67900B728370969eFF988085CF3D84195E31` |
| `MockNVDA` (test-only, 18d) | `0x308F5c32fF62c24DA5F66f4F6d40d698B8d37BE9` |

- Demo pool: mUSDC/mNVDA, fee `3000`, tickSpacing `60`, no hook, initial tick `+196260`, liquidity `1e12`
- Verified onchain: liquidity added and a live swap executed successfully
- Deploy txs: `broadcast/DeployV4Fork.s.sol/5042002/run-latest.json`

### Not yet deployed

- `TrancheJITHook` (M3), `StrategyController` + agent (M4), Senior/Junior ERC-7540 vaults + ERC-7575 share (M5)
- Aave V2 fork with USDC/EURC/mNVDA reserves (M2b)

## Indexing (The Graph)

Subgraph in `subgraph/` (`arc-testnet`): `NVDAPriceOracle` + `PoolManager`.
Not yet deployed to Graph Studio (pending a Studio key); manifests carry the addresses
and start blocks above.

## Conventions

- `MockToken` deployments are test-only and clearly labeled; no mock is used in the oracle price path.
- Re-run deploy scripts through simulation first (`forge script ... --rpc-url <rpc>`), then `--broadcast`.
- Keys live only in local `.env`; never committed.
