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
npm run lending:status                 # markets: supplied/borrowed/utilization/APYs/params + your position
npm run lending:set-price              # re-set USDC/NVDA pegs (owner tx)
npm run lending:seed                   # approve + deposit 10 USDC + 1 NVDA (override with --usdc-amount/--nvda-amount)
node scripts/lending-admin.mjs --deposit <usdc6>    # supply USDC from the deployer wallet
node scripts/lending-admin.mjs --borrow <usdc6>     # variable-rate borrow (rate mode 2)
node scripts/lending-admin.mjs --repay <usdc6>      # repay variable debt
node scripts/lending-admin.mjs --withdraw <usdc6>   # withdraw supplied USDC
node scripts/lending-admin.mjs --update             # poke updateState (refresh indexes/rates)
node scripts/lending-admin.mjs --set-strategy --slope1 9 [--base 0] [--slope2 60] [--optimal 80]
                                        # deploy a new rate strategy and swap it onto USDC
node scripts/lending-admin.mjs --init-nvda            # set the peg + init/configure the NVDA reserve (owner)
node scripts/lending-admin.mjs --mint-nvda <wei18>    # mint mock NVDA to the deployer (test token only)
node scripts/lending-admin.mjs --deposit-nvda <wei18> # supply NVDA
node scripts/lending-admin.mjs --borrow-nvda <wei18>  # variable-rate borrow of NVDA (rate mode 2)
```

Live markets on Arc (2026-09-13 redeploy): **USDC + NVDA**, strategy base `0`, slope1 `9%`, slope2 `60%`,
optimal `80%`.
- USDC: supplied 230, borrowed 160 → utilization 69.6%, supply 4.90% / borrow 7.83%.
- NVDA: supplied 2, borrowed 1.2 → utilization 60.0%, supply 3.64% / borrow 6.75%.
`borrow` now values the requested amount in USD base (`amount × price / 10^decimals`) before the LTV check,
so 18-dec debt markets work; addresses and txs are in `docs/DEPLOYMENTS.md`.

## Deploy

```shell
# .env: DEPLOYER_PRIVATE_KEY, USDC_ADDRESS, NVDA_ADDRESS (optional LENDING_* overrides)
# then: npm run lending:seed  (deposits 10 USDC + 1 NVDA)
forge script script/DeployLending.s.sol --rpc-url $ARC_RPC_URL --broadcast
```

Live addresses: see `docs/DEPLOYMENTS.md`.
