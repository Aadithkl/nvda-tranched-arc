# Uniswap Developer Feedback — nvda-tranched-arc

> Written by the project team (not AI-generated). Fill in every section below, then submit the
Notes for the Uniswap team; code pointers in the README and docs/ARCHITECTURE.md.
> https://developers.uniswap.org/

## What we built on Uniswap v4

<!--
One or two paragraphs. Suggested content:
- TrancheJITHook: JIT liquidity + dynamic fee + oracle-gated quoting for a tranched RWA book.
- Canonical v4 contracts (pinned submodules) redeployed on Arc testnet because Arc has no canonical
  v4 deployment; see script/DeployV4Stack.s.sol and docs/ARCHITECTURE.md.
-->

## What worked well

<!--
What was good about v4 / hooks / periphery / docs / testing? Be specific.
Examples: PoolManager delta accounting (sync/settle/take), beforeSwap/afterSwap lifecycle,
dynamic fee flag, HookMiner permissions, periphery lens contracts, v4-template.
-->

## Friction, bugs, and surprises

<!--
Concrete DX issues you hit while building this. Link code or docs where possible.
Examples: hook address mining, gas/limits, ERC-6909 claim handling, docs gaps,
redeploying v4 on a new chain, tooling friction.
-->

## Suggestions

<!--
What would you change? Rank the top 3 if you can.
-->

## Links

- Repository: https://github.com/Aadithkl/nvda-tranched-arc
- Hook: [src/hook/TrancheJITHook.sol](https://github.com/Aadithkl/nvda-tranched-arc/blob/main/src/hook/TrancheJITHook.sol)
- v4 deployment script: [script/DeployV4Stack.s.sol](https://github.com/Aadithkl/nvda-tranched-arc/blob/main/script/DeployV4Stack.s.sol)
- Architecture: [docs/ARCHITECTURE.md](https://github.com/Aadithkl/nvda-tranched-arc/blob/main/docs/ARCHITECTURE.md)
- Demo video: <!-- add link -->
