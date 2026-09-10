# NVDA Tranched Platform — `nvda-tranched-arc`

Stablecoin-native RWA capital structuring on **Arc Testnet**: NVDA exposure split into
Senior (fixed 5% target) and Junior (leveraged) tranches, with capital resting in a
lending market and a defensive Uniswap v4 JIT hook executing only in `+EV`, market-open,
oracle-valid windows under an agent-operated strategy controller.

## Status

| Milestone | Scope | State |
|---|---|---|
| M0 | Env, repo, Foundry, deps, license audit | in progress |
| M1 | Chainlink Data Streams NVDA oracle + updater | pending |
| M2a | Uniswap v4 fork (PoolManager + router) on Arc Testnet | pending |
| M2b | Aave V2 fork (USDC + EURC + mNVDA reserves) on Arc Testnet | pending |
| M3 | `TrancheJITHook` (DualPool-style multi-bucket JIT + gates) | pending |
| M4 | `StrategyController` + agent daemon + CRE safety stub | pending |
| M5 | ERC-7540 Senior/Junior vaults + ERC-7575 hook share | pending |
| M6 | E2E on Arc Testnet, security pass, docs/ABIs | pending |

## Architecture (target)

- **Price**: Chainlink Data Streams testnet NVDA (Regular/Extended/Overnight, V11),
  verified onchain through the Arc Testnet `VerifierProxy`.
- **Execution**: forked Uniswap v4 `PoolManager` + `TrancheJITHook` (multi-bucket JIT,
  `beforeSwap`/`afterSwap`, no custom-accounting return-delta flags).
- **Lending**: forked Aave V2 deployed on Arc Testnet (no ETH/WETH; USDC-native gas).
- **Vaults**: Senior/Junior as ERC-7540 async vaults; hook strategy receipt as ERC-7575.
- **Agent**: role-based EOA calling a bounded `StrategyController` — can reallocate
  between venues, pause swaps and adjust distribution within caps; can never withdraw
  funds to arbitrary addresses or mint/burn user shares.

## Setup

Foundry (this machine): `C:\Users\klaad\.foundry\bin` (v1.8.1), git: `C:\Users\klaad\tools\PortableGit`.

```shell
forge build
forge test
```

Environment: copy `.env.example` to `.env` and fill in secrets (never committed).

## Dependencies (pinned)

- `Uniswap/v4-core` — `v4.0.0` (BUSL-1.1, change date 2027-06-15; testnet/dev use — see `LICENSES.md`)
- `Uniswap/v4-periphery` — commit `dce236d4e2057422d0791d9a973a58765eb46f65` (MIT)
- `OpenZeppelin/openzeppelin-contracts` — `v5.7.0` (MIT)
- `foundry-rs/forge-std` (MIT)

## Docs

- `LICENSES.md` — dependency license audit
- `docs/` — architecture, Chainlink integration, security, agent, frontend pack (added through M1–M6)
