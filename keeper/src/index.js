// CubeHunt keeper: turns the BuyBurn's ETH and USDG fees into burned $CUBE. One run, then exit (GitHub Actions cron).
//   KEEPER_PRIVATE_KEY=... node src/index.js            dry run (quotes only, sends nothing)
//   KEEPER_LIVE=1 KEEPER_PRIVATE_KEY=... node src/index.js  sends the burns
// Each burn is capped on chain (maxEthPerRun / maxUsdgPerRun, minInterval) and protected by a minimum output: the
// keeper quotes the burn with eth_call and accepts at most SLIPPAGE_BPS less.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const LIVE = process.env.KEEPER_LIVE === "1";
const SLIPPAGE_BPS = BigInt(process.env.SLIPPAGE_BPS || "300");
const MIN_ETH = ethers.parseEther(process.env.MIN_ETH_BURN || "0.0005");
const MIN_USDG = ethers.parseUnits(process.env.MIN_USDG_BURN || "1", 6);
const ABI = [
  "function token() view returns (address)",
  "function usdg() view returns (address)",
  "function halted() view returns (bool)",
  "function lastBurn() view returns (uint64)",
  "function minInterval() view returns (uint32)",
  "function maxEthPerRun() view returns (uint256)",
  "function maxUsdgPerRun() view returns (uint256)",
  "function totalBurned() view returns (uint256)",
  "function burn(uint256 ethIn, uint256 minOut) returns (uint256)",
  "function burnUsdg(uint256 usdgIn, uint256 minOut) returns (uint256)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function KEEPER_ROLE() view returns (bytes32)",
];
const log = (...a) => console.log(new Date().toISOString(), ...a);

function deployment() {
  const f = process.env.DEPLOYMENT_FILE || path.join(__dirname, "..", "..", "contracts", "deployments", "robinhood.json");
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

async function main() {
  const d = deployment();
  if (!d) return log("CubeHunt is not deployed yet (no contracts/deployments/robinhood.json). Nothing to do.");
  const key = process.env.KEEPER_PRIVATE_KEY;
  if (!key) throw new Error("KEEPER_PRIVATE_KEY is not set");
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
  const wallet = new ethers.Wallet(key, provider);
  const bb = new ethers.Contract(d.buyBurn, ABI, wallet);
  log(`keeper ${wallet.address}, ${LIVE ? "LIVE" : "dry run"}, BuyBurn ${d.buyBurn}`);

  if (!(await bb.hasRole(await bb.KEEPER_ROLE(), wallet.address))) return log("this wallet is not the BuyBurn keeper; stopping");
  if ((await bb.token()) === ethers.ZeroAddress) return log("$CUBE not plugged in yet (./set-token.sh); fees wait in the BuyBurn");
  if (await bb.halted()) return log("BuyBurn is halted by the guardian; only a DAO vote can resume it");
  const [last, interval] = await Promise.all([bb.lastBurn(), bb.minInterval()]);
  const now = BigInt((await provider.getBlock("latest")).timestamp);
  if (now < last + BigInt(interval)) return log(`rate limited: next burn in ${last + BigInt(interval) - now}s`);

  const usdg = new ethers.Contract(await bb.usdg(), ["function balanceOf(address) view returns (uint256)"], provider);
  const [ethBal, usdgBal, maxEth, maxUsdg] = await Promise.all([provider.getBalance(d.buyBurn), usdg.balanceOf(d.buyBurn), bb.maxEthPerRun(), bb.maxUsdgPerRun()]);
  log(`holding ${ethers.formatEther(ethBal)} ETH and ${ethers.formatUnits(usdgBal, 6)} USDG`);

  // One burn per run (the on-chain interval is shared): ETH first when there is enough, else USDG.
  let fn, amount;
  if (ethBal >= MIN_ETH) [fn, amount] = ["burn", ethBal < maxEth ? ethBal : maxEth];
  else if (usdgBal >= MIN_USDG) [fn, amount] = ["burnUsdg", usdgBal < maxUsdg ? usdgBal : maxUsdg];
  else return log("below the minimum burn size; waiting for more fees");

  let quoted;
  try {
    quoted = await bb[fn].staticCall(amount, 0n);
  } catch (e) {
    return log(`quote failed (${e.shortMessage || e.message}); the $CUBE pool may not be live yet`);
  }
  const minOut = (quoted * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  log(`${fn}(${fn === "burn" ? ethers.formatEther(amount) + " ETH" : ethers.formatUnits(amount, 6) + " USDG"}) quotes ${ethers.formatEther(quoted)} $CUBE, min ${ethers.formatEther(minOut)}`);
  if (!LIVE) return log("dry run: not sending. Set the repo variable KEEPER_LIVE=1 to burn.");
  const tx = await bb[fn](amount, minOut);
  log(`sent ${tx.hash}`);
  const rc = await tx.wait();
  log(`burned in block ${rc.blockNumber}; total burned ${ethers.formatEther(await bb.totalBurned())} $CUBE`);
}

main().catch((e) => {
  console.error(e.shortMessage || e.message || e);
  process.exit(1);
});
