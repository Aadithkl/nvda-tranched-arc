# Dependency License Audit

Audited during M0. Re-check whenever a dependency is updated.

| Dependency | Version / Commit | License | Notes |
|---|---|---|---|
| `Uniswap/v4-core` | `v4.0.0` | **BUSL-1.1** (some files MIT) | `SPDX-License-Identifier: BUSL-1.1` on `PoolManager.sol` and core libraries. Change License: MIT; Change Date: earlier of **2027-06-15** or as specified. BUSL permits non-production use (development, testing, testnets). **Production/mainnet deployment of a v4-core fork before the change date requires a commercial license from Uniswap Labs.** |
| `Uniswap/v4-periphery` | `dce236d4e2057422d0791d9a973a58765eb46f65` | MIT | Repo `LICENSE` is MIT. Note: current version no longer ships `BaseHook.sol`; hooks implement `IHooks` directly. `HookMiner` is in `test/shared/`. |
| `OpenZeppelin/openzeppelin-contracts` | `v5.7.0` | MIT | OK |
| `foundry-rs/forge-std` | pinned via `forge init` | MIT | OK |
| `Uniswap/v4-hooks-public` (DualPoolHook reference) | not vendored | **check before copying** | Used as a *reference* for the JIT design. If code is copied verbatim, license terms apply — audit before any copy; otherwise implement clean-room from the documented pattern. |

## Action items

1. Before any mainnet deployment: resolve BUSL for v4-core (wait for MIT change date or obtain license).
2. If adapting `DualPoolHook` code: verify `v4-hooks-public` license first; prefer clean-room implementation of the documented JIT lifecycle.
3. Keep this file updated at each dependency change.
