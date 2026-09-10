import manifest from "../deployments/arc-testnet.json";
import oracleAbi from "../docs/abis/NVDAPriceOracle.json";
import routerAbi from "../docs/abis/DemoRouter.json";
import stateViewAbi from "../docs/abis/StateView.json";
import quoterAbi from "../docs/abis/V4Quoter.json";
import erc20Abi from "../docs/abis/ERC20.json";

export const deployment = manifest;
export const contracts = manifest.contracts;
export const pools = manifest.pools;
export const oracle = manifest.oracle;

export { oracleAbi, routerAbi, stateViewAbi, quoterAbi, erc20Abi };

// tsconfig: { "resolveJsonModule": true, "esModuleInterop": true }
