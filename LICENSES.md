# Licenses

Project code authored in this repository is **MIT** — see [`LICENSE`](LICENSE). Third-party
dependencies keep their own licenses and are used via pinned git submodules; each submodule ships
its own `LICENSE` file.

| Dependency | Version / Commit | License | Notes |
|---|---|---|---|
| `Uniswap/v4-core` | `59d3ecf53afa9264a16bba0e38f4c5d2231f80bc` | **BUSL-1.1** (some files MIT) | `SPDX-License-Identifier: BUSL-1.1` on `PoolManager.sol` and core libraries. Change Date `2027-06-15` → MIT. |
| `Uniswap/v4-periphery` | `dce236d4e2057422d0791d9a973a58765eb46f65` | MIT | Hooks implement `IHooks` directly; `BaseHook` comes from `openzeppelin/uniswap-hooks`. |
| `OpenZeppelin/openzeppelin-contracts` | `v5.7.0` (`cab19933`) | MIT | |
| `OpenZeppelin/openzeppelin-community-contracts` | `92f252851c41449bd8417a6ebdcc8db95c8f66c9` | MIT | Vendored for ERC-7540 (`ERC7540` base + sync deposit + admin redeem). |
| `OpenZeppelin/uniswap-hooks` | `2ae32be4906d300fc49b4384842ef6bc3e902d73` | MIT | Hook plumbing (`BaseHook`, fee-module patterns). |
| `foundry-rs/forge-std` | pinned via `forge init` | MIT | |
| `Uniswap/v4-hooks-public` (DualPoolHook reference) | not vendored | MIT | Reference only for the JIT design; MIT permits reuse with attribution. |
| Aave V2 semi-fork (`src/lending/`) | independent implementation | MIT (ours) | Written from scratch; no upstream code copied. |

## Scope notes

- **Uniswap v4 core (BUSL-1.1).** The canonical code is used unmodified and redeployed on **Arc
  testnet only** — non-production use, which the license permits. A production/mainnet deployment
  before the Change Date (`2027-06-15`) requires a commercial license or the Additional Use Grant
  published at `v4-core-license-grants.uniswap.eth`. After the Change Date the license converts to
  MIT.
- **Aave V2 semi-fork.** `src/lending/` is an independent implementation; the upstream
  `aave/protocol-v2` repository carries no clear open-source license (NOASSERTION), so no upstream
  source is copied or redistributed here.
- Re-check licenses whenever a submodule is updated.
