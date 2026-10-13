const { ethers, network } = require("hardhat");

const DAY = 24 * 3600;
const TERM = 30 * DAY;
const usdg = (n) => ethers.parseUnits(String(n), 6);

/// Integer square root for BigInt.
function isqrt(n) {
  if (n < 0n) throw new Error("negative");
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x;
}

const MASKS = [
  [64n, 0x202021202030213n], [7n, 0x17n], [11n, 0x23bn], [13n, 0x161bn], [17n, 0x1a317n],
  [19n, 0x30af3n], [23n, 0x5335fn], [29n, 0x13d122f3n], [31n, 0x121d47b7n],
];
const survives = (u) => MASKS.every(([m, mask]) => ((mask >> (u % m)) & 1n) === 1n);

/// Candidates (z, d, r) for target k with zMin <= |z| < zMax that pass every arithmetic check (hash aside).
function candidates(k, zMin, zMax, limit = 50) {
  const out = [];
  const K = BigInt(k);
  for (let za = BigInt(zMin); za < BigInt(zMax) && out.length < limit; za++) {
    for (const z of [za, -za]) {
      for (let da = 1n; da <= za / 3n; da++) {
        const d = z > 0n ? -da : da;
        const m = K - z * z * z;
        if (m % d !== 0n) continue;
        const q = m / d;
        const nn = 4n * q - d * d;
        if (nn % 3n !== 0n) continue;
        const delta = nn / 3n;
        if (delta < 0n || !survives(delta)) continue;
        out.push({ z, d, r: isqrt(delta) });
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

async function deployAll({ shareFee = ethers.parseEther("0.00001"), depositFeeBps = 300, withEthFeed = true } = {}) {
  const [dev, keeper, alice, bob, carol] = await ethers.getSigners();
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const guardianUntil = now + TERM;

  // Timelock: deployed with the dev wallet as temporary admin, which hands proposer/canceller to the governor and
  // renounces before anything else is deployed.
  const timelock = await ethers.deployContract("CubeTimelock", [2 * DAY, [], [ethers.ZeroAddress], dev.address]);
  const points = await ethers.deployContract("CubePoints", [dev.address, timelock, guardianUntil]);
  const governor = await ethers.deployContract("CubeGovernor", [points, timelock, 600, 2 * DAY, 1000]);
  await timelock.grantRole(await timelock.PROPOSER_ROLE(), governor);
  await timelock.grantRole(await timelock.CANCELLER_ROLE(), governor);
  await timelock.renounceRole(await timelock.DEFAULT_ADMIN_ROLE(), dev.address);

  const usdgToken = await ethers.deployContract("MockERC20", ["Global Dollar", "USDG", 6]);
  const ethFeed = await ethers.deployContract("MockAggregator", [8, 3000n * 10n ** 8n]);
  const pm = await ethers.deployContract("MockPoolManager");
  const cube = await ethers.deployContract("MockCube");
  const HOOK = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044";
  const buyBurn = await ethers.deployContract("CubeBuyBurn", [
    { poolManager: pm, ponsHook: HOOK, poolFee: 0, tickSpacing: 200, usdg: usdgToken, usdgPoolFee: 100, usdgTickSpacing: 1 },
    timelock,
    dev.address,
    keeper.address,
    ethers.parseEther("1"),
    usdg(5000),
    3600,
    dev.address,
  ]);
  const vaults = await ethers.deployContract("CubeVaults", [
    dev.address, timelock, guardianUntil, points, 3 * DAY, usdgToken, withEthFeed ? await ethFeed.getAddress() : ethers.ZeroAddress, buyBurn, depositFeeBps,
  ]);
  const hunt = await ethers.deployContract("CubeHunt", [dev.address, timelock, guardianUntil, points, vaults, buyBurn, shareFee]);

  await points.setMinter(hunt, true);
  await points.setMinter(vaults, true);
  await points.sealMinters();
  await vaults.setHunt(hunt);

  for (const s of [alice, bob, carol]) await usdgToken.mint(s.address, usdg(100_000));

  // Act as the DAO (the timelock) directly in tests that are not about voting.
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [await timelock.getAddress()] });
  await network.provider.send("hardhat_setBalance", [await timelock.getAddress(), "0x56BC75E2D63100000"]);
  const dao = await ethers.getSigner(await timelock.getAddress());

  return { dev, keeper, alice, bob, carol, dao, timelock, points, governor, usdgToken, ethFeed, pm, cube, buyBurn, vaults, hunt, guardianUntil };
}

module.exports = { deployAll, candidates, isqrt, usdg, DAY, TERM };
