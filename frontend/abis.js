// Minimal ABIs for the Robinhood testnet frontend. Hand-written to match
// src/ (main branch). Overloaded functions are included only once
// (4-arg redeemAtExpiry, 3-arg unwrapQuote, 5-arg swapExactIn) so viem can
// use short names.

const T = (type, name) => ({ type, name });
const ADDR = (name) => T("address", name);
const U = (bits, name) => T(`uint${bits}`, name);
const B = (name) => T("bool", name);

const GUARD_PARAMS = {
  type: "tuple",
  name: "params",
  components: [
    T("int24", "guardTickWidth"),
    T("int24", "baseTickWidth"),
    T("uint128", "guardLiquidity"),
    T("uint128", "baseLiquidity"),
    T("uint16", "minEvBps"),
    T("uint16", "recheckMaxDeviationBps"),
    T("uint32", "recheckInterval"),
    T("uint32", "maxPriceAge"),
    T("uint8", "allowedSessionsMask"),
  ],
};

const PRICE_DATA = {
  type: "tuple",
  name: "data",
  components: [
    T("int192", "mid"),
    T("int192", "bid"),
    T("int192", "ask"),
    T("uint32", "marketStatus"),
    T("uint8", "session"),
    T("uint32", "sourceTimestamp"),
    T("uint256", "updatedAt"),
    T("bytes32", "paymentRef"),
    B("valid"),
  ],
};

const SWAP_PARAMS = {
  type: "tuple",
  name: "params",
  components: [B("zeroForOne"), T("int256", "amountSpecified"), T("uint160", "sqrtPriceLimitX96")],
};

const POOL_KEY = {
  type: "tuple",
  name: "key",
  components: [
    ADDR("currency0"),
    ADDR("currency1"),
    T("uint24", "fee"),
    T("int24", "tickSpacing"),
    ADDR("hooks"),
  ],
};

const fn = (name, stateMutability, inputs = [], outputs = []) => ({
  type: "function",
  name,
  stateMutability,
  inputs,
  outputs,
});
const view = (name, inputs = [], outputs = []) => fn(name, "view", inputs, outputs);
const call = (name, inputs = [], outputs = []) => fn(name, "nonpayable", inputs, outputs);

export const erc20ABI = [
  view("name", [], [T("string", "")]),
  view("symbol", [], [T("string", "")]),
  view("decimals", [], [U(8, "")]),
  view("totalSupply", [], [U(256, "")]),
  view("balanceOf", [ADDR("account")], [U(256, "")]),
  view("allowance", [ADDR("owner"), ADDR("spender")], [U(256, "")]),
  call("approve", [ADDR("spender"), U(256, "amount")], [B("")]),
  call("mint", [ADDR("to"), U(256, "amount")]),
];

export const hookABI = [
  view("guardParams", [], [GUARD_PARAMS]),
  view("guardState", [], [B("present"), U(256, "pulledAt_"), B("deployEnabled_"), B("exited_")]),
  view("poolInitialized", [], [B("")]),
  view("exited", [], [B("")]),
  view("guardPresent", [], [B("")]),
  view("deployEnabled", [], [B("")]),
  view("poolPrice1e18", [], [U(256, "")]),
  view("oracleDeviationBps", [], [B("ok"), U(256, "deviationBps")]),
  view("oracleStatus", [], [B("ok"), U(256, "updatedAt"), U(8, "session")]),
  view("recheckDue", [], [B("")]),
  view("effectiveLiquidity", [], [T("uint128", "")]),
  view("quoteIdle", [], [U(256, "")]),
  view("equityIdle", [], [U(256, "")]),
  view("claims", [ADDR("token")], [U(256, "")]),
  view("basePosition", [], [T("int24", "tickLower"), T("int24", "tickUpper"), T("uint128", "liquidity")]),
  view("guardPosition", [], [T("int24", "tickLower"), T("int24", "tickUpper"), T("uint128", "liquidity")]),
  view("activePoolId", [], [T("bytes32", "")]),
  view("quote", [], [ADDR("")]),
  view("equity", [], [ADDR("")]),
  view("vault", [], [ADDR("")]),
  view("priceOracle", [], [ADDR("")]),
  view("simulateEv", [SWAP_PARAMS], [B("ok"), T("int256", "ev"), U(256, "ourNotional"), T("int256", "totalEv"), U(256, "totalNotional")]),
  call("setGuardParams", [GUARD_PARAMS]),
  call("setDeployEnabled", [B("enabled")]),
  call("deployGuard", []),
  call("recenterGuard", []),
  call("rearm", []),
  call("recallToVault", []),
  call("pullAll", []),
  call("withdrawInventory", [U(256, "quoteAmount"), U(256, "equityAmount")]),
  call("unwindClaims", []),
  call("recheckGuard", []),
  call("initializeBook", [POOL_KEY, T("uint160", "sqrtPriceX96")], [T("int24", "tick")]),
];

export const vaultABI = [
  view("quote", [], [ADDR("")]),
  view("equity", [], [ADDR("")]),
  view("shareToken", [], [ADDR("")]),
  view("accountant", [], [ADDR("")]),
  view("keeper", [], [ADDR("")]),
  view("owner", [], [ADDR("")]),
  view("strategyModule", [], [ADDR("")]),
  view("aToken", [], [ADDR("")]),
  view("hook", [], [ADDR("")]),
  view("priceOracle", [], [ADDR("")]),
  view("expired", [], [B("")]),
  view("settled", [], [B("")]),
  view("halted", [], [B("")]),
  view("depegPaused", [], [B("")]),
  view("depegThresholdBps", [], [U(16, "")]),
  view("lastDepegCheck", [], [U(256, "")]),
  view("guardRecallOnWithdraw", [], [B("")]),
  view("conversionFeeBps", [], [U(16, "")]),
  view("redemptionFeeBps", [], [U(16, "")]),
  view("maxFineBps", [], [U(16, "")]),
  view("maxUnwrapDeviationBps", [], [U(16, "")]),
  view("maxOracleAge", [], [U(32, "")]),
  view("currentExitFeeBps", [], [U(256, "")]),
  view("quoteDecimals", [], [U(8, "")]),
  view("equityDecimals", [], [U(8, "")]),
  view("virtualAssets", [], [U(256, "")]),
  view("totalManagedAssets", [], [U(256, "")]),
  view("baseManagedAssets", [], [U(256, "")]),
  view("convertToShares", [U(256, "quoteAmount")], [U(256, "")]),
  view("convertToQuote", [U(256, "shares")], [U(256, "")]),
  view("equityToQuote", [U(256, "equityAmount")], [U(256, "")]),
  view("quoteToEquity", [U(256, "quoteAmount")], [U(256, "")]),
  view("oracleValid", [], [B("")]),
  call("wrapQuote", [U(256, "quoteAmount"), ADDR("receiver")], [U(256, "shares")]),
  call("unwrapQuote", [U(256, "shares"), ADDR("receiver"), U(256, "minQuoteOut")], [U(256, "quoteAmount")]),
  call(
    "unwrapProportional",
    [U(256, "shares"), ADDR("receiver"), U(256, "minQuoteOut"), U(256, "minEquityOut")],
    [U(256, "quoteAmount"), U(256, "equityAmount")]
  ),
  call("setGuardParams", [GUARD_PARAMS]),
  call("fundHook", [U(256, "quoteAmount"), U(256, "equityAmount")]),
  call("recallFromHook", []),
  call("deployGuard", []),
  call("recenterGuard", []),
  call("rearmHook", []),
  call("setHookDeployEnabled", [B("enabled")]),
  call("initializeHook", [POOL_KEY, T("uint160", "sqrtPriceX96")], [T("int24", "tick")]),
  call("halt", []),
  call("haltIfExpired", []),
  call("finalizeSettlement", []),
  call("finalizeSettlementHaircut", []),
  call("supplyIdle", [], [U(256, "supplied")]),
  call("supplyIdleAmount", [U(256, "amount")], [U(256, "supplied")]),
  call("withdrawFromVenue", [U(256, "amount")], [U(256, "withdrawn")]),
  call("approveStrategy", [ADDR("token"), U(256, "amount")]),
  call("setExitFees", [U(16, "feeBps_"), U(16, "fineBps_")]),
  call("setConversionFeeBps", [U(16, "bps")]),
  call("setMaxUnwrapDeviationBps", [U(16, "bps")]),
  call("setDepegThresholdBps", [U(16, "bps")]),
  call("checkDepeg", [], [B("paused_")]),
  call("resumeFromDepeg", []),
  call("setMaxOracleAge", [U(32, "seconds_")]),
  call("setGuardRecallOnWithdraw", [B("enabled")]),
  call("acceptHookOwnership", []),
];

export const trancheABI = [
  view("name", [], [T("string", "")]),
  view("symbol", [], [T("string", "")]),
  view("decimals", [], [U(8, "")]),
  view("totalSupply", [], [U(256, "")]),
  view("balanceOf", [ADDR("account")], [U(256, "")]),
  view("allowance", [ADDR("owner"), ADDR("spender")], [U(256, "")]),
  call("approve", [ADDR("spender"), U(256, "amount")], [B("")]),
  view("accountant", [], [ADDR("")]),
  view("matured", [], [B("")]),
  view("quotePerShare1e18", [], [U(256, "")]),
  view("equityPerShare1e18", [], [U(256, "")]),
  view("convertToAssets", [U(256, "shares")], [U(256, "")]),
  view("convertToShares", [U(256, "assets")], [U(256, "")]),
  view("pendingRedeemRequest", [U(256, "requestId"), ADDR("controller")], [U(256, "")]),
  view("claimableRedeemRequest", [U(256, "requestId"), ADDR("controller")], [U(256, "")]),
  view("maxRedeem", [ADDR("owner")], [U(256, "")]),
  view("maxWithdraw", [ADDR("owner")], [U(256, "")]),
  call("depositQuote", [U(256, "quoteAmount"), ADDR("receiver")], [U(256, "shares")]),
  call("requestRedeem", [U(256, "shares"), ADDR("controller"), ADDR("owner")], [U(256, "")]),
  call("redeem", [U(256, "shares"), ADDR("receiver"), ADDR("owner")], [U(256, "")]),
  call(
    "claimAndUnwrapQuote",
    [U(256, "shares"), ADDR("receiver"), ADDR("ownerOrController"), U(256, "minQuoteOut")],
    [U(256, "quoteAmount")]
  ),
  call(
    "redeemAtExpiry",
    [U(256, "shares"), ADDR("receiver"), U(256, "minQuoteOut"), U(256, "minEquityOut")],
    [U(256, "quoteAmount"), U(256, "equityAmount")]
  ),
  call("fulfillRedeemMatured", [ADDR("user")]),
  call("claimMatured", [ADDR("receiver")], [U(256, "quoteAmount"), U(256, "equityAmount")]),
  call("submitAccountant", [ADDR("newAccountant")]),
  call("executeAccountant", []),
];

export const accountantABI = [
  view("seniorVault", [], [ADDR("")]),
  view("juniorVault", [], [ADDR("")]),
  view("keeper", [], [ADDR("")]),
  view("owner", [], [ADDR("")]),
  view("hook", [], [ADDR("")]),
  view("seniorClaim", [], [U(256, "")]),
  view("juniorClaim", [], [U(256, "")]),
  view("seniorPrincipal", [], [U(256, "")]),
  view("juniorPrincipal", [], [U(256, "")]),
  view("claimableSenior", [], [U(256, "")]),
  view("claimableJunior", [], [U(256, "")]),
  view("seniorGuaranteeQuote", [], [U(256, "")]),
  view("escrowFunded", [], [B("")]),
  view("effectivePool", [], [U(256, "")]),
  view("poolValue", [], [U(256, "")]),
  view("frozen", [], [B("")]),
  view("lastExecutedEpoch", [], [U(256, "")]),
  view("minJuniorFloorBps", [], [U(16, "")]),
  call("executeEpoch", [], [U(256, "id")]),
  call("claimEpoch", [B("senior"), ADDR("user")]),
  call("fulfillRedeem", [B("senior"), ADDR("user")]),
  call("rebalance", [], [U(256, "movedToSenior"), U(256, "movedToJunior")]),
  call("setFrozen", [B("frozen_")]),
  call("setKeeper", [ADDR("keeper_")]),
];

export const oracleABI = [
  view("decimals", [], [U(8, "")]),
  view("maxStaleness", [], [U(32, "")]),
  view("getPrice", [], [PRICE_DATA]),
  call("updatePrice", [T("int192", "mid"), T("uint32", "marketStatus_"), T("uint32", "sourceTimestamp"), T("bytes32", "paymentRef")]),
  call("setWriter", [ADDR("writer"), B("allowed")]),
  call("setMaxStaleness", [T("uint32", "maxStaleness_")]),
];

export const entryABI = [
  view("share", [], [ADDR("")]),
  view("asset", [], [ADDR("")]),
  view("convertToShares", [U(256, "assets")], [U(256, "")]),
  view("convertToAssets", [U(256, "shares")], [U(256, "")]),
  view("previewDeposit", [U(256, "assets")], [U(256, "")]),
  view("previewMint", [U(256, "shares")], [U(256, "")]),
  view("previewWithdraw", [U(256, "assets")], [U(256, "")]),
  view("previewRedeem", [U(256, "shares")], [U(256, "")]),
  view("maxDeposit", [ADDR("")], [U(256, "")]),
  view("maxMint", [ADDR("")], [U(256, "")]),
  view("maxWithdraw", [ADDR("owner")], [U(256, "")]),
  view("maxRedeem", [ADDR("owner")], [U(256, "")]),
  view("maxWithdrawableQuote", [], [U(256, "")]),
  call("deposit", [U(256, "assets"), ADDR("receiver")], [U(256, "shares")]),
  call("mint", [U(256, "shares"), ADDR("receiver")], [U(256, "assets")]),
  call("withdraw", [U(256, "assets"), ADDR("receiver"), ADDR("owner")], [U(256, "shares")]),
  call("redeem", [U(256, "shares"), ADDR("receiver"), ADDR("owner")], [U(256, "assets")]),
];

export const routerABI = [
  call(
    "swapExactIn",
    [POOL_KEY, B("zeroForOne"), U(256, "amountIn"), U(256, "minAmountOut"), ADDR("recipient")],
    [
      {
        type: "tuple",
        name: "delta",
        components: [T("int128", "amount0"), T("int128", "amount1")],
      },
    ]
  ),
];
