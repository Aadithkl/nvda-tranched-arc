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

Markets configured by the deploy script: **USDC + NVDA only** (6 and 18 decimals), no WETH.
Pegs: USDC `1e8`, NVDA `200e8` (reference mid; owner-settable via `NVDA_PEGGED_PRICE`).

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

## Price source (softcoded)

Reserve prices are **owner-set pegs**, not hardcoded in the pool:

- USDC `1e8`, NVDA `200e8` (USD, 8 decimals) — reference mid; keep close to the x402 oracle.
- Update any time (owner = deployer): `npm run lending:set-price -- --nvda-price 20000000000`
  (or set `USDC_PEGGED_PRICE` / `NVDA_PEGGED_PRICE` in `.env`).
- Swap the source later without touching the pool: deploy an oracle implementing
  `getAssetPrice(address)` and call `provider.setAddress(keccak256("PRICE_ORACLE"), newOracle)`.
  A v4-pool-derived oracle is possible, but v4 core has no TWAP and the FX pool is thin —
  prefer a keeper-pushed value with a deviation clamp over a raw spot read.

## Ops

```shell
npm run lending:status                 # prices, wallet/aToken balances, liquidity index
npm run lending:set-price              # re-set USDC/NVDA pegs (owner tx)
npm run lending:seed                   # approve + deposit 10 USDC + 1 NVDA (override with --usdc-amount/--nvda-amount)
```

Seeded on Arc: 10 USDC (the NVDA market seeds after the v3 lending redeploy); txs in `docs/DEPLOYMENTS.md`.

## Deploy

```shell
# .env: DEPLOYER_PRIVATE_KEY, USDC_ADDRESS, NVDA_ADDRESS (optional LENDING_* overrides)
# then: npm run lending:seed  (deposits 10 USDC + 1 NVDA)
forge script script/DeployLending.s.sol --rpc-url $ARC_RPC_URL --broadcast
```

Live addresses: see `docs/DEPLOYMENTS.md`.
