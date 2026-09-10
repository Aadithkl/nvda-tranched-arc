# Deployments

## Arc Testnet (chainId 5042002, RPC `https://rpc.testnet.arc.io`)

### Chainlink

| Contract | Address | Notes |
|---|---|---|
| Data Streams VerifierProxy | `0x72790f9eB82db492a7DDb6d2af22A270Dcc3Db64` | Live onchain; `s_feeManager() == 0` (no fee manager) |

### Oracle (M1)

| Contract | Address |
|---|---|
| `NVDAPriceOracle` | `0xa2c6489fA9b1dba1ec63f410AB042543c86aa15F` |

- Owner: `0x749E3A3a743889beC27584C1C8212f4cf926b431`
- Feeds configured: Regular / Extended / Overnight, 300s Chainlink staleness
- x402 staleness: 300s; `primarySource = 1` (ChainlinkStreams)
- Writer (x402 push): `0x749E3A3a743889beC27584C1C8212f4cf926b431`
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

## Conventions

- `MockToken` deployments are test-only and clearly labeled; no mock is used in the oracle price path.
- Re-run deploy scripts through simulation first (`forge script ... --rpc-url <rpc>`), then `--broadcast`.
- Keys live only in local `.env`; never committed.
