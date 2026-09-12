# Lending Layer (Aave V2 semi-fork) — `src/lending/`

Purpose: the yield-bearing **rest state** for the tranche hook. Idle capital is supplied to a
lending market and earns interest; the hook withdraws on demand to fund JIT liquidity.

This is a **semi-fork**: the pool / addresses-provider / configurator architecture and the
`IAaveV2Pool` interface subset follow Aave V2, but it is an independent implementation
(no upstream code copied). No WETH market, no Chainlink — reserve prices are owner-pegged.

## Contracts

| Contract | Role |
|---|---|
| `LendingPoolAddressesProvider` | Registry: `LENDING_POOL`, `LENDING_POOL_CONFIGURATOR`, `PRICE_ORACLE`, `PROTOCOL_DATA_PROVIDER`, `poolAdmin` |
| `PeggedPriceOracle` | `getAssetPrice(asset)` in USD (8 decimals), owner-set pegs |
| `LendingPool` | `deposit`, `withdraw`, `borrow` (variable), `repay`, `getReserveData`, `getUserAccountData`, `updateState`, pause |
| `LendingPoolConfigurator` | `initReserve` (deploys aToken + variable debt token), collateral config, borrowing toggle, reserve factor, active/freeze, rate strategy swap |
| `AToken` | Rebasing receipt token (scaled balances × liquidity index); `transferUnderlyingTo` for pool withdrawals |
| `VariableDebtToken` | Scaled variable debt (× variable borrow index) |
| `DefaultReserveInterestRateStrategy` | Utilization-based rates: base + slope1 (to 80%) + slope2 above optimal |
| `libraries/WadRayMath`, `libraries/ReserveConfiguration`, `libraries/DataTypes` | Ray/Wad math, Aave-style config bitfield, reserve structs |

Markets configured by the deploy script: **USDC + EURC only** (6 decimals each), no WETH.
Pegs: USDC `1e8`, EURC `1.1617e8` (matches the USDC/EURC v4 pool tick `-1499`).

## Model

- `liquidityIndex` / `variableBorrowIndex` are Ray (`1e27`) indexes, updated linearly per second
  on every pool interaction via `updateState`: `index *= (1 + rate × elapsed / 365d)`.
- `aToken.balanceOf` = scaled balance × `liquidityIndex`; debt = scaled debt × `variableBorrowIndex`.
- Utilization = debt / (available liquidity + debt). Borrow rate = base + slope1 × U / U_opt
  (or base + slope1 + slope2 × (U − U_opt)/(1 − U_opt) above optimal). Supply rate =
  borrow rate × U × (1 − reserveFactor).
- Reserve factor is retained in the aToken contract as surplus (no treasury mint yet).

## Implemented vs not

Implemented: supply/withdraw, variable borrow/repay, LTV borrow-capacity check, health factor,
cross-market collateral, freeze/deactivate, pause (blocks deposit/withdraw/borrow; repay always allowed),
owner pegs.

Not implemented (documented gaps): liquidations, stable-rate debt, flash loans, credit delegation,
eMode/isolation, treasury accrual, protocol data provider.

## Roles

- Provider owner (deployer) sets `poolAdmin` and registry entries.
- `poolAdmin` = configurator admin + can pause the pool.
- `poolAdmin` is set to `DEPLOYER_ADDRESS` at deploy; move it to a multisig/governance later.

## Deploy

```shell
# .env: DEPLOYER_PRIVATE_KEY, USDC_ADDRESS, EURC_ADDRESS (optional LENDING_* overrides)
forge script script/DeployLending.s.sol --rpc-url $ARC_RPC_URL --broadcast
```

Live addresses: see `docs/DEPLOYMENTS.md`.
