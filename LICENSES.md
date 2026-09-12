# Dependency License Audit

Audited during M0. Re-check whenever a dependency is updated.

| Dependency | Version / Commit | License | Notes |
|---|---|---|---|
| `Uniswap/v4-core` | `59d3ecf53afa9264a16bba0e38f4c5d2231f80bc` (1.0.2-era) | **BUSL-1.1** (some files MIT) | `SPDX-License-Identifier: BUSL-1.1` on `PoolManager.sol` and core libraries. Change License: MIT; Change Date: earlier of **2027-06-15** or as specified. BUSL permits non-production use (development, testing, testnets). **Production/mainnet deployment of a v4-core fork before the change date requires a commercial license from Uniswap Labs.** |
| `Uniswap/v4-periphery` | `dce236d4e2057422d0791d9a973a58765eb46f65` | MIT | Repo `LICENSE` is MIT. Note: current version no longer ships `BaseHook.sol`; hooks implement `IHooks` directly. `HookMiner` is in `test/shared/`. |
| `OpenZeppelin/openzeppelin-contracts` | `v5.7.0` (`cab19933`) | MIT | OK |
| `OpenZeppelin/openzeppelin-community-contracts` | `92f252851c41449bd8417a6ebdcc8db95c8f66c9` | MIT | Vendored for ERC-7540 (`ERC7540` base + `ERC7540SyncDeposit` + `ERC7540AdminRedeem`). Its own pinned OZ commit is `cab19933` (v5.7.0) — matches ours, so remappings align. |
| `foundry-rs/forge-std` | pinned via `forge init` | MIT | OK |
| `Uniswap/v4-hooks-public` (DualPoolHook reference) | not vendored | MIT (verified) | Used as a *reference* for the JIT design; MIT permits direct reuse with attribution. |
| Aave V2 semi-fork (`src/lending/`) | independent implementation | MIT (ours) | Architecture + `IAaveV2Pool` subset inspired by Aave V2; written from scratch, no upstream code copied. Upstream `aave/protocol-v2` is **NOASSERTION** — do not copy its source. |

## Action items

1. Before any mainnet deployment: resolve BUSL for v4-core (wait for MIT change date or obtain license).
2. `v4-hooks-public` is MIT — direct adaptation of `DualPoolHook` is allowed with attribution.
3. Keep this file updated at each dependency change.
