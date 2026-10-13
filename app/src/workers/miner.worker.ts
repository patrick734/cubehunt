/// <reference lib="webworker" />
// One mining thread. Runs the engine in short bursts, checks each survivor's share hash for this miner and season,
// and posts shares (and, if it ever happens, a solution) back to the page.
import { encodeAbiParameters, keccak256, toHex } from "viem";
import { primes2mod3, search, meets } from "../lib/engine.mjs";

type Job = {
  k: number;
  zMin: string;
  zMax: string;
  hunt: `0x${string}`;
  chainId: number;
  miner: `0x${string}`;
  season: number;
  bits: number;
  seed: number;
};

const TAG = keccak256(toHex("CUBEHUNT_SHARE_V1"));
const PARAMS = [
  { type: "bytes32" },
  { type: "uint256" },
  { type: "address" },
  { type: "uint16" },
  { type: "int256" },
  { type: "int256" },
  { type: "uint256" },
  { type: "address" },
  { type: "uint32" },
] as const;

let job: Job | null = null;
let running = false;

// A per-thread prime set, so threads explore different residue classes.
let primes: bigint[] = [];

function shareHash(j: Job, z: bigint, d: bigint, r: bigint) {
  return keccak256(encodeAbiParameters(PARAMS, [TAG, BigInt(j.chainId), j.hunt, j.k, z, d, r, j.miner, j.season]));
}

function loop() {
  if (!running || !job) return;
  const j = job;
  const t0 = performance.now();
  let tried = 0;
  let survivors = 0;
  const shares: { z: string; d: string; r: string }[] = [];
  while (performance.now() - t0 < 250) {
    const res = search({ k: j.k, zMin: BigInt(j.zMin), zMax: BigInt(j.zMax), primes, tries: 2000 });
    tried += res.tried;
    survivors += res.found.length;
    for (const c of res.found) {
      if (c.solution) {
        postMessage({ type: "solution", k: j.k, z: c.z.toString(), d: c.d.toString(), r: c.r.toString() });
      }
      if (meets(shareHash(j, c.z, c.d, c.r), j.bits)) shares.push({ z: c.z.toString(), d: c.d.toString(), r: c.r.toString() });
    }
  }
  postMessage({ type: "progress", tried, survivors, shares, ms: performance.now() - t0 });
  setTimeout(loop, 0);
}

self.onmessage = (e: MessageEvent) => {
  const m = e.data as { type: "start"; job: Job } | { type: "stop" };
  if (m.type === "start") {
    job = m.job;
    primes = primes2mod3(1_000_003 + (m.job.seed % 64) * 50_000, 128);
    if (!running) {
      running = true;
      loop();
    }
  } else {
    running = false;
  }
};
