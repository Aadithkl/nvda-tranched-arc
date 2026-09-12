import { BigInt, ethereum } from "@graphprotocol/graph-ts";
import {
  BaseFeeSubmitted,
  ParamsSubmitted,
  QuotingSubmitted
} from "../generated/StrategyController/StrategyController";
import {
  BaseFeeSubmitted as AgentBaseFeeSubmitted,
  ParamsSubmitted as AgentParamsSubmitted,
  QuotingSubmitted as AgentQuotingSubmitted
} from "../generated/StrategyAgent/StrategyAgent";
import { AgentAction } from "../generated/schema";

function actionId(event: ethereum.Event): string {
  return event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
}

export function handleParamsSubmitted(event: ParamsSubmitted): void {
  let action = new AgentAction(actionId(event));
  action.agent = event.params.agent;
  action.source = "Controller";
  action.kind = "Params";
  let p = event.params.params;
  action.quotingEnabled = p.quotingEnabled;
  action.baseFee = BigInt.fromI32(p.baseFee);
  action.maxSurgeFee = BigInt.fromI32(p.maxSurgeFee);
  action.maxDeviationBps = p.maxDeviationBps;
  action.toxicityMultiplierBps = p.toxicityMultiplierBps;
  action.minEvBps = p.minEvBps;
  action.cooldownSeconds = p.cooldownSeconds.toI32();
  action.ttl = p.ttl.toI32();
  action.gracePeriod = p.gracePeriod.toI32();
  action.maxDeployPerSwap = p.maxDeployPerSwap;
  action.bucketTicks = p.bucketTicks;
  action.transactionHash = event.transaction.hash;
  action.timestamp = event.block.timestamp;
  action.blockNumber = event.block.number;
  action.save();
}

export function handleBaseFeeSubmitted(event: BaseFeeSubmitted): void {
  let action = new AgentAction(actionId(event));
  action.agent = event.params.agent;
  action.source = "Controller";
  action.kind = "BaseFee";
  action.baseFee = BigInt.fromI32(event.params.baseFee);
  action.transactionHash = event.transaction.hash;
  action.timestamp = event.block.timestamp;
  action.blockNumber = event.block.number;
  action.save();
}

export function handleQuotingSubmitted(event: QuotingSubmitted): void {
  let action = new AgentAction(actionId(event));
  action.agent = event.params.agent;
  action.source = "Controller";
  action.kind = "Quoting";
  action.quotingEnabled = event.params.enabled;
  action.transactionHash = event.transaction.hash;
  action.timestamp = event.block.timestamp;
  action.blockNumber = event.block.number;
  action.save();
}

export function handleAgentParamsSubmitted(event: AgentParamsSubmitted): void {
  let action = new AgentAction(actionId(event));
  action.agent = event.address;
  action.source = "Agent";
  action.kind = "Params";
  let p = event.params.params;
  action.quotingEnabled = p.quotingEnabled;
  action.baseFee = BigInt.fromI32(p.baseFee);
  action.maxSurgeFee = BigInt.fromI32(p.maxSurgeFee);
  action.maxDeviationBps = p.maxDeviationBps;
  action.toxicityMultiplierBps = p.toxicityMultiplierBps;
  action.minEvBps = p.minEvBps;
  action.cooldownSeconds = p.cooldownSeconds.toI32();
  action.ttl = p.ttl.toI32();
  action.gracePeriod = p.gracePeriod.toI32();
  action.maxDeployPerSwap = p.maxDeployPerSwap;
  action.bucketTicks = p.bucketTicks;
  action.transactionHash = event.transaction.hash;
  action.timestamp = event.block.timestamp;
  action.blockNumber = event.block.number;
  action.save();
}

export function handleAgentBaseFeeSubmitted(event: AgentBaseFeeSubmitted): void {
  let action = new AgentAction(actionId(event));
  action.agent = event.address;
  action.source = "Agent";
  action.kind = "BaseFee";
  action.baseFee = BigInt.fromI32(event.params.baseFee);
  action.transactionHash = event.transaction.hash;
  action.timestamp = event.block.timestamp;
  action.blockNumber = event.block.number;
  action.save();
}

export function handleAgentQuotingSubmitted(event: AgentQuotingSubmitted): void {
  let action = new AgentAction(actionId(event));
  action.agent = event.address;
  action.source = "Agent";
  action.kind = "Quoting";
  action.quotingEnabled = event.params.enabled;
  action.transactionHash = event.transaction.hash;
  action.timestamp = event.block.timestamp;
  action.blockNumber = event.block.number;
  action.save();
}
