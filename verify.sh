#!/usr/bin/env bash
# Publishes every CubeHunt contract's source (Sourcify, read by the explorer) and checks on chain that the dev wallet
# holds no DAO power. No key, no gas. Safe to run again.
set -euo pipefail
cd "$(dirname "$0")"
[[ -d contracts/node_modules ]] || (cd contracts && npm ci --no-audit --no-fund)
eval "$(node tools/env.js)"
cd contracts
npx hardhat run scripts/verify.js --network robinhood
