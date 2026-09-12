import { BigInt, ethereum } from "@graphprotocol/graph-ts";
import {
  DepositReported,
  Rebalanced,
  RedeemFulfilled,
  RedeemReported
} from "../generated/TrancheAccountant/TrancheAccountant";
import { AccountantReport, Rebalance, RedemptionFulfilment } from "../generated/schema";

function rowId(event: ethereum.Event): string {
  return event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
}

export function handleDepositReported(event: DepositReported): void {
  let report = new AccountantReport(rowId(event));
  report.kind = "Deposit";
  report.senior = event.params.senior;
  report.hookShares = event.params.hookShares;
  report.usdcValue = event.params.usdcValue;
  report.transactionHash = event.transaction.hash;
  report.timestamp = event.block.timestamp;
  report.blockNumber = event.block.number;
  report.save();
}

export function handleRedeemReported(event: RedeemReported): void {
  let report = new AccountantReport(rowId(event));
  report.kind = "Redeem";
  report.senior = event.params.senior;
  report.hookShares = event.params.hookShares;
  report.usdcValue = event.params.usdcValue;
  report.transactionHash = event.transaction.hash;
  report.timestamp = event.block.timestamp;
  report.blockNumber = event.block.number;
  report.save();
}

export function handleRebalanced(event: Rebalanced): void {
  let rebalance = new Rebalance(rowId(event));
  rebalance.movedToSenior = event.params.movedToSenior;
  rebalance.movedToJunior = event.params.movedToJunior;
  rebalance.transactionHash = event.transaction.hash;
  rebalance.timestamp = event.block.timestamp;
  rebalance.blockNumber = event.block.number;
  rebalance.save();
}

export function handleRedeemFulfilled(event: RedeemFulfilled): void {
  let fulfilment = new RedemptionFulfilment(rowId(event));
  fulfilment.senior = event.params.senior;
  fulfilment.user = event.params.user;
  fulfilment.shares = event.params.shares;
  fulfilment.assets = event.params.assets;
  fulfilment.transactionHash = event.transaction.hash;
  fulfilment.timestamp = event.block.timestamp;
  fulfilment.blockNumber = event.block.number;
  fulfilment.save();
}
