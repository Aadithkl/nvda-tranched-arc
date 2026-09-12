import { BigInt, ethereum } from "@graphprotocol/graph-ts";
import {
  AccountantUpdated,
  ActivePoolSet,
  BaseFeeUpdated,
  ControllerUpdated,
  GuardianUpdated,
  InventorySeeded,
  JitClaimRedeemed,
  JitDeployed,
  JitEnabledSet,
  JitRemoved,
  LendingPoolUpdated,
  LiquidityGuardSet,
  MaxPriceAgeUpdated,
  OwnerUpdated,
  OwnershipTransferStarted,
  ParamsUpdated,
  PausedSet,
  PriceOracleUpdated,
  QuotingEnabledSet,
  SharesUnwrapped,
  SharesWrapped,
  SuppliedToAave,
  SwapQuoted,
  WithdrawnFromAave
} from "../generated/TrancheJITHook/TrancheJITHook";
import {
  ClaimRedemption,
  HookState,
  JitDeployment,
  JitRemoval,
  ParamChange,
  Quote,
  ShareFlow as ShareFlowEntity
} from "../generated/schema";

function loadState(id: string): HookState {
  let state = HookState.load(id);
  if (state == null) {
    state = new HookState(id);
    state.quotingEnabled = false;
    state.jitEnabled = false;
    state.liquidityGuard = false;
    state.paused = false;
    state.maxPriceAge = BigInt.zero();
    state.baseFee = BigInt.zero();
    state.maxSurgeFee = BigInt.zero();
    state.maxDeviationBps = 0;
    state.toxicityMultiplierBps = 0;
    state.minEvBps = 0;
    state.cooldownSeconds = 0;
    state.ttl = 0;
    state.gracePeriod = 0;
    state.maxDeployPerSwap = BigInt.zero();
    state.bucketTicks = 0;
    state.totalQuotes = BigInt.zero();
    state.totalJitDeployments = BigInt.zero();
    state.totalJitRemovals = BigInt.zero();
    state.totalWraps = BigInt.zero();
    state.totalUnwraps = BigInt.zero();
    state.totalSeedUsdc = BigInt.zero();
    state.totalSuppliedToAave = BigInt.zero();
    state.totalWithdrawnFromAave = BigInt.zero();
    state.updatedAtTimestamp = BigInt.zero();
    state.updatedAtBlock = BigInt.zero();
  }
  return state as HookState;
}

function touch(state: HookState, timestamp: BigInt, block: BigInt): void {
  state.updatedAtTimestamp = timestamp;
  state.updatedAtBlock = block;
}

function quoteStateName(state: i32): string {
  if (state == 2) return "Active";
  if (state == 1) return "Degraded";
  return "Rest";
}

function shareFlowId(event: ethereum.Event): string {
  return event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
}

export function handleParamsUpdated(event: ParamsUpdated): void {
  let state = loadState(event.address.toHexString());
  let p = event.params.params;
  state.quotingEnabled = p.quotingEnabled;
  state.baseFee = BigInt.fromI32(p.baseFee);
  state.maxSurgeFee = BigInt.fromI32(p.maxSurgeFee);
  state.maxDeviationBps = p.maxDeviationBps;
  state.toxicityMultiplierBps = p.toxicityMultiplierBps;
  state.minEvBps = p.minEvBps;
  state.cooldownSeconds = p.cooldownSeconds.toI32();
  state.ttl = p.ttl.toI32();
  state.gracePeriod = p.gracePeriod.toI32();
  state.maxDeployPerSwap = p.maxDeployPerSwap;
  state.bucketTicks = p.bucketTicks;
  state.paramsUpdatedAt = event.params.updatedAt;
  touch(state, event.block.timestamp, event.block.number);
  state.save();

  let change = new ParamChange(shareFlowId(event));
  change.kind = "Params";
  change.quotingEnabled = p.quotingEnabled;
  change.baseFee = BigInt.fromI32(p.baseFee);
  change.maxSurgeFee = BigInt.fromI32(p.maxSurgeFee);
  change.maxDeviationBps = p.maxDeviationBps;
  change.toxicityMultiplierBps = p.toxicityMultiplierBps;
  change.minEvBps = p.minEvBps;
  change.cooldownSeconds = p.cooldownSeconds.toI32();
  change.ttl = p.ttl.toI32();
  change.gracePeriod = p.gracePeriod.toI32();
  change.maxDeployPerSwap = p.maxDeployPerSwap;
  change.bucketTicks = p.bucketTicks;
  change.transactionHash = event.transaction.hash;
  change.timestamp = event.block.timestamp;
  change.blockNumber = event.block.number;
  change.save();
}

export function handleBaseFeeUpdated(event: BaseFeeUpdated): void {
  let state = loadState(event.address.toHexString());
  state.baseFee = BigInt.fromI32(event.params.baseFee);
  touch(state, event.block.timestamp, event.block.number);
  state.save();

  let change = new ParamChange(shareFlowId(event));
  change.kind = "BaseFee";
  change.baseFee = BigInt.fromI32(event.params.baseFee);
  change.transactionHash = event.transaction.hash;
  change.timestamp = event.block.timestamp;
  change.blockNumber = event.block.number;
  change.save();
}

export function handleQuotingEnabledSet(event: QuotingEnabledSet): void {
  let state = loadState(event.address.toHexString());
  state.quotingEnabled = event.params.enabled;
  touch(state, event.block.timestamp, event.block.number);
  state.save();

  let change = new ParamChange(shareFlowId(event));
  change.kind = "Quoting";
  change.quotingEnabled = event.params.enabled;
  change.transactionHash = event.transaction.hash;
  change.timestamp = event.block.timestamp;
  change.blockNumber = event.block.number;
  change.save();
}

export function handleSwapQuoted(event: SwapQuoted): void {
  let state = loadState(event.address.toHexString());
  state.totalQuotes = state.totalQuotes.plus(BigInt.fromI32(1));
  touch(state, event.block.timestamp, event.block.number);
  state.save();

  let quote = new Quote(shareFlowId(event));
  quote.poolId = event.params.poolId;
  quote.sender = event.params.sender;
  quote.zeroForOne = event.params.zeroForOne;
  quote.deviationBps = event.params.deviationBps;
  quote.fee = BigInt.fromI32(event.params.fee);
  quote.toxic = event.params.toxic;
  quote.state = quoteStateName(event.params.state);
  quote.transactionHash = event.transaction.hash;
  quote.timestamp = event.block.timestamp;
  quote.blockNumber = event.block.number;
  quote.save();
}

export function handleJitDeployed(event: JitDeployed): void {
  let state = loadState(event.address.toHexString());
  state.totalJitDeployments = state.totalJitDeployments.plus(BigInt.fromI32(1));
  touch(state, event.block.timestamp, event.block.number);
  state.save();

  let deployment = new JitDeployment(shareFlowId(event));
  deployment.poolId = event.params.poolId;
  deployment.zeroForOne = event.params.zeroForOne;
  deployment.tickLower = event.params.tickLower;
  deployment.tickUpper = event.params.tickUpper;
  deployment.liquidity = event.params.liquidity;
  deployment.seed = event.params.seed;
  deployment.transactionHash = event.transaction.hash;
  deployment.timestamp = event.block.timestamp;
  deployment.blockNumber = event.block.number;
  deployment.save();
}

export function handleJitRemoved(event: JitRemoved): void {
  let state = loadState(event.address.toHexString());
  state.totalJitRemovals = state.totalJitRemovals.plus(BigInt.fromI32(1));
  touch(state, event.block.timestamp, event.block.number);
  state.save();

  let removal = new JitRemoval(shareFlowId(event));
  removal.poolId = event.params.poolId;
  removal.liquidity = event.params.liquidity;
  removal.claim0 = event.params.claim0;
  removal.claim1 = event.params.claim1;
  removal.transactionHash = event.transaction.hash;
  removal.timestamp = event.block.timestamp;
  removal.blockNumber = event.block.number;
  removal.save();
}

export function handleJitClaimRedeemed(event: JitClaimRedeemed): void {
  let redemption = new ClaimRedemption(shareFlowId(event));
  redemption.asset = event.params.asset;
  redemption.amount = event.params.amount;
  redemption.transactionHash = event.transaction.hash;
  redemption.timestamp = event.block.timestamp;
  redemption.blockNumber = event.block.number;
  redemption.save();
}

export function handleSharesWrapped(event: SharesWrapped): void {
  let state = loadState(event.address.toHexString());
  state.totalWraps = state.totalWraps.plus(BigInt.fromI32(1));
  touch(state, event.block.timestamp, event.block.number);
  state.save();

  let flow = new ShareFlowEntity(shareFlowId(event));
  flow.kind = "Wrap";
  flow.caller = event.params.caller;
  flow.receiver = event.params.receiver;
  flow.usdcAmount = event.params.usdcAmount;
  flow.shares = event.params.shares;
  flow.transactionHash = event.transaction.hash;
  flow.timestamp = event.block.timestamp;
  flow.blockNumber = event.block.number;
  flow.save();
}

export function handleSharesUnwrapped(event: SharesUnwrapped): void {
  let state = loadState(event.address.toHexString());
  state.totalUnwraps = state.totalUnwraps.plus(BigInt.fromI32(1));
  touch(state, event.block.timestamp, event.block.number);
  state.save();

  let flow = new ShareFlowEntity(shareFlowId(event));
  flow.kind = "Unwrap";
  flow.caller = event.params.caller;
  flow.receiver = event.params.receiver;
  flow.usdcAmount = event.params.usdcAmount;
  flow.shares = event.params.shares;
  flow.transactionHash = event.transaction.hash;
  flow.timestamp = event.block.timestamp;
  flow.blockNumber = event.block.number;
  flow.save();
}

export function handleSuppliedToAave(event: SuppliedToAave): void {
  let state = loadState(event.address.toHexString());
  state.totalSuppliedToAave = state.totalSuppliedToAave.plus(event.params.amount);
  touch(state, event.block.timestamp, event.block.number);
  state.save();

  let flow = new ShareFlowEntity(shareFlowId(event));
  flow.kind = "Supply";
  flow.caller = event.transaction.from;
  flow.usdcAmount = event.params.amount;
  flow.shares = BigInt.zero();
  flow.transactionHash = event.transaction.hash;
  flow.timestamp = event.block.timestamp;
  flow.blockNumber = event.block.number;
  flow.save();
}

export function handleWithdrawnFromAave(event: WithdrawnFromAave): void {
  let state = loadState(event.address.toHexString());
  state.totalWithdrawnFromAave = state.totalWithdrawnFromAave.plus(event.params.amount);
  touch(state, event.block.timestamp, event.block.number);
  state.save();

  let flow = new ShareFlowEntity(shareFlowId(event));
  flow.kind = "Withdraw";
  flow.caller = event.transaction.from;
  flow.usdcAmount = event.params.amount;
  flow.shares = BigInt.zero();
  flow.transactionHash = event.transaction.hash;
  flow.timestamp = event.block.timestamp;
  flow.blockNumber = event.block.number;
  flow.save();
}

export function handleInventorySeeded(event: InventorySeeded): void {
  let state = loadState(event.address.toHexString());
  state.totalSeedUsdc = state.totalSeedUsdc.plus(event.params.amount);
  touch(state, event.block.timestamp, event.block.number);
  state.save();

  let flow = new ShareFlowEntity(shareFlowId(event));
  flow.kind = "Seed";
  flow.caller = event.transaction.from;
  flow.usdcAmount = event.params.amount;
  flow.shares = BigInt.zero();
  flow.transactionHash = event.transaction.hash;
  flow.timestamp = event.block.timestamp;
  flow.blockNumber = event.block.number;
  flow.save();
}

export function handleActivePoolSet(event: ActivePoolSet): void {
  let state = loadState(event.address.toHexString());
  state.activePoolId = event.params.poolId;
  touch(state, event.block.timestamp, event.block.number);
  state.save();
}

export function handleJitEnabledSet(event: JitEnabledSet): void {
  let state = loadState(event.address.toHexString());
  state.jitEnabled = event.params.enabled;
  touch(state, event.block.timestamp, event.block.number);
  state.save();
}

export function handleLiquidityGuardSet(event: LiquidityGuardSet): void {
  let state = loadState(event.address.toHexString());
  state.liquidityGuard = event.params.enabled;
  touch(state, event.block.timestamp, event.block.number);
  state.save();
}

export function handlePausedSet(event: PausedSet): void {
  let state = loadState(event.address.toHexString());
  state.paused = event.params.paused;
  touch(state, event.block.timestamp, event.block.number);
  state.save();
}

export function handleMaxPriceAgeUpdated(event: MaxPriceAgeUpdated): void {
  let state = loadState(event.address.toHexString());
  state.maxPriceAge = event.params.maxPriceAge;
  touch(state, event.block.timestamp, event.block.number);
  state.save();
}

export function handleControllerUpdated(event: ControllerUpdated): void {
  let state = loadState(event.address.toHexString());
  state.controller = event.params.controller;
  touch(state, event.block.timestamp, event.block.number);
  state.save();
}

export function handlePriceOracleUpdated(event: PriceOracleUpdated): void {
  let state = loadState(event.address.toHexString());
  state.priceOracle = event.params.priceOracle;
  touch(state, event.block.timestamp, event.block.number);
  state.save();
}

export function handleLendingPoolUpdated(event: LendingPoolUpdated): void {
  let state = loadState(event.address.toHexString());
  state.lendingPool = event.params.lendingPool;
  state.aToken = event.params.aToken;
  state.aTokenEquity = event.params.aTokenEquity;
  touch(state, event.block.timestamp, event.block.number);
  state.save();
}

export function handleAccountantUpdated(event: AccountantUpdated): void {
  let state = loadState(event.address.toHexString());
  state.accountant = event.params.accountant;
  touch(state, event.block.timestamp, event.block.number);
  state.save();
}

export function handleGuardianUpdated(event: GuardianUpdated): void {
  let state = loadState(event.address.toHexString());
  state.guardian = event.params.guardian;
  touch(state, event.block.timestamp, event.block.number);
  state.save();
}

export function handleOwnerUpdated(event: OwnerUpdated): void {
  let state = loadState(event.address.toHexString());
  state.owner = event.params.owner;
  state.pendingOwner = null;
  touch(state, event.block.timestamp, event.block.number);
  state.save();
}

export function handleOwnershipTransferStarted(event: OwnershipTransferStarted): void {
  let state = loadState(event.address.toHexString());
  state.owner = event.params.currentOwner;
  state.pendingOwner = event.params.pendingOwner;
  touch(state, event.block.timestamp, event.block.number);
  state.save();
}
