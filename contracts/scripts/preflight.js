// Read-only checks before a deploy. Exit code 1 on any FAIL.
//   DEPLOYER_ADDRESS=0x... KEEPER_ADDRESS=0x... node scripts/preflight.js
const { ethers } = require("ethers");
const cfg = require("../config/robinhood.json");

const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const MIN = ethers.parseEther(process.env.MIN_DEPLOYER_ETH ?? "0.005");
let failed = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const warn = (m) => console.log(`  warn  ${m}`);
const fail = (m) => {
  failed++;
  console.log(`  FAIL  ${m}`);
};

(async () => {
  const p = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: false });
  console.log("Network");
  const id = Number((await p.getNetwork()).chainId);
  id === cfg.network.chainId ? ok(`chainId ${id} (Robinhood Chain)`) : fail(`chainId ${id}, expected ${cfg.network.chainId}`);

  console.log("Wallets");
  const dev = process.env.DEPLOYER_ADDRESS;
  const keeper = process.env.KEEPER_ADDRESS;
  if (!dev || !ethers.isAddress(dev)) fail("DEPLOYER_ADDRESS missing");
  else {
    const bal = await p.getBalance(dev);
    const msg = `dev wallet ${dev} holds ${ethers.formatEther(bal)} ETH`;
    bal >= MIN ? ok(msg) : fail(`${msg}, needs at least ${ethers.formatEther(MIN)} (set MIN_DEPLOYER_ETH to change)`);
  }
  if (!keeper || !ethers.isAddress(keeper)) fail("KEEPER_ADDRESS missing (node tools/wallet.js keeper-secret)");
  else if (dev && keeper.toLowerCase() === dev.toLowerCase()) fail("the keeper must be a different wallet from the dev wallet");
  else {
    const kb = await p.getBalance(keeper);
    kb > 0n ? ok(`keeper ${keeper} holds ${ethers.formatEther(kb)} ETH`) : warn(`keeper ${keeper} has no ETH yet (fund 0.01 before KEEPER_LIVE=1)`);
  }

  console.log("Contracts this deploy relies on");
  for (const [name, a] of [["Uniswap v4 PoolManager", cfg.uniswap.poolManager], ["USDG", cfg.tokens.usdg], ["Pons hook", cfg.pons.hook]]) {
    (await p.getCode(a)) !== "0x" ? ok(`${name} ${a}`) : fail(`${name} ${a} has no code`);
  }
  const feed = process.env.ETH_USD_FEED || cfg.chainlink.ethUsdFeed;
  if (!feed) warn("no ETH/USD Chainlink feed: ETH deposits earn no points (USDG deposits do). A DAO vote can add one later.");
  else {
    try {
      const f = new ethers.Contract(feed, ["function decimals() view returns (uint8)", "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"], p);
      const [, answer, , updatedAt] = await f.latestRoundData();
      const age = Math.floor(Date.now() / 1000) - Number(updatedAt);
      answer > 0n && age < 4 * 86400 ? ok(`ETH/USD feed ${feed}: ${Number(answer) / 10 ** Number(await f.decimals())} USD, ${age}s old`) : fail(`ETH/USD feed ${feed} is stale or negative`);
    } catch (e) {
      fail(`ETH/USD feed ${feed}: ${e.shortMessage || e.message}`);
    }
  }
  console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exit(1);
});
