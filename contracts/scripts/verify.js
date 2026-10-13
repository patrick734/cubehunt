// Publishes the source of every deployed CubeHunt contract on Sourcify (sourcify.dev), which the Robinhood Chain
// explorer reads, so each contract shows its CubeHunt name and readable code. Then checks on chain that the dev wallet
// holds no DAO power. Read-only: no wallet, no key, no gas. Safe to run again.
//   npx hardhat run scripts/verify.js --network robinhood        (or ../verify.sh)
// Anything Sourcify cannot take gets a browser upload file in ../verify-files/.
const fs = require("fs");
const os = require("os");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

const SOURCIFY = (process.env.VERIFY_SOURCIFY_URL || "https://sourcify.dev/server").replace(/\/$/, "");
const FILE = process.env.VERIFY_DEPLOYMENT || path.join(__dirname, "..", "deployments", "robinhood.json");
const MANUAL = path.join(__dirname, "..", "..", "verify-files");
const SOLC = "0.8.28+commit.7893614a";
const CHAIN = 4663;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sjson(res) {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return { _raw: t.slice(0, 120) };
  }
}

async function match(address) {
  const res = await fetch(`${SOURCIFY}/v2/contract/${CHAIN}/${address}`, { headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  const j = await sjson(res);
  return res.ok ? j.match || null : null;
}

async function submit(c) {
  const res = await fetch(`${SOURCIFY}/v2/verify/${CHAIN}/${c.address}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ stdJsonInput: c.input, compilerVersion: SOLC, contractIdentifier: c.fqn }),
  });
  const j = await sjson(res);
  if (res.status === 409 || j.customCode === "already_verified") return "already verified";
  if (!res.ok || !j.verificationId) throw new Error(j.message || j._raw || `Sourcify ${res.status}`);
  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    const s = await sjson(await fetch(`${SOURCIFY}/v2/verify/${j.verificationId}`, { headers: { accept: "application/json" } }));
    if (!s.isJobCompleted) continue;
    if (s.error) throw new Error(s.error.message || s.error.customCode || "verification failed");
    const m = s.contract && (s.contract.match || s.contract.runtimeMatch || s.contract.creationMatch);
    if (m) return m === "exact_match" ? "verified (exact match)" : "verified";
    throw new Error("no match");
  }
  throw new Error("still in Sourcify's queue; run again in a few minutes");
}

async function input(name) {
  const a = await hre.artifacts.readArtifact(name);
  const fqn = `${a.sourceName}:${a.contractName}`;
  const bi = await hre.artifacts.getBuildInfo(fqn);
  const meta = JSON.parse(bi.output.contracts[a.sourceName][a.contractName].metadata);
  const sources = Object.fromEntries(Object.keys(meta.sources).map((k) => [k, bi.input.sources[k]]));
  return { fqn, input: { language: "Solidity", sources, settings: bi.input.settings } };
}

async function powerCheck(d) {
  const p = ethers.provider;
  const tl = new ethers.Contract(d.timelock, ["function hasRole(bytes32,address) view returns (bool)", "function getMinDelay() view returns (uint256)"], p);
  const roles = { admin: ethers.ZeroHash, proposer: ethers.id("PROPOSER_ROLE"), executor: ethers.id("EXECUTOR_ROLE"), canceller: ethers.id("CANCELLER_ROLE") };
  let bad = 0;
  const line = (good, msg) => {
    if (!good) bad++;
    console.log(`  ${good ? "ok  " : "FAIL"}  ${msg}`);
  };
  line((await tl.getMinDelay()) >= 172800n, `timelock delay ${(await tl.getMinDelay()) / 3600n} hours`);
  for (const [n, r] of Object.entries(roles)) line(!(await tl.hasRole(r, d.deployer)), `dev wallet is not timelock ${n}`);
  line(await tl.hasRole(roles.proposer, d.governor), "only the governor proposes (DAO votes)");
  line(await tl.hasRole(roles.executor, ethers.ZeroAddress), "anyone may execute a passed vote after the delay");
  const bb = new ethers.Contract(d.buyBurn, ["function hasRole(bytes32,address) view returns (bool)"], p);
  line(await bb.hasRole(ethers.ZeroHash, d.timelock), "BuyBurn admin is the timelock");
  line(!(await bb.hasRole(ethers.ZeroHash, d.deployer)), "dev wallet is not BuyBurn admin");
  const pts = new ethers.Contract(d.points, ["function mintersSealed() view returns (bool)", "function guardianUntil() view returns (uint64)"], p);
  line(await pts.mintersSealed(), "points minters sealed (only Hunt and Vaults mint)");
  console.log(`  info  guardian powers end ${new Date(Number(await pts.guardianUntil()) * 1000).toISOString()}`);
  return bad;
}

async function main() {
  if (!fs.existsSync(FILE)) throw new Error(`No deployment at ${FILE}`);
  const d = JSON.parse(fs.readFileSync(FILE, "utf8"));
  console.log(`${d.sources.length} contracts.\n\nSourcify`);
  const failed = [];
  for (const s of d.sources) {
    if (s.contract.startsWith("Mock")) continue;
    process.stdout.write(`  ${s.contract.padEnd(14)} ${s.address}  `);
    const c = { address: s.address, ...(await input(s.contract)) };
    const home = os.homedir();
    if (home.length > 3 && JSON.stringify(c.input).includes(home)) throw new Error(`compiler input for ${s.contract} contains a local path`);
    try {
      const m = await match(s.address);
      console.log(m ? `already verified (${m})` : await submit(c));
    } catch (e) {
      console.log(`not verified: ${String(e.message).split("\n")[0].slice(0, 140)}`);
      failed.push(c);
    }
  }
  fs.rmSync(MANUAL, { recursive: true, force: true });
  if (failed.length) {
    fs.mkdirSync(MANUAL, { recursive: true });
    const lines = ["Verify each contract in the browser: open the link, tab Contract, 'Verify & publish',", "Solidity (Standard JSON input), compiler v" + SOLC + ", upload the file.", ""];
    failed.forEach((c, i) => {
      const f = `${String(i + 1).padStart(2, "0")}-${c.fqn.split(":")[1]}.json`;
      fs.writeFileSync(path.join(MANUAL, f), JSON.stringify(c.input));
      lines.push(`${c.fqn.split(":")[1]}  https://robinhoodchain.blockscout.com/address/${c.address}?tab=contract  file: ${f}`);
    });
    fs.writeFileSync(path.join(MANUAL, "README.txt"), lines.join("\n") + "\n");
  }
  console.log("\nWho holds power");
  const bad = await powerCheck(d);
  console.log(`\n${failed.length ? `${failed.length} not verified yet (browser files in verify-files/). ` : "All sources published. "}${bad ? `${bad} power check(s) FAILED.` : "Power checks passed."}`);
  if (failed.length || bad) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
