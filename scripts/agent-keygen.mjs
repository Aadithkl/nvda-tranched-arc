import fs from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ENV = ".env";
const env = fs.existsSync(ENV) ? fs.readFileSync(ENV, "utf8") : "";

if (/AGENT_OPERATOR_PRIVATE_KEY=/.test(env)) {
  const match = env.match(/AGENT_OPERATOR_ADDRESS=(.*)/);
  console.log("operator already set:", match ? match[1] : "(key present)");
} else {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  fs.appendFileSync(
    ENV,
    `\n# hook demo agent operator (testnet only, never shared)\nAGENT_OPERATOR_PRIVATE_KEY=${privateKey}\nAGENT_OPERATOR_ADDRESS=${account.address}\n`,
  );
  console.log("generated operator:", account.address);
}
