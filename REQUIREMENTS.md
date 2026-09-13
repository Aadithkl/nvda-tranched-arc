# Requirements

Pinned dependencies and build flags. Licenses and third-party scope: [`LICENSES.md`](LICENSES.md).
Submodules are recorded in [`.gitmodules`](.gitmodules); run `git submodule update --init --recursive`
after cloning.

| Dependency | Pin | License / note |
|---|---|---|
| `Uniswap/v4-core` | `59d3ecf53afa9264a16bba0e38f4c5d2231f80bc` | BUSL-1.1 (change date 2027-06-15); testnet/dev use |
| `Uniswap/v4-periphery` | `dce236d4e2057422d0791d9a973a58765eb46f65` | MIT |
| `OpenZeppelin/uniswap-hooks` | `2ae32be4906d300fc49b4384842ef6bc3e902d73` | MIT; hook base + fee modules |
| `OpenZeppelin/openzeppelin-community-contracts` | `92f252851c41449bd8417a6ebdcc8db95c8f66c9` | MIT; ERC-7540 base |
| `OpenZeppelin/openzeppelin-contracts` | `v5.7.0` | MIT |
| `foundry-rs/forge-std` | pinned submodule | MIT |

Toolchain: [Foundry](https://book.getfoundry.sh/) (`forge`), Node.js >= 20 with npm.

Build flags (`foundry.toml`): `via_ir = true`, global `optimizer_runs = 200`,
`bytecode_hash = "none"` — required so the v4 periphery fits under the EIP-170 contract-size limit.
