// Keeper smoke test against a local Hardhat node with the demo deploy:
//   (cd ../contracts && npx hardhat node) ; (cd ../contracts && npx hardhat run scripts/deploy.js --network localhost)
//   DEPLOYMENT_FILE=../contracts/deployments/localhost.json ROBINHOOD_RPC_URL=http://127.0.0.1:8545 npm test
const { spawnSync } = require("child_process");
const path = require("path");
const KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"; // Hardhat dev account #3, not a secret
const r = spawnSync(process.execPath, [path.join(__dirname, "index.js")], { env: { ...process.env, KEEPER_PRIVATE_KEY: KEY }, encoding: "utf8" });
process.stdout.write(r.stdout + r.stderr);
process.exit(r.status);
