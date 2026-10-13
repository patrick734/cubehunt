"use client";

import { useEffect, useState } from "react";
import { formatEther } from "viem";
import { useAccount } from "wagmi";
import { useHunt } from "@/hooks/useHunt";
import { useMiner } from "@/hooks/useMiner";
import { useDeployment } from "@/lib/deployment";
import { SolutionPanel } from "./SolutionPanel";
import { TxStatus, useTx } from "./Tx";

const fmt = (n: number) => n.toLocaleString();

export function MinerPanel() {
  const { deployment: d, chainId } = useDeployment();
  const { isConnected } = useAccount();
  const h = useHunt();
  const m = useMiner();
  const tx = useTx();
  const open = h.targets.filter((t) => !t.solved);
  const [k, setK] = useState<number | null>(null);
  const target = open.find((t) => t.k === k) ?? open[0];

  const season = h.stats?.season ?? 0;
  const bits = h.stats?.bits ?? 0;
  useEffect(() => {
    if (target && season) m.select({ k: target.k, zMin: target.zMin, zMax: target.zMax, season, bits });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.k, season, bits]);

  const fee = h.shareFee ?? 0n;
  const n = m.batch.length;

  async function submit() {
    if (!d || !target || n === 0) return;
    const ok = await tx.run(`Submit ${n} share${n > 1 ? "s" : ""}`, async () =>
      tx.writeContractAsync({
        address: d.hunt,
        abi: m.abi,
        chainId,
        functionName: "submitShares",
        args: [target.k, ...m.args],
        value: fee * BigInt(n),
      }),
    );
    if (ok) m.submitted(n);
  }

  if (!d) {
    return (
      <div className="card miner">
        <h2>Mine from this browser</h2>
        <p>The hunt opens when the contracts are live. Your browser will search for shares and the chain will check each one.</p>
      </div>
    );
  }

  const blocked = !isConnected ? "Connect a wallet to mine" : h.stats?.paused ? "Mining is paused" : !season ? "No season running" : !target ? "Every target is solved" : null;

  return (
    <div className="card miner">
      <div className="miner-head">
        <div>
          <span className="label">Season {season || "–"} · difficulty {bits} bits · {String(h.stats?.pointsPerShare ?? "…")} points per share</span>
          <h2>Mine x³ + y³ + z³ = {target?.k ?? "…"}</h2>
        </div>
        <div className={m.running ? "pulse on" : "pulse"} aria-hidden />
      </div>

      <div className="target-pick" role="radiogroup" aria-label="Target">
        {open.map((t) => (
          <button key={t.k} role="radio" aria-checked={t.k === target?.k} className={t.k === target?.k ? "chip-btn on" : "chip-btn"} disabled={m.running} onClick={() => setK(t.k)}>
            {t.k}
          </button>
        ))}
      </div>

      <div className="strip three miner-strip">
        <div className="stat">
          <div className="stat-label">Speed</div>
          <div className="stat-value small">{m.running ? `${fmt(m.rate)}/s` : "idle"}</div>
          <div className="stat-hint">{m.threads} thread{m.threads > 1 ? "s" : ""}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Checked</div>
          <div className="stat-value small">{fmt(m.tried)}</div>
          <div className="stat-hint">{fmt(m.survivors)} passed the square tests</div>
        </div>
        <div className="stat">
          <div className="stat-label">Shares ready</div>
          <div className="stat-value small">{m.pending.length}</div>
          <div className="stat-hint">kept on this device until you submit</div>
        </div>
      </div>

      <div className="row-actions">
        {m.running ? (
          <button className="btn" onClick={m.stop}>
            Stop mining
          </button>
        ) : (
          <button className="btn btn-primary" disabled={Boolean(blocked)} onClick={() => target && m.start({ k: target.k, zMin: target.zMin, zMax: target.zMax, season, bits })}>
            {blocked ?? "Start mining"}
          </button>
        )}
        <label className="threads">
          Threads
          <input type="number" min={1} max={8} value={m.threads} disabled={m.running} onChange={(e) => m.setThreads(Math.max(1, Math.min(8, Number(e.target.value) || 1)))} />
        </label>
        <button className="btn btn-ember" disabled={n === 0 || tx.busy || !isConnected} onClick={submit}>
          {n === 0 ? "No shares yet" : `Submit ${n} share${n > 1 ? "s" : ""} · ${formatEther(fee * BigInt(n))} ETH fee`}
        </button>
      </div>
      <TxStatus message={tx.busy ? tx.message : tx.message} error={tx.error} />
      <p className="fine">
        Each accepted share earns {String(h.stats?.pointsPerShare ?? "…")} points (votes in the CubeHunt DAO; they can&apos;t be sold or sent) and pays a {formatEther(fee)} ETH fee that
        buys and burns $CUBE. Duplicates are skipped for free. Mining uses your CPU; close the tab to stop.
      </p>
      {m.solution && <SolutionPanel found={m.solution} />}
    </div>
  );
}
