# Launch CubeHunt (Mac)

Order: dev wallet + keeper → fund → rehearse → deploy → publish → launch $CUBE on Pons → plug it in → keeper live.

Rules: fund every wallet straight from KuCoin or OKX, never from another wallet, and never paste a private key into
chat, a command, a file or the repo.

| Role | Who | Power |
|---|---|---|
| Dev wallet | you (keystore `cubehunt-dev`) | deploys; guardian for 30 days: add targets, create vaults, start season 1, pause mining. No DAO role, no money moves, can't set prices or fees. Sets $CUBE once in the BuyBurn. |
| DAO | points holders via CubeGovernor | everything else, through a 48h timelock |
| Keeper | separate bot wallet, key only in GitHub | the capped, rate-limited buy-and-burn |

## 1. Code and wallets

```
cd ~/Desktop && git clone https://github.com/patrick734/cubehunt.git && cd cubehunt
(cd contracts && npm ci) && (cd keeper && npm ci) && (cd app && npm ci)
node tools/import-key.js cubehunt-dev
node tools/wallet.js keeper-secret patrick734/cubehunt
cp launch.env.example launch.env
open -e launch.env
```

`import-key.js` reads the new MetaMask account's private key from the clipboard, clears the clipboard and saves an
encrypted keystore. `keeper-secret` creates the keeper, stores its key only as the GitHub secret and writes
`KEEPER_ADDRESS` into launch.env.

## 2. Fund (from the exchange)

- Dev wallet: about 0.01 ETH (the deploy is about 30 transactions; the rest pays for set-token and the Pons launch).
- Keeper: 0.005 ETH.

## 3. Rehearse (free), then deploy

```
./launch.sh --rehearsal
./launch.sh
```

## 4. Publish

```
git add -A
git commit -m "Mainnet deployment"
git push
./verify.sh
```

Vercel: import the repo, Root Directory `app`, framework Next.js. Optional env: `NEXT_PUBLIC_SITE_URL`,
`NEXT_PUBLIC_X_URL`, `ROBINHOOD_RPC_URL`.

## 5. $CUBE

Launch $CUBE on ponsfamily.com/launchpad from the dev wallet, then:

```
./set-token.sh 0xYOUR_CUBE_ADDRESS
git add -A
git commit -m "Plug in CUBE"
git push
```

## 6. Keeper live

GitHub → Actions → Keeper → Run workflow (dry run). When the log quotes a burn, set the repo variable `KEEPER_LIVE`
to `1`.
