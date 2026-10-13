#!/usr/bin/env bash
# After launching $CUBE on Pons from the dev wallet: plugs it into the BuyBurn. One transaction, permanent.
#   ./set-token.sh 0xTOKEN
set -euo pipefail
cd "$(dirname "$0")"
[[ "${1:-}" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "usage: ./set-token.sh <\$CUBE token address>" >&2; exit 1; }
[[ -d contracts/node_modules ]] || (cd contracts && npm ci --no-audit --no-fund)
eval "$(node tools/env.js)"
[[ -n "${DEPLOYER_ACCOUNT:-}" ]] || { echo "STOPPED: DEPLOYER_ACCOUNT is not set in launch.env" >&2; exit 1; }
cd contracts
CUBE_TOKEN_ADDRESS="$1" node ../tools/with-key.js "$DEPLOYER_ACCOUNT" -- npx hardhat run scripts/set-token.js --network robinhood
node scripts/export-abis.js
echo "Next: git add -A && git commit -m \"Plug in \$CUBE\" && git push"
