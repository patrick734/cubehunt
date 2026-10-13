#!/usr/bin/env bash
# CubeHunt launch.
#   ./launch.sh --rehearsal   full deploy on a local copy of Robinhood Chain: free, sends nothing
#   ./launch.sh               real deploy from the dev wallet named in launch.env
# Settings come from launch.env (copy launch.env.example). Keys never go in that file: the dev wallet is a
# password-encrypted keystore made with `node tools/import-key.js <name>`.
set -euo pipefail
cd "$(dirname "$0")"

step() { printf '\n== %s\n' "$1"; }
stop() { printf 'STOPPED: %s\n' "$1" >&2; exit 1; }

REHEARSAL=0
[[ "${1:-}" == "--rehearsal" ]] && REHEARSAL=1

command -v node >/dev/null || stop "Node.js is not installed. Get version 22 from https://nodejs.org"
[[ -f launch.env ]] || stop "launch.env is missing. Run: cp launch.env.example launch.env, then fill it in."

step "Settings"
[[ -d contracts/node_modules ]] || (cd contracts && npm ci --no-audit --no-fund)
eval "$(node tools/env.js)"
for v in KEEPER_ADDRESS DEPLOYER_ACCOUNT; do
  [[ -n "${!v:-}" ]] || stop "$v is not set in launch.env"
done
DEPLOYER_ADDRESS=$(node tools/wallet.js address "$DEPLOYER_ACCOUNT")
export DEPLOYER_ADDRESS KEEPER_ADDRESS
echo "Dev wallet: $DEPLOYER_ADDRESS ($DEPLOYER_ACCOUNT): deploys, guardian for setup only (powers end by themselves)"
echo "Keeper:     $KEEPER_ADDRESS (runs the capped buy-and-burn only)"
[[ -n "${ROBINHOOD_RPC_URL:-}" ]] && echo "RPC:        private RPC from launch.env" || echo "RPC:        public Robinhood RPC (set ROBINHOOD_RPC_URL if it keeps dropping)"

if [[ $REHEARSAL == 0 && -f contracts/deployments/robinhood.json && "${FORCE:-}" != "1" ]]; then
  stop "contracts/deployments/robinhood.json exists, so CubeHunt is already deployed. Use FORCE=1 only for a second, separate deployment."
fi

cd contracts
step "Compiling"
npx hardhat compile --quiet

step "Preflight checks"
[[ $REHEARSAL == 1 ]] && export MIN_DEPLOYER_ETH=0
node scripts/preflight.js || stop "Preflight failed. Fix the FAIL lines above and run again."

if [[ $REHEARSAL == 1 ]]; then
  step "Rehearsal deploy on a local copy of Robinhood Chain"
  rm -f deployments/fork.json
  if ! FORK=1 DEPLOY_LIVE=1 npx hardhat run scripts/deploy.js; then
    rm -f deployments/fork.json
    stop "The rehearsal failed (see above). A dropped connection shows up here too: set ROBINHOOD_RPC_URL to a private RPC and run again."
  fi
  [[ -f deployments/fork.json ]] || stop "The rehearsal ended without writing its record. Run again."
  rm -f deployments/fork.json
  printf '\nREHEARSAL PASSED. Nothing was sent. Deploy for real with: ./launch.sh\n'
  exit 0
fi

step "Real deploy"
echo "This deploys CubeHunt to Robinhood Chain mainnet, paying gas from $DEPLOYER_ADDRESS."
read -r -p "Type DEPLOY to continue: " answer </dev/tty
[[ "$answer" == "DEPLOY" ]] || stop "Cancelled. Nothing was sent."
if ! node ../tools/with-key.js "$DEPLOYER_ACCOUNT" -- npx hardhat run scripts/deploy.js --network robinhood; then
  [[ -f deployments/robinhood.json ]] && { node scripts/export-abis.js; stop "CubeHunt IS deployed (deployments/robinhood.json); only the steps after it failed. Do not deploy again: run ./verify.sh."; }
  stop "The deploy did not finish (see above). A half-finished set holds nothing and the site never lists it; fix the cause and run ./launch.sh again."
fi

step "Publishing addresses to the app"
node scripts/export-abis.js

step "Publishing source (Sourcify) and checking who holds power"
sleep 15
npx hardhat run scripts/verify.js --network robinhood || echo "Not everything is verified yet: run ./verify.sh in a few minutes."

step "Deployed"
cat <<'EOT'
Addresses: contracts/deployments/robinhood.json

Next:
  1. git add -A && git commit -m "Mainnet deployment" && git push      (Vercel publishes the live site)
  2. Launch $CUBE on ponsfamily.com/launchpad from the same dev wallet, then: ./set-token.sh <token address>
  3. Keeper: GitHub > Actions > "Keeper" > Run workflow (dry run). When it looks healthy, set KEEPER_LIVE=1.
EOT
