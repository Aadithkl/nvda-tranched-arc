import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = [
  ["TrancheJITHook.sol/TrancheJITHook.json", "TrancheJITHook.json"],
  ["StrategyController.sol/StrategyController.json", "StrategyController.json"],
  ["StrategyAgent.sol/StrategyAgent.json", "StrategyAgent.json"],
  ["TrancheVault.sol/TrancheVault.json", "TrancheVault.json"],
  ["TrancheAccountant.sol/TrancheAccountant.json", "TrancheAccountant.json"],
];

const outDir = join(root, "subgraph", "abis");
mkdirSync(outDir, { recursive: true });

for (const [source, target] of artifacts) {
  const artifact = JSON.parse(readFileSync(join(root, "out", source), "utf8"));
  if (!Array.isArray(artifact.abi)) throw new Error(`no abi in ${source}`);
  writeFileSync(join(outDir, target), JSON.stringify(artifact.abi, null, 2) + "\n", "utf8");
  console.log(`wrote subgraph/abis/${target} (${artifact.abi.length} entries)`);
}
