# CubeHunt

Mine the seven unsolved sums of three cubes below 1000 (114, 390, 627, 633, 732, 921, 975) from your browser on
Robinhood Chain. The chain checks every share itself and pays a prize vault, on the spot, to whoever submits a real
x³ + y³ + z³ = k. Fees buy and burn **$CUBE**.

```
contracts/  Hunt, Vaults, Points (votes), Governor, 48h Timelock, BuyBurn. Hardhat; tests include the browser miner.
app/        Next.js site: in-browser miner (web workers), prize vaults, DAO, safety page. Deploy on Vercel (root: app).
keeper/     Buy-and-burn bot, run hourly by GitHub Actions, gated by the KEEPER_LIVE repo variable.
tools/      Encrypted dev-wallet keystore, keeper key straight into a GitHub secret. No key is ever typed or printed.
launch.sh   Rehearsal and real deploy from the dev wallet. Step by step: docs/LAUNCH.md.
```

## What is different from Ponmath

The hunt and vault logic is based on Ponmath's MIT-licensed contracts. CubeHunt changes who holds power:

| | Ponmath | CubeHunt |
|---|---|---|
| Guardian powers | until renounced | end on their own at `guardianUntil` (30 days, at most 90, fixed at deploy) |
| Who can list an asset or set its price feed | guardian | DAO vote only; USDG ($1) and ETH (Chainlink) fixed at deploy |
| Points per dollar, later seasons | guardian | DAO vote only (guardian starts season 1 only) |
| Guardian can make a wallet a points minter | before sealing | never (contracts only) |
| Guardian can cancel DAO votes | yes | no: the governor is the only proposer and canceller |
| Timelock delay | 12 hours | 48 hours |
| Fees | none | 0.00001 ETH per accepted share and 3% of deposits buy and burn $CUBE (caps 0.0001 ETH and 10%, DAO-only) |

## Tests

```
cd contracts && npm ci && npx hardhat test
cd app && npm ci && npx tsc --noEmit && npm run build
```
