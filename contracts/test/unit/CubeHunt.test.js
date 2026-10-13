const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployAll, candidates, usdg, DAY, TERM } = require("./fixture");

const fee = ethers.parseEther("0.00001");

async function withTarget() {
  const ctx = await deployAll();
  const { vaults, hunt } = ctx;
  await vaults.createVault(0, 3, "x^3 + y^3 + z^3 = 3", "");
  await vaults.createVault(0, 114, "x^3 + y^3 + z^3 = 114", "");
  await hunt.addTarget(3, 2, 2000, await vaults.huntVaultOf(3));
  await hunt.addTarget(114, 10, 5000, await vaults.huntVaultOf(114));
  await hunt.startSeason(0, 100); // bits 0: every arithmetic survivor is a share
  return ctx;
}

describe("Guardian sunset", function () {
  it("lets the guardian set up during its term only", async function () {
    const { vaults, hunt, guardianUntil } = await loadFixture(withTarget);
    expect(await hunt.guardianActive()).to.equal(true);
    await vaults.createVault(1, 0, "A Lean statement", "ipfs://x");
    await time.increaseTo(guardianUntil);
    expect(await hunt.guardianActive()).to.equal(false);
    await expect(vaults.createVault(1, 0, "Another", "")).to.be.revertedWithCustomError(vaults, "NotGuardianOrDao");
    await expect(hunt.addTarget(390, 10, 100, 0)).to.be.revertedWithCustomError(hunt, "NotGuardianOrDao");
    await expect(hunt.pause(true)).to.be.revertedWithCustomError(hunt, "NotGuardianOrDao");
  });

  it("keeps the DAO in charge after the term", async function () {
    const { vaults, dao, guardianUntil } = await loadFixture(withTarget);
    await time.increaseTo(guardianUntil + 1);
    await expect(vaults.connect(dao).createVault(1, 0, "DAO vault", "")).to.emit(vaults, "VaultCreated");
  });

  it("refuses a guardian term over 90 days", async function () {
    const { dev, timelock } = await loadFixture(withTarget);
    const now = await time.latest();
    await expect(ethers.deployContract("CubePoints", [dev.address, timelock, now + 91 * DAY])).to.be.reverted;
  });

  it("lets the guardian start only the first season", async function () {
    const { hunt, dao } = await loadFixture(withTarget);
    await expect(hunt.startSeason(0, 1000)).to.be.revertedWithCustomError(hunt, "NotDao");
    await expect(hunt.connect(dao).startSeason(8, 50)).to.emit(hunt, "SeasonStarted");
    await expect(hunt.connect(dao).startSeason(8, 1001)).to.be.revertedWithCustomError(hunt, "BadSeason");
  });
});

describe("No fake-price votes", function () {
  it("keeps assets, feeds and points per dollar DAO-only", async function () {
    const { vaults, dev, dao, usdgToken, ethFeed } = await loadFixture(withTarget);
    await expect(vaults.setAsset(usdgToken, true, ethFeed, false)).to.be.revertedWithCustomError(vaults, "NotDao");
    await expect(vaults.setPointsPerUsd(1000)).to.be.revertedWithCustomError(vaults, "NotDao");
    await expect(vaults.connect(dao).setPointsPerUsd(1001)).to.be.revertedWithCustomError(vaults, "BadValue");
    await expect(vaults.connect(dao).setPointsPerUsd(200)).to.emit(vaults, "PointsPerUsdSet");
    void dev;
  });

  it("never lets the guardian make a wallet a minter", async function () {
    const { dev, timelock } = await loadFixture(withTarget);
    const now = await time.latest();
    const p = await ethers.deployContract("CubePoints", [dev.address, timelock, now + DAY]);
    await expect(p.setMinter(dev.address, true)).to.be.revertedWithCustomError(p, "NotAContract");
  });

  it("points are soulbound", async function () {
    const { points, alice, bob } = await loadFixture(withTarget);
    await expect(points.connect(alice).transfer(bob.address, 1)).to.be.reverted;
  });
});

describe("Deposits", function () {
  it("sends the USDG fee to BuyBurn and counts points on the rest", async function () {
    const { vaults, alice, usdgToken, buyBurn, points } = await loadFixture(withTarget);
    const id = await vaults.huntVaultOf(114);
    await usdgToken.connect(alice).approve(vaults, usdg(100));
    await vaults.connect(alice).deposit(id, usdgToken, usdg(100));
    expect(await usdgToken.balanceOf(buyBurn)).to.equal(usdg(3));
    expect(await usdgToken.balanceOf(vaults)).to.equal(usdg(97));
    expect(await points.balanceOf(alice)).to.equal(9700n);
  });

  it("sends the ETH fee to BuyBurn and prices ETH by its Chainlink feed", async function () {
    const { vaults, alice, buyBurn, points } = await loadFixture(withTarget);
    const id = await vaults.huntVaultOf(114);
    const before = await ethers.provider.getBalance(buyBurn);
    await vaults.connect(alice).depositETH(id, { value: ethers.parseEther("1") });
    expect((await ethers.provider.getBalance(buyBurn)) - before).to.equal(ethers.parseEther("0.03"));
    expect(await points.balanceOf(alice)).to.equal(291000n); // 0.97 ETH x $3000 x 100
  });

  it("gives no points for ETH when no feed was fixed at deploy", async function () {
    const ctx = await deployAll({ withEthFeed: false });
    await ctx.vaults.createVault(0, 114, "114", "");
    await ctx.vaults.connect(ctx.alice).depositETH(1, { value: ethers.parseEther("1") });
    expect(await ctx.points.balanceOf(ctx.alice)).to.equal(0n);
  });

  it("caps the deposit fee at 10% and keeps it DAO-only", async function () {
    const { vaults, dao } = await loadFixture(withTarget);
    await expect(vaults.setDepositFeeBps(0)).to.be.revertedWithCustomError(vaults, "NotDao");
    await expect(vaults.connect(dao).setDepositFeeBps(1001)).to.be.revertedWithCustomError(vaults, "BadValue");
    await vaults.connect(dao).setDepositFeeBps(0);
    expect(await vaults.depositFeeBps()).to.equal(0n);
  });
});

describe("Mining", function () {
  it("charges the share fee per accepted share, refunds the rest, and pays it to BuyBurn", async function () {
    const { hunt, alice, buyBurn, points } = await loadFixture(withTarget);
    const c = candidates(114, 10, 5000, 3);
    expect(c.length).to.equal(3);
    for (const x of c) expect((await hunt.checkShare(114, x.z, x.d, x.r, alice.address)).reason).to.equal(0);
    const bbBefore = await ethers.provider.getBalance(buyBurn);
    await expect(hunt.connect(alice).submitShares(114, c.map((x) => x.z), c.map((x) => x.d), c.map((x) => x.r), { value: fee * 3n - 1n }))
      .to.be.revertedWithCustomError(hunt, "FeeTooLow");
    const tx = hunt.connect(alice).submitShares(114, c.map((x) => x.z), c.map((x) => x.d), c.map((x) => x.r), { value: fee * 10n });
    await expect(tx).to.changeEtherBalance(alice, -(fee * 3n), { includeFee: false });
    expect((await ethers.provider.getBalance(buyBurn)) - bbBefore).to.equal(fee * 3n);
    expect(await points.balanceOf(alice)).to.equal(300n);
    expect(await hunt.totalFees()).to.equal(fee * 3n);
  });

  it("skips duplicates for free", async function () {
    const { hunt, alice, bob } = await loadFixture(withTarget);
    const [a, b] = candidates(114, 10, 5000, 2);
    await hunt.connect(alice).submitShares(114, [a.z], [a.d], [a.r], { value: fee });
    await expect(hunt.connect(bob).submitShares(114, [a.z, b.z], [a.d, b.d], [a.r, b.r], { value: fee }))
      .to.emit(hunt, "SharesSubmitted").withArgs(bob.address, 114, 1, 1, 1, 100);
  });

  it("keeps the share fee DAO-only and capped", async function () {
    const { hunt, dao } = await loadFixture(withTarget);
    await expect(hunt.setShareFee(0)).to.be.revertedWithCustomError(hunt, "NotDao");
    await expect(hunt.connect(dao).setShareFee(ethers.parseEther("0.0002"))).to.be.revertedWithCustomError(hunt, "BadFee");
  });

  it("pays the jackpot for a chain-verified solution (3 = 1 + 1 + 1)", async function () {
    const { hunt, vaults, alice, bob, usdgToken, points } = await loadFixture(withTarget);
    const id = await vaults.huntVaultOf(3);
    await usdgToken.connect(alice).approve(vaults, usdg(1000));
    await vaults.connect(alice).deposit(id, usdgToken, usdg(1000));
    const salt = ethers.id("salt");
    await hunt.connect(bob).commitSolution(await hunt.solutionCommitment(3, 1, 1, 1, bob.address, salt));
    await expect(hunt.connect(bob).revealSolution(3, 1, 1, 1, salt)).to.be.revertedWithCustomError(hunt, "CommitTooNew");
    await time.increase(61);
    await expect(hunt.connect(bob).revealSolution(3, 1, 1, 1, salt)).to.emit(hunt, "Solved");
    expect(await usdgToken.balanceOf(bob)).to.equal(usdg(100_000) + usdg(970));
    expect(await points.balanceOf(bob)).to.equal(1_000_000n);
  });

  it("rejects a wrong solution", async function () {
    const { hunt, bob } = await loadFixture(withTarget);
    const salt = ethers.id("s");
    await hunt.connect(bob).commitSolution(await hunt.solutionCommitment(114, 1, 2, 3, bob.address, salt));
    await time.increase(61);
    await expect(hunt.connect(bob).revealSolution(114, 1, 2, 3, salt)).to.be.revertedWithCustomError(hunt, "NotASolution");
  });
});

describe("CubeBuyBurn", function () {
  async function withToken() {
    const ctx = await withTarget();
    await ctx.buyBurn.connect(ctx.dao).setToken(ctx.cube);
    await ctx.cube.mint(ctx.pm, ethers.parseEther("1000000000"));
    await ctx.pm.setRate(await ctx.cube.getAddress(), 1_000_000n * 1000n); // 1 ETH -> 1,000,000 CUBE
    await ctx.pm.setRate(ethers.ZeroAddress, 1n); // 1 USDG unit -> 0.001 wei... set below per test
    return ctx;
  }

  it("refuses an admin that is not a 48h timelock", async function () {
    const { dev, keeper, pm, usdgToken } = await loadFixture(withTarget);
    const cfg = { poolManager: pm, ponsHook: dev.address, poolFee: 0, tickSpacing: 200, usdg: usdgToken, usdgPoolFee: 100, usdgTickSpacing: 1 };
    await expect(ethers.deployContract("CubeBuyBurn", [cfg, dev.address, dev.address, keeper.address, 1n, 1n, 3600, dev.address]))
      .to.be.revertedWithCustomError(await ethers.getContractFactory("CubeBuyBurn"), "AdminNotTimelock");
  });

  it("sets $CUBE once: by the token setter (dev wallet) or the timelock, never again", async function () {
    const { buyBurn, cube, alice, dev, dao } = await loadFixture(withTarget);
    await expect(buyBurn.connect(alice).setToken(cube)).to.be.revertedWithCustomError(buyBurn, "Unauthorized");
    await buyBurn.connect(dev).setToken(cube);
    await expect(buyBurn.connect(dev).setToken(cube)).to.be.revertedWithCustomError(buyBurn, "TokenAlreadySet");
    await expect(buyBurn.connect(dao).setToken(cube)).to.be.revertedWithCustomError(buyBurn, "TokenAlreadySet");
  });

  it("buys and burns $CUBE with ETH fees", async function () {
    const ctx = await loadFixture(withToken);
    await ctx.alice.sendTransaction({ to: ctx.buyBurn, value: ethers.parseEther("0.5") });
    const supply = await ctx.cube.totalSupply();
    await expect(ctx.buyBurn.connect(ctx.alice).burn(ethers.parseEther("0.1"), 0)).to.be.reverted;
    await ctx.buyBurn.connect(ctx.keeper).burn(ethers.parseEther("0.1"), ethers.parseEther("100000"));
    expect(supply - (await ctx.cube.totalSupply())).to.equal(ethers.parseEther("100000"));
    expect(await ctx.pm.settledNative()).to.equal(ethers.parseEther("0.1"));
    await expect(ctx.buyBurn.connect(ctx.keeper).burn(ethers.parseEther("0.1"), 0)).to.be.revertedWithCustomError(ctx.buyBurn, "TooSoon");
  });

  it("buys and burns $CUBE with USDG fees through ETH", async function () {
    const ctx = await loadFixture(withToken);
    // 1 USDG (1e6 units) -> 0.0003 ETH (3e14 wei): rate x1000 per unit = 3e8 * 1000 / 1e6... use 300_000_000_000
    await ctx.pm.setRate(ethers.ZeroAddress, 300_000_000n * 1000n);
    await ctx.alice.sendTransaction({ to: ctx.pm, value: ethers.parseEther("10") });
    await ctx.usdgToken.connect(ctx.alice).transfer(ctx.buyBurn, usdg(100));
    const supply = await ctx.cube.totalSupply();
    await ctx.buyBurn.connect(ctx.keeper).burnUsdg(usdg(100), 1n);
    // 100 USDG -> 0.03 ETH -> 30,000 CUBE
    expect(supply - (await ctx.cube.totalSupply())).to.equal(ethers.parseEther("30000"));
    expect(await ctx.usdgToken.balanceOf(ctx.buyBurn)).to.equal(0n);
    expect(await ctx.pm.settledErc20()).to.equal(usdg(100));
  });

  it("lets the guardian halt and only the DAO resume", async function () {
    const ctx = await loadFixture(withToken);
    await ctx.buyBurn.connect(ctx.dev).halt();
    await expect(ctx.buyBurn.connect(ctx.dev).resume()).to.be.reverted;
    await ctx.buyBurn.connect(ctx.dao).resume();
  });
});

describe("DAO", function () {
  it("runs a full vote: propose, vote, queue 48h, execute", async function () {
    const { vaults, hunt, governor, timelock, alice, usdgToken } = await loadFixture(withTarget);
    const id = await vaults.huntVaultOf(114);
    await usdgToken.connect(alice).approve(vaults, usdg(50));
    await vaults.connect(alice).deposit(id, usdgToken, usdg(50)); // 4,850 PTS
    await time.increase(1);
    const data = hunt.interface.encodeFunctionData("setShareFee", [0n]);
    const desc = "Make mining free";
    await governor.connect(alice).propose([hunt], [0], [data], desc);
    const pid = await governor.hashProposal([hunt], [0], [data], ethers.id(desc));
    await time.increase(601);
    await governor.connect(alice).castVote(pid, 1);
    await time.increase(2 * DAY + 1);
    await governor.queue([hunt], [0], [data], ethers.id(desc));
    await expect(governor.execute([hunt], [0], [data], ethers.id(desc))).to.be.reverted;
    await time.increase(2 * DAY + 1);
    await governor.execute([hunt], [0], [data], ethers.id(desc));
    expect(await hunt.shareFee()).to.equal(0n);
    expect(await timelock.getMinDelay()).to.equal(BigInt(2 * DAY));
  });

  it("gives the dev wallet no timelock role at all", async function () {
    const { timelock, dev, governor } = await loadFixture(withTarget);
    for (const r of ["DEFAULT_ADMIN_ROLE", "PROPOSER_ROLE", "EXECUTOR_ROLE", "CANCELLER_ROLE"]) {
      expect(await timelock.hasRole(await timelock[r](), dev.address)).to.equal(false);
    }
    expect(await timelock.hasRole(await timelock.CANCELLER_ROLE(), governor)).to.equal(true);
    expect(await timelock.hasRole(await timelock.EXECUTOR_ROLE(), ethers.ZeroAddress)).to.equal(true);
  });
});

void TERM;
