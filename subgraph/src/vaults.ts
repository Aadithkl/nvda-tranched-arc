import { Address, BigInt, ethereum } from "@graphprotocol/graph-ts";
import {
  DepositsPausedSet,
  MaxTotalAssetsUpdated,
  SharesMoved,
  TrancheVault,
  UsdcDeposited,
  UsdcUnwrapped
} from "../generated/SeniorVault/TrancheVault";
import { VaultFlow, VaultState } from "../generated/schema";

function flowId(event: ethereum.Event): string {
  return event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
}

function isSeniorVault(address: Address): boolean {
  let vault = TrancheVault.bind(address);
  let result = vault.try_isSenior();
  return !result.reverted && result.value;
}

function loadState(address: Address): VaultState {
  let id = address.toHexString();
  let state = VaultState.load(id);
  if (state == null) {
    state = new VaultState(id);
    state.isSenior = isSeniorVault(address);
    state.totalDepositUsdc = BigInt.zero();
    state.totalUnwrapUsdc = BigInt.zero();
    state.totalSharesMoved = BigInt.zero();
    state.depositCount = BigInt.zero();
    state.unwrapCount = BigInt.zero();
    state.depositsPaused = false;
    state.maxTotalAssets = BigInt.zero();
    state.updatedAtTimestamp = BigInt.zero();
    state.updatedAtBlock = BigInt.zero();
  }
  return state as VaultState;
}

function touch(state: VaultState, timestamp: BigInt, block: BigInt): void {
  state.updatedAtTimestamp = timestamp;
  state.updatedAtBlock = block;
}

export function handleUsdcDeposited(event: UsdcDeposited): void {
  let state = loadState(event.address);
  state.totalDepositUsdc = state.totalDepositUsdc.plus(event.params.usdcAmount);
  state.depositCount = state.depositCount.plus(BigInt.fromI32(1));
  touch(state, event.block.timestamp, event.block.number);
  state.save();

  let flow = new VaultFlow(flowId(event));
  flow.vault = event.address;
  flow.isSenior = state.isSenior;
  flow.kind = "Deposit";
  flow.caller = event.params.caller;
  flow.receiver = event.params.receiver;
  flow.usdcAmount = event.params.usdcAmount;
  flow.shares = event.params.shares;
  flow.transactionHash = event.transaction.hash;
  flow.timestamp = event.block.timestamp;
  flow.blockNumber = event.block.number;
  flow.save();
}

export function handleUsdcUnwrapped(event: UsdcUnwrapped): void {
  let state = loadState(event.address);
  state.totalUnwrapUsdc = state.totalUnwrapUsdc.plus(event.params.usdcAmount);
  state.unwrapCount = state.unwrapCount.plus(BigInt.fromI32(1));
  touch(state, event.block.timestamp, event.block.number);
  state.save();

  let flow = new VaultFlow(flowId(event));
  flow.vault = event.address;
  flow.isSenior = state.isSenior;
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

export function handleSharesMoved(event: SharesMoved): void {
  let state = loadState(event.address);
  state.totalSharesMoved = state.totalSharesMoved.plus(event.params.amount);
  touch(state, event.block.timestamp, event.block.number);
  state.save();

  let flow = new VaultFlow(flowId(event));
  flow.vault = event.address;
  flow.isSenior = state.isSenior;
  flow.kind = "Move";
  flow.caller = event.transaction.from;
  flow.receiver = event.params.to;
  flow.usdcAmount = BigInt.zero();
  flow.shares = event.params.amount;
  flow.transactionHash = event.transaction.hash;
  flow.timestamp = event.block.timestamp;
  flow.blockNumber = event.block.number;
  flow.save();
}

export function handleDepositsPausedSet(event: DepositsPausedSet): void {
  let state = loadState(event.address);
  state.depositsPaused = event.params.paused;
  touch(state, event.block.timestamp, event.block.number);
  state.save();
}

export function handleMaxTotalAssetsUpdated(event: MaxTotalAssetsUpdated): void {
  let state = loadState(event.address);
  state.maxTotalAssets = event.params.maxTotalAssets;
  touch(state, event.block.timestamp, event.block.number);
  state.save();
}
