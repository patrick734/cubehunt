"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { huntAbi } from "@/generated/abis";
import { useDeployment } from "@/lib/deployment";

export type Share = { z: string; d: string; r: string };
export type Found = { k: number; z: string; d: string; r: string };
type Job = { k: number; zMin: bigint; zMax: bigint; season: number; bits: number };

const MAX_BATCH = 256;
const key = (hunt: string, season: number, k: number, miner: string) => `cubehunt:shares:${hunt}:${season}:${k}:${miner}`.toLowerCase();
const solKey = (hunt: string) => `cubehunt:solution:${hunt}`.toLowerCase();

function load<T>(k: string, fallback: T): T {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(k: string, v: unknown) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
}

/** Browser mining: worker threads, the shares they find (kept on this device until submitted), and submission. */
export function useMiner() {
  const { deployment: d, chainId } = useDeployment();
  const { address } = useAccount();
  const workers = useRef<Worker[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [running, setRunning] = useState(false);
  const [threads, setThreads] = useState(2);
  const [rate, setRate] = useState(0);
  const [tried, setTried] = useState(0);
  const [survivors, setSurvivors] = useState(0);
  const [pending, setPending] = useState<Share[]>([]);
  const [solution, setSolution] = useState<Found | null>(null);
  const counters = useRef({ tried: 0, since: 0, window: 0 });

  useEffect(() => {
    setThreads(Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)));
    if (d) setSolution(load<Found | null>(solKey(d.hunt), null));
  }, [d]);

  useEffect(() => {
    if (d && job && address) setPending(load<Share[]>(key(d.hunt, job.season, job.k, address), []));
  }, [d, job, address]);

  const stop = useCallback(() => {
    for (const w of workers.current) {
      w.postMessage({ type: "stop" });
      w.terminate();
    }
    workers.current = [];
    setRunning(false);
    setRate(0);
  }, []);

  useEffect(() => stop, [stop]);

  const start = useCallback(
    (j: Job) => {
      if (!d || !address) return;
      stop();
      setJob(j);
      setRunning(true);
      counters.current = { tried: 0, since: performance.now(), window: 0 };
      const storeKey = key(d.hunt, j.season, j.k, address);
      for (let i = 0; i < threads; i++) {
        const w = new Worker(new URL("../workers/miner.worker.ts", import.meta.url), { type: "module" });
        w.onmessage = (e: MessageEvent) => {
          const m = e.data;
          if (m.type === "progress") {
            counters.current.tried += m.tried;
            counters.current.window += m.tried;
            setTried((t) => t + m.tried);
            setSurvivors((s) => s + m.survivors);
            const now = performance.now();
            if (now - counters.current.since > 2000) {
              setRate(Math.round((counters.current.window * 1000) / (now - counters.current.since)));
              counters.current.since = now;
              counters.current.window = 0;
            }
            if (m.shares.length) {
              setPending((prev) => {
                const seen = new Set(prev.map((s) => `${s.z}:${s.d}`));
                const next = [...prev, ...m.shares.filter((s: Share) => !seen.has(`${s.z}:${s.d}`))];
                save(storeKey, next);
                return next;
              });
            }
          } else if (m.type === "solution") {
            const f: Found = { k: m.k, z: m.z, d: m.d, r: m.r };
            save(solKey(d.hunt), f);
            setSolution(f);
          }
        };
        w.postMessage({
          type: "start",
          job: { k: j.k, zMin: j.zMin.toString(), zMax: j.zMax.toString(), hunt: d.hunt, chainId, miner: address, season: j.season, bits: j.bits, seed: i + Math.floor(Math.random() * 1000) },
        });
        workers.current.push(w);
      }
    },
    [d, address, chainId, threads, stop],
  );

  /** The next batch to submit (at most 256) as contract arguments. */
  const batch = pending.slice(0, MAX_BATCH);
  const args = [batch.map((s) => BigInt(s.z)), batch.map((s) => BigInt(s.d)), batch.map((s) => BigInt(s.r))] as const;

  /** Drop the batch that was just accepted on chain. */
  const submitted = useCallback(
    (n: number) => {
      if (!d || !job || !address) return;
      setPending((prev) => {
        const next = prev.slice(n);
        save(key(d.hunt, job.season, job.k, address), next);
        return next;
      });
    },
    [d, job, address],
  );

  /** Choose the target (and season) whose saved shares to show, without mining. */
  const select = useCallback((j: Job) => {
    setJob((cur) => (cur && cur.k === j.k && cur.season === j.season ? cur : j));
  }, []);

  return { job, select, running, threads, setThreads, rate, tried, survivors, pending, batch, args, submitted, start, stop, solution, abi: huntAbi };
}
