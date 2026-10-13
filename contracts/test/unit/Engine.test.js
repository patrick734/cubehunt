// The browser miner (app/src/lib/engine.mjs) must agree with CubeHunt.sol on every candidate.
const { expect } = require("chai");
const path = require("path");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployAll } = require("./fixture");

const ZMIN = 10n ** 20n;
const ZMAX = 10n ** 21n;

async function live() {
  const ctx = await deployAll();
  await ctx.vaults.createVault(0, 114, "114", "");
  await ctx.hunt.addTarget(114, ZMIN, ZMAX, await ctx.vaults.huntVaultOf(114));
  await ctx.hunt.startSeason(0, 100);
  return ctx;
}

describe("Browser mining engine", function () {
  let E;
  before(async () => {
    E = await import(path.join(__dirname, "..", "..", "..", "app", "src", "lib", "engine.mjs"));
  });

  it("finds survivors in the real band that the contract accepts as shares, and submits them", async function () {
    const { hunt, alice, points } = await loadFixture(live);
    const primes = E.primes2mod3(1_000_003, 64);
    let a = 7; // mulberry32
    const rnd = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const { tried, found } = E.search({ k: 114, zMin: ZMIN, zMax: ZMAX, primes, tries: 20000, rnd });
    expect(tried).to.be.gt(19000);
    expect(found.length).to.be.gt(0);
    const batch = found.slice(0, 10);
    for (const c of batch) {
      expect(E.evaluate(114, c.z, c.d, c.r, ZMIN, ZMAX).reason).to.equal(0);
      const res = await hunt.checkShare(114, c.z, c.d, c.r, alice.address);
      expect(res.reason).to.equal(0);
      expect(res.solution).to.equal(c.solution);
    }
    await hunt.connect(alice).submitShares(114, batch.map((c) => c.z), batch.map((c) => c.d), batch.map((c) => c.r), {
      value: ethers.parseEther("0.00001") * BigInt(batch.length),
    });
    expect(await points.balanceOf(alice)).to.equal(100n * BigInt(batch.length));
    console.log(`      ${tried} candidates -> ${found.length} survivors`);
  });

  it("agrees with the contract on rejects too", async function () {
    const { hunt, alice } = await loadFixture(live);
    const cases = [
      [ZMIN + 5n, -7n, 1n],
      [ZMIN + 5n, 7n, 1n],
      [ZMIN - 1n, -5n, 1n],
      [ZMAX + 1n, -5n, 1n],
    ];
    for (const [z, d, r] of cases) {
      const js = E.evaluate(114, z, d, r, ZMIN, ZMAX).reason;
      const sol = (await hunt.checkShare(114, z, d, r, alice.address)).reason;
      expect(js).to.equal(Number(sol));
    }
  });

  it("computes the same share hash test", async function () {
    const { hunt, alice } = await loadFixture(live);
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const z = ZMIN + 123n, d = -11n, r = 5n;
    const mine = ethers.keccak256(coder.encode(
      ["bytes32", "uint256", "address", "uint16", "int256", "int256", "uint256", "address", "uint32"],
      [ethers.id("CUBEHUNT_SHARE_V1"), 31337, await hunt.getAddress(), 114, z, d, r, alice.address, 1],
    ));
    expect(mine).to.equal(await hunt.shareHash(114, z, d, r, alice.address, 1));
    expect(E.meets("0x00ff" + "0".repeat(60), 8)).to.equal(true);
    expect(E.meets("0x01ff" + "0".repeat(60), 8)).to.equal(false);
  });
});
