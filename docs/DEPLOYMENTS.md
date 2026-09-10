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
| Latest x402 oracle update | tx `0x63640b6d9cc19814b1578cfdea1bb1b022d4228c2085c0936617ab10199f0264` (block `61456133`, mid 218.36e8, status 3 = post-market; paymentRef `0x1a1a…4f72` = keccak256 of the Circle settlement id) |

### Oracle — `NVDAPriceOracle` (x402 push, no Chainlink)

| Contract | Address |
|---|---|
| `NVDAPriceOracle` | `0x2D58dE768ABff2da0e4a00BE92f63DFB6CE0738A` |

- Deployment block: `61455183`
- Owner / writer: `0x749E3A3a743889beC27584C1C8212f4cf926b431`
- `maxStaleness`: 300s
- Deploy txs: `broadcast/DeployOracle.s.sol/5042002/run-latest.json`

### Uniswap v4 fork — core

| Contract | Address | Notes |
|---|---|---|
| `PoolManager` | `0xFc4146c0de93B518Ce60158e2eD0943697c3Ae67` | v4-core @ `59d3ecf5` (BUSL-1.1 → MIT; see `LICENSES.md`), owner = deployer |
| `Permit2` | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | canonical predeploy |
| `Multicall3` | `0xcA11bde05977b3631167028862bE2a173976CA11` | canonical predeploy |
| Deterministic CREATE2 deployer | `0x4e59b44847b379578588920cA78FbF26c0B4956C` | canonical predeploy |

### Uniswap v4 fork — periphery (v4-periphery @ `dce236d`, MIT)

| Contract | Address | Deploy method |
|---|---|---|
| `DemoRouter` (ours, MIT) | `0xC76fd7Ee062C5E498a0E2be6CcB7c2aD2dF0d062` | CREATE |
| `PositionDescriptor` | `0x449d1311782EC031087199d497bF05A35fCe7a4f` | CREATE2 salt `0x00` |
| `PositionManager` | `0x7Cdfa5f9369c3869c63B0fF0Ca89165Ae2B2b111` | CREATE2 salt `0x03` |
| `StateView` | `0xb60F573748341F202818B09730d59333392b8CcC` | CREATE2 salt `0x00` |
| `V4Quoter` | `0x8f9ba259d70aF45c26Ef56A713Fb6F0159C4526B` | CREATE2 salt `0x00` |
| `ReservesLens` | `0x8D98aa45020c81F4751271B70cecc6399659bCef` | CREATE2 project salt |
| `MockWETH9` (test-only) | `0x08Ac921E786a5e19eC5D053E4c4eabe3BE042f90` | CREATE; constructor dependency only |
| `MockUSDC` / `MockNVDA` (test-only) | `0x071E67900B728370969eFF988085CF3D84195E31` / `0x308F5c32fF62c24DA5F66f4F6d40d698B8d37BE9` | reused from M2a |

- Demo pool (hookless): mUSDC/mNVDA, fee `3000`, tickSpacing `60`, seeded + swap executed.
- Verified wiring: `PositionManager.poolManager()/permit2()/tokenDescriptor()`, `StateView.poolManager()`, `V4Quoter.poolManager()`, `PositionDescriptor.wrappedNative()` → MockWETH9.
- Deploy txs: `broadcast/DeployV4Stack.s.sol/5042002/run-latest.json`

### Hook proof (SmokeHook, test-only)

| Item | Value |
|---|---|
| `SmokeHook` | `0x3Cee7340818FD498e54D44DA2E634d02a72800C0` |
| Hook poolId | `0x092c224a431c94b955394fcdd56fcccae4970b2223fcbd9796737e631a023677` |
| Permissions | `beforeSwap` + `afterSwap` (salt-mined address) |
| Onchain proof | `swapCount = 1`, `lastSqrtPriceX96 = 1420897083832996649242119661407270`, `lastHookDataHash = keccak256(0xfeed)` |

### Not yet deployed

- `TrancheJITHook` (M3 — production hook), `StrategyController` + agent (M4), Senior/Junior ERC-7540 vaults + ERC-7575 share (M5)
- Aave V2 fork with USDC/EURC/mNVDA reserves (M2b)
- Universal Router (deferred; DemoRouter + PositionManager cover swaps/LP)

## Deprecated (do not integrate)

| Contract | Address | Why |
|---|---|---|
| `PoolManager` (v4-core v4.0.0) | `0xF570d08D4388D6487E348C28c00D714a347D33c4` | superseded by the 1.0.2-era core for periphery compatibility |
| `DemoRouter` (old) | `0x2022D0876132E26f32Df4a3bDdF2cFcB96010B28` | bound to the old PoolManager |
| `NVDAPriceOracle` (Chainlink-era) | `0xa2c6489fA9b1dba1ec63f410AB042543c86aa15F` | Chainlink removed |

## Indexing (The Graph)

Subgraph in `subgraph/` (`arc-testnet`): `NVDAPriceOracle` + `PoolManager`.
Not yet deployed to Graph Studio (pending a Studio key); manifests carry the current addresses
and start blocks.

## Conventions

- `Mock*` deployments are test-only and clearly labeled; no mock is used in the oracle price path.
- Re-run deploy scripts through simulation first (`forge script ... --rpc-url <rpc>`), then `--broadcast`.
- Keys live only in local `.env`; never committed.
