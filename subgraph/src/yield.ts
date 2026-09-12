// Messari Yield Aggregator (v1.3.1) entities for the TrancheJITHook share pipe.
// The hook share (tjSHARE) is modeled as a Vault: input token = USDC, output token = tjSHARE,
// wraps = Deposit, unwraps = Withdraw. Protocol/vault revenue is 0 for now (no protocol fee).
import { Address, BigInt, BigDecimal, ethereum } from "@graphprotocol/graph-ts";
import {
  Account,
  ActiveAccount,
  Deposit,
  FinancialsDailySnapshot,
  Token,
  UsageMetricsDailySnapshot,
  UsageMetricsHourlySnapshot,
  Vault,
  VaultDailySnapshot,
  VaultHourlySnapshot,
  Withdraw,
  YieldAggregator,
} from "../generated/schema";
import {
  SharesUnwrapped,
  SharesWrapped,
  TrancheJITHook,
} from "../generated/TrancheJITHook/TrancheJITHook";

const PROTOCOL_ID = "nvda-tranched-arc";
const SCHEMA_VERSION = "1.3.1";
const SUBGRAPH_VERSION = "1.0.0";
const METHODOLOGY_VERSION = "1.0.0";
const ZERO = BigDecimal.fromString("0");
const USDC_DECIMALS = BigDecimal.fromString("1000000");
const SHARE_DECIMALS = BigDecimal.fromString("1000000000000000000");
const SNAPSHOT_EVERY = BigInt.fromI32(500);

function usdcAddress(): Address {
  return Address.fromString("0x3600000000000000000000000000000000000000");
}

function toUsd(amount: BigInt, decimals: BigDecimal): BigDecimal {
  return amount.toBigDecimal().div(decimals);
}

function dayId(timestamp: BigInt): string {
  return timestamp.div(BigInt.fromI32(86400)).toString();
}

function hourId(timestamp: BigInt): string {
  return timestamp.div(BigInt.fromI32(3600)).toString();
}

export function loadProtocol(): YieldAggregator {
  let protocol = YieldAggregator.load(PROTOCOL_ID);
  if (protocol == null) {
    protocol = new YieldAggregator(PROTOCOL_ID);
    protocol.name = "Tranched Arc";
    protocol.slug = "nvda-tranched-arc";
    protocol.schemaVersion = SCHEMA_VERSION;
    protocol.subgraphVersion = SUBGRAPH_VERSION;
    protocol.methodologyVersion = METHODOLOGY_VERSION;
    protocol.network = "ARC_TESTNET";
    protocol.type = "YIELD";
    protocol.totalValueLockedUSD = ZERO;
    protocol.cumulativeSupplySideRevenueUSD = ZERO;
    protocol.cumulativeProtocolSideRevenueUSD = ZERO;
    protocol.cumulativeTotalRevenueUSD = ZERO;
    protocol.cumulativeUniqueUsers = 0;
    protocol.totalPoolCount = 0;
  }
  return protocol as YieldAggregator;
}

export function loadOrCreateToken(
  address: Address,
  name: string,
  symbol: string,
  decimals: i32,
): Token {
  let token = Token.load(address.toHexString());
  if (token == null) {
    token = new Token(address.toHexString());
    token.name = name;
    token.symbol = symbol;
    token.decimals = decimals;
  }
  return token as Token;
}

export function loadOrCreateVault(hook: Address, event: ethereum.Event): Vault {
  let protocol = loadProtocol();
  let vault = Vault.load(hook.toHexString());
  if (vault == null) {
    let usdc = loadOrCreateToken(usdcAddress(), "USD Coin", "USDC", 6);
    usdc.save();
    let shareAddress = hook;
    let shareToken = TrancheJITHook.bind(hook).try_shareToken();
    if (!shareToken.reverted) {
      shareAddress = shareToken.value;
    }
    let share = loadOrCreateToken(shareAddress, "Tranche JIT Share", "tjSHARE", 18);
    share.save();

    vault = new Vault(hook.toHexString());
    vault.protocol = protocol.id;
    vault.name = "Tranched Arc JIT Share Pipe";
    vault.symbol = "tjSHARE";
    vault.inputToken = usdc.id;
    vault.outputToken = share.id;
    vault.rewardTokens = [];
    vault.depositLimit = BigInt.zero();
    vault.fees = [];
    vault.createdTimestamp = event.block.timestamp;
    vault.createdBlockNumber = event.block.number;
    vault.totalValueLockedUSD = ZERO;
    vault.cumulativeSupplySideRevenueUSD = ZERO;
    vault.cumulativeProtocolSideRevenueUSD = ZERO;
    vault.cumulativeTotalRevenueUSD = ZERO;
    vault.inputTokenBalance = BigInt.zero();
    vault.outputTokenSupply = BigInt.zero();
    vault.pricePerShare = ZERO;
    protocol.totalPoolCount = protocol.totalPoolCount + 1;
    protocol.save();
  }
  return vault as Vault;
}

function touchAccount(address: Address, timestamp: BigInt): void {
  let account = Account.load(address.toHexString());
  if (account == null) {
    account = new Account(address.toHexString());
    account.save();
    let protocol = loadProtocol();
    protocol.cumulativeUniqueUsers = protocol.cumulativeUniqueUsers + 1;
    protocol.save();
  }
  let active = ActiveAccount.load("daily-" + address.toHexString() + "-" + dayId(timestamp));
  if (active == null) {
    active = new ActiveAccount("daily-" + address.toHexString() + "-" + dayId(timestamp));
    active.save();
  }
}

function snapshotVault(vault: Vault, event: ethereum.Event): void {
  let protocol = loadProtocol();
  let day = dayId(event.block.timestamp);
  let hour = hourId(event.block.timestamp);

  let vaultDaily = VaultDailySnapshot.load(vault.id + "-" + day);
  if (vaultDaily == null) {
    vaultDaily = new VaultDailySnapshot(vault.id + "-" + day);
    vaultDaily.protocol = protocol.id;
    vaultDaily.vault = vault.id;
    vaultDaily.dailySupplySideRevenueUSD = ZERO;
    vaultDaily.dailyProtocolSideRevenueUSD = ZERO;
    vaultDaily.dailyTotalRevenueUSD = ZERO;
  }
  vaultDaily.totalValueLockedUSD = vault.totalValueLockedUSD;
  vaultDaily.cumulativeSupplySideRevenueUSD = vault.cumulativeSupplySideRevenueUSD;
  vaultDaily.cumulativeProtocolSideRevenueUSD = vault.cumulativeProtocolSideRevenueUSD;
  vaultDaily.cumulativeTotalRevenueUSD = vault.cumulativeTotalRevenueUSD;
  vaultDaily.inputTokenBalance = vault.inputTokenBalance;
  vaultDaily.outputTokenSupply = vault.outputTokenSupply!;
  vaultDaily.outputTokenPriceUSD = vault.outputTokenPriceUSD;
  vaultDaily.pricePerShare = vault.pricePerShare;
  vaultDaily.blockNumber = event.block.number;
  vaultDaily.timestamp = event.block.timestamp;
  vaultDaily.save();

  let vaultHourly = VaultHourlySnapshot.load(vault.id + "-" + hour);
  if (vaultHourly == null) {
    vaultHourly = new VaultHourlySnapshot(vault.id + "-" + hour);
    vaultHourly.protocol = protocol.id;
    vaultHourly.vault = vault.id;
    vaultHourly.hourlySupplySideRevenueUSD = ZERO;
    vaultHourly.hourlyProtocolSideRevenueUSD = ZERO;
    vaultHourly.hourlyTotalRevenueUSD = ZERO;
  }
  vaultHourly.totalValueLockedUSD = vault.totalValueLockedUSD;
  vaultHourly.cumulativeSupplySideRevenueUSD = vault.cumulativeSupplySideRevenueUSD;
  vaultHourly.cumulativeProtocolSideRevenueUSD = vault.cumulativeProtocolSideRevenueUSD;
  vaultHourly.cumulativeTotalRevenueUSD = vault.cumulativeTotalRevenueUSD;
  vaultHourly.inputTokenBalance = vault.inputTokenBalance;
  vaultHourly.outputTokenSupply = vault.outputTokenSupply!;
  vaultHourly.outputTokenPriceUSD = vault.outputTokenPriceUSD;
  vaultHourly.pricePerShare = vault.pricePerShare;
  vaultHourly.blockNumber = event.block.number;
  vaultHourly.timestamp = event.block.timestamp;
  vaultHourly.save();
}

export function recordDeposit(
  hook: Address,
  event: SharesWrapped,
): void {
  let vault = loadOrCreateVault(hook, event);
  let usd = toUsd(event.params.usdcAmount, USDC_DECIMALS);

  vault.inputTokenBalance = vault.inputTokenBalance.plus(event.params.usdcAmount);
  vault.outputTokenSupply = vault.outputTokenSupply!.plus(event.params.shares);
  vault.totalValueLockedUSD = vault.totalValueLockedUSD.plus(usd);
  if (vault.outputTokenSupply!.gt(BigInt.zero())) {
    vault.pricePerShare = vault.inputTokenBalance
      .toBigDecimal()
      .div(USDC_DECIMALS)
      .div(vault.outputTokenSupply!.toBigDecimal().div(SHARE_DECIMALS));
  }
  vault.save();

  let deposit = new Deposit(
    event.transaction.hash.toHexString() + "-" + event.logIndex.toString(),
  );
  deposit.hash = event.transaction.hash.toHexString();
  deposit.logIndex = event.logIndex.toI32();
  deposit.protocol = PROTOCOL_ID;
  deposit.to = event.params.receiver.toHexString();
  deposit.from = event.params.caller.toHexString();
  deposit.blockNumber = event.block.number;
  deposit.timestamp = event.block.timestamp;
  deposit.asset = vault.inputToken;
  deposit.amount = event.params.usdcAmount;
  deposit.amountUSD = usd;
  deposit.vault = vault.id;
  deposit.save();

  touchAccount(event.params.caller, event.block.timestamp);
  touchAccount(event.params.receiver, event.block.timestamp);
  snapshotVault(vault, event);

  let protocol = loadProtocol();
  protocol.totalValueLockedUSD = protocol.totalValueLockedUSD.plus(usd);
  protocol.save();
}

export function recordWithdraw(
  hook: Address,
  event: SharesUnwrapped,
): void {
  let vault = loadOrCreateVault(hook, event);
  let usd = toUsd(event.params.usdcAmount, USDC_DECIMALS);

  vault.inputTokenBalance = vault.inputTokenBalance.minus(event.params.usdcAmount);
  vault.outputTokenSupply = vault.outputTokenSupply!.minus(event.params.shares);
  vault.totalValueLockedUSD = vault.totalValueLockedUSD.minus(usd);
  if (vault.totalValueLockedUSD.lt(ZERO)) vault.totalValueLockedUSD = ZERO;
  if (vault.outputTokenSupply!.gt(BigInt.zero())) {
    vault.pricePerShare = vault.inputTokenBalance
      .toBigDecimal()
      .div(USDC_DECIMALS)
      .div(vault.outputTokenSupply!.toBigDecimal().div(SHARE_DECIMALS));
  }
  vault.save();

  let withdraw = new Withdraw(
    event.transaction.hash.toHexString() + "-" + event.logIndex.toString(),
  );
  withdraw.hash = event.transaction.hash.toHexString();
  withdraw.logIndex = event.logIndex.toI32();
  withdraw.protocol = PROTOCOL_ID;
  withdraw.to = event.params.receiver.toHexString();
  withdraw.from = event.params.caller.toHexString();
  withdraw.blockNumber = event.block.number;
  withdraw.timestamp = event.block.timestamp;
  withdraw.asset = vault.inputToken;
  withdraw.amount = event.params.usdcAmount;
  withdraw.amountUSD = usd;
  withdraw.vault = vault.id;
  withdraw.save();

  touchAccount(event.params.caller, event.block.timestamp);
  touchAccount(event.params.receiver, event.block.timestamp);
  snapshotVault(vault, event);

  let protocol = loadProtocol();
  protocol.totalValueLockedUSD = protocol.totalValueLockedUSD.minus(usd);
  if (protocol.totalValueLockedUSD.lt(ZERO)) protocol.totalValueLockedUSD = ZERO;
  protocol.save();
}

// Block handler: refreshes protocol/vault daily + hourly snapshots (decimated for Arc's fast blocks).
export function handleBlock(block: ethereum.Block): void {
  if (block.number.mod(SNAPSHOT_EVERY).notEqual(BigInt.zero())) return;
  let protocol = loadProtocol();
  let day = dayId(block.timestamp);
  let hour = hourId(block.timestamp);

  let usageDaily = UsageMetricsDailySnapshot.load(day);
  if (usageDaily == null) {
    usageDaily = new UsageMetricsDailySnapshot(day);
    usageDaily.protocol = protocol.id;
    usageDaily.dailyActiveUsers = 0;
    usageDaily.cumulativeUniqueUsers = protocol.cumulativeUniqueUsers;
    usageDaily.dailyTransactionCount = 0;
    usageDaily.dailyDepositCount = 0;
    usageDaily.dailyWithdrawCount = 0;
  }
  usageDaily.totalPoolCount = protocol.totalPoolCount;
  usageDaily.blockNumber = block.number;
  usageDaily.timestamp = block.timestamp;
  usageDaily.save();

  let usageHourly = UsageMetricsHourlySnapshot.load(hour);
  if (usageHourly == null) {
    usageHourly = new UsageMetricsHourlySnapshot(hour);
    usageHourly.protocol = protocol.id;
    usageHourly.hourlyActiveUsers = 0;
    usageHourly.cumulativeUniqueUsers = protocol.cumulativeUniqueUsers;
    usageHourly.hourlyTransactionCount = 0;
    usageHourly.hourlyDepositCount = 0;
    usageHourly.hourlyWithdrawCount = 0;
  }
  usageHourly.blockNumber = block.number;
  usageHourly.timestamp = block.timestamp;
  usageHourly.save();

  let financials = FinancialsDailySnapshot.load(day);
  if (financials == null) {
    financials = new FinancialsDailySnapshot(day);
    financials.protocol = protocol.id;
    financials.dailySupplySideRevenueUSD = ZERO;
    financials.dailyProtocolSideRevenueUSD = ZERO;
    financials.dailyTotalRevenueUSD = ZERO;
  }
  financials.totalValueLockedUSD = protocol.totalValueLockedUSD;
  financials.cumulativeSupplySideRevenueUSD = protocol.cumulativeSupplySideRevenueUSD;
  financials.cumulativeProtocolSideRevenueUSD = protocol.cumulativeProtocolSideRevenueUSD;
  financials.cumulativeTotalRevenueUSD = protocol.cumulativeTotalRevenueUSD;
  financials.blockNumber = block.number;
  financials.timestamp = block.timestamp;
  financials.save();
}
