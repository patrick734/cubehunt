// Deploys CubeHunt.
//   Local demo (mocks):      npx hardhat run scripts/deploy.js
//   Rehearsal (fork):        FORK=1 DEPLOY_LIVE=1 npx hardhat run scripts/deploy.js
//   Robinhood Chain:         node ../tools/with-key.js <wallet> -- npx hardhat run scripts/deploy.js --network robinhood
// The dev wallet deploys and is the guardian for a fixed term (setup only; powers end on their own). It never holds
// a role in the 48h DAO timelock. KEEPER_ADDRESS (a separate bot wallet) may only run the capped buy-and-burn.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const cfg = require("../config/robinhood.json");

const LIVE = network.name === "robinhood" || process.env.DEPLOY_LIVE === "1";
const DAY = 86400;
const SOURCES = [];

async function plain(v) {
  if (v && typeof v.getAddress === "function") return v.getAddress();
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return Promise.all(v.map(plain));
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = await plain(x);
    return o;
  }
  return v;
}

async function deploy(name, args = []) {
  const c = await ethers.deployContract(name, args);
  await c.waitForDeployment();
  const address = await c.getAddress();
  console.log(`  ${name.padEnd(16)} ${address}`);
  SOURCES.push({ contract: name, address, args: await plain(args) });
  return c;
}

async function send(label, txp) {
  const tx = await txp;
  await tx.wait();
  console.log(`  ${label}`);
}

async function main() {
  const [deployer, , , keeperLocal] = await ethers.getSigners();
  const keeper = process.env.KEEPER_ADDRESS || (LIVE ? null : keeperLocal.address);
  if (!keeper || !ethers.isAddress(keeper)) throw new Error("KEEPER_ADDRESS must be set to the keeper bot's address");
  if (keeper.toLowerCase() === deployer.address.toLowerCase()) throw new Error("The keeper must be a different wallet from the dev wallet");

  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const g = cfg.governance;
  const guardianUntil = now + g.guardianTermDays * DAY;
  console.log(`Deploying CubeHunt to ${network.name} from ${deployer.address}`);
  console.log(`Guardian (setup only) until ${new Date(guardianUntil * 1000).toISOString()}`);

  const env = LIVE ? liveEnv() : await localEnv();
  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    guardian: deployer.address,
    guardianUntil,
    keeper,
    usdg: env.usdg,
    cube: null,
  };

  // 1. DAO: timelock with the dev wallet as temporary admin, points, governor; then the dev wallet gives the
  //    timelock's proposer and canceller roles to the governor and renounces its admin role for good.
  const timelock = await deploy("CubeTimelock", [g.timelockDelaySeconds, [], [ethers.ZeroAddress], deployer.address]);
  const points = await deploy("CubePoints", [deployer.address, timelock, guardianUntil]);
  const governor = await deploy("CubeGovernor", [points, timelock, g.votingDelaySeconds, g.votingPeriodSeconds, g.proposalThreshold]);
  await send("governor is the timelock's proposer", timelock.grantRole(await timelock.PROPOSER_ROLE(), governor));
  await send("governor is the timelock's canceller", timelock.grantRole(await timelock.CANCELLER_ROLE(), governor));
  await send("dev wallet renounced the timelock admin role", timelock.renounceRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer.address));

  // 2. Money: BuyBurn (admin = timelock), Vaults, Hunt.
  const bb = cfg.buyBurn;
  const buyBurn = await deploy("CubeBuyBurn", [
    {
      poolManager: env.poolManager,
      ponsHook: cfg.pons.hook,
      poolFee: cfg.pons.poolFee,
      tickSpacing: cfg.pons.poolTickSpacing,
      usdg: env.usdg,
      usdgPoolFee: cfg.uniswap.ethUsdgPool.fee,
      usdgTickSpacing: cfg.uniswap.ethUsdgPool.tickSpacing,
    },
    timelock,
    deployer.address,
    keeper,
    ethers.parseEther(bb.maxEthPerRun),
    ethers.parseUnits(String(bb.maxUsdgPerRun), 6),
    bb.minIntervalSeconds,
    deployer.address,
  ]);
  const vaults = await deploy("CubeVaults", [
    deployer.address,
    timelock,
    guardianUntil,
    points,
    cfg.vaults.proofReviewWindowSeconds,
    env.usdg,
    env.ethUsdFeed,
    buyBurn,
    cfg.fees.depositFeeBps,
  ]);
  const hunt = await deploy("CubeHunt", [
    deployer.address,
    timelock,
    guardianUntil,
    points,
    vaults,
    buyBurn,
    ethers.parseEther(cfg.fees.shareFeeEth),
  ]);

  // 3. Wiring and launch setup (guardian powers, all of them time-limited).
  await send("Hunt may mint points", points.setMinter(hunt, true));
  await send("Vaults may mint points", points.setMinter(vaults, true));
  await send("minters sealed: from now on only a DAO vote can change them", points.sealMinters());
  await send("Vaults pay out only through this Hunt", vaults.setHunt(hunt));
  const h = cfg.hunt;
  const targets = {};
  for (const k of h.targets) {
    const tx = await vaults.createVault(0, k, `x^3 + y^3 + z^3 = ${k}`, "https://en.wikipedia.org/wiki/Sums_of_three_cubes");
    await tx.wait();
    const vid = await vaults.huntVaultOf(k);
    await send(`target k = ${k}, prize vault ${vid}`, hunt.addTarget(k, h.zMin, h.zMax, vid));
    targets[k] = Number(vid);
  }
  // Local runs may lower the difficulty (FIRST_SEASON_BITS) so tests find shares quickly; live deploys use the config.
  const bits = !LIVE && process.env.FIRST_SEASON_BITS ? Number(process.env.FIRST_SEASON_BITS) : h.firstSeason.bits;
  await send(`season 1: difficulty ${bits} bits, ${h.firstSeason.pointsPerShare} points per share`, hunt.startSeason(bits, h.firstSeason.pointsPerShare));

  Object.assign(out, {
    timelock: await timelock.getAddress(),
    points: await points.getAddress(),
    governor: await governor.getAddress(),
    buyBurn: await buyBurn.getAddress(),
    vaults: await vaults.getAddress(),
    hunt: await hunt.getAddress(),
    targets,
    deployBlock: (await ethers.provider.getBlock("latest")).number,
    sources: SOURCES,
  });
  await check(out, { timelock, points, buyBurn, vaults, hunt, governor, deployer });

  const label = network.name === "robinhood" ? "robinhood" : LIVE ? "fork" : network.name;
  const file = path.join(__dirname, "..", "deployments", `${label}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`\nWrote ${path.relative(process.cwd(), file)}`);
}

/// Fails the deploy if the dev wallet kept any DAO power.
async function check(out, c) {
  const tl = c.timelock;
  const me = c.deployer.address;
  for (const r of ["DEFAULT_ADMIN_ROLE", "PROPOSER_ROLE", "EXECUTOR_ROLE", "CANCELLER_ROLE"]) {
    if (await tl.hasRole(await tl[r](), me)) throw new Error(`dev wallet still holds ${r} on the timelock`);
  }
  if (!(await tl.hasRole(await tl.PROPOSER_ROLE(), c.governor))) throw new Error("governor is not the proposer");
  if (await c.buyBurn.hasRole(await c.buyBurn.DEFAULT_ADMIN_ROLE(), me)) throw new Error("dev wallet is BuyBurn admin");
  if (!(await c.points.mintersSealed())) throw new Error("minters not sealed");
  console.log("  checked: the dev wallet holds no DAO role; minters sealed; admin of BuyBurn is the timelock");
}

function liveEnv() {
  return {
    poolManager: cfg.uniswap.poolManager,
    usdg: cfg.tokens.usdg,
    ethUsdFeed: process.env.ETH_USD_FEED || cfg.chainlink.ethUsdFeed || ethers.ZeroAddress,
  };
}

async function localEnv() {
  const usdg = await deploy("MockERC20", ["Global Dollar", "USDG", 6]);
  const pm = await deploy("MockPoolManager");
  const feed = await deploy("MockAggregator", [8, 3000n * 10n ** 8n]);
  return { poolManager: await pm.getAddress(), usdg: await usdg.getAddress(), ethUsdFeed: await feed.getAddress() };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
