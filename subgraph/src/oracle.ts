import { BigInt, Bytes } from "@graphprotocol/graph-ts";
import {
  PriceUpdated,
  X402PriceUpdated,
  MarketStatusUpdated,
  PrimarySourceUpdated,
} from "../generated/NVDAPriceOracle/NVDAPriceOracle";
import { OracleState, PriceUpdate } from "../generated/schema";

function loadState(): OracleState {
  let state = OracleState.load("global");
  if (state == null) {
    state = new OracleState("global");
    state.primarySource = "ChainlinkStreams";
    state.marketStatus = 0;
    state.lastMid = BigInt.zero();
    state.lastBid = BigInt.zero();
    state.lastAsk = BigInt.zero();
    state.lastSource = "ChainlinkStreams";
    state.lastObservationsTimestamp = BigInt.zero();
    state.lastUpdatedAt = BigInt.zero();
    state.totalUpdates = BigInt.zero();
  }
  return state as OracleState;
}

function sessionFromStatus(status: i32): string {
  if (status == 1 || status == 3) return "Extended";
  if (status == 2) return "Regular";
  if (status == 4) return "Overnight";
  return "None";
}

export function handlePriceUpdated(event: PriceUpdated): void {
  let state = loadState();
  state.marketStatus = event.params.marketStatus.toI32();
  state.lastMid = event.params.mid;
  state.lastBid = event.params.bid;
  state.lastAsk = event.params.ask;
  state.lastSource = "ChainlinkStreams";
  state.lastObservationsTimestamp = event.params.observationsTimestamp;
  state.lastUpdatedAt = event.params.updatedAt;
  state.totalUpdates = state.totalUpdates.plus(BigInt.fromI32(1));
  state.save();

  let update = new PriceUpdate(event.transaction.hash.toHexString() + "-" + event.logIndex.toString());
  update.source = "ChainlinkStreams";
  update.mid = event.params.mid;
  update.bid = event.params.bid;
  update.ask = event.params.ask;
  update.marketStatus = event.params.marketStatus.toI32();
  update.session = sessionFromStatus(event.params.marketStatus.toI32());
  update.observationsTimestamp = event.params.observationsTimestamp;
  update.updatedAt = event.params.updatedAt;
  update.transactionHash = event.transaction.hash;
  update.timestamp = event.block.timestamp;
  update.blockNumber = event.block.number;
  update.save();
}

export function handleX402PriceUpdated(event: X402PriceUpdated): void {
  let state = loadState();
  state.marketStatus = event.params.marketStatus.toI32();
  state.lastMid = event.params.mid;
  state.lastBid = event.params.mid;
  state.lastAsk = event.params.mid;
  state.lastSource = "X402";
  state.lastObservationsTimestamp = event.params.sourceTimestamp;
  state.lastUpdatedAt = event.params.updatedAt;
  state.lastWriter = event.params.writer;
  state.lastPaymentRef = event.params.paymentRef;
  state.totalUpdates = state.totalUpdates.plus(BigInt.fromI32(1));
  state.save();

  let update = new PriceUpdate(event.transaction.hash.toHexString() + "-" + event.logIndex.toString());
  update.source = "X402";
  update.mid = event.params.mid;
  update.bid = event.params.mid;
  update.ask = event.params.mid;
  update.marketStatus = event.params.marketStatus.toI32();
  update.session = sessionFromStatus(event.params.marketStatus.toI32());
  update.observationsTimestamp = event.params.sourceTimestamp;
  update.updatedAt = event.params.updatedAt;
  update.writer = event.params.writer;
  update.paymentRef = event.params.paymentRef;
  update.transactionHash = event.transaction.hash;
  update.timestamp = event.block.timestamp;
  update.blockNumber = event.block.number;
  update.save();
}

export function handleMarketStatusUpdated(event: MarketStatusUpdated): void {
  let state = loadState();
  state.marketStatus = event.params.marketStatus.toI32();
  state.save();
}

export function handlePrimarySourceUpdated(event: PrimarySourceUpdated): void {
  let state = loadState();
  state.primarySource = event.params.source == 2 ? "X402" : "ChainlinkStreams";
  state.save();
}
