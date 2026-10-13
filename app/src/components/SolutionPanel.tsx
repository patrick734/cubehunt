"use client";

import { useEffect, useState } from "react";
import { type Hex, toHex } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { huntAbi } from "@/generated/abis";
import { useDeployment } from "@/lib/deployment";
import type { Found } from "@/hooks/useMiner";
import { TxStatus, useTx } from "./Tx";

/// A real solution: commit (hides it from front-runners), wait 60 seconds, reveal. The contract re-checks
/// x³ + y³ + z³ = k itself and pays the target's prize vault to the finder.
export function SolutionPanel({ found }: { found: Found }) {
  const { deployment: d, chainId } = useDeployment();
  const { address } = useAccount();
  const tx = useTx();
  const z = BigInt(found.z);
  const dd = BigInt(found.d);
  const r = BigInt(found.r);
  const x = (dd + r) / 2n;
  const y = (dd - r) / 2n;
  const saltKey = `cubehunt:salt:${found.k}:${found.z}`;
  const [salt, setSalt] = useState<Hex | null>(null);
  const [committedAt, setCommittedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    try {
      const s = localStorage.getItem(saltKey);
      if (s) {
        const v = JSON.parse(s) as { salt: Hex; at: number | null };
        setSalt(v.salt);
        setCommittedAt(v.at);
        return;
      }
    } catch {}
    const fresh = toHex(crypto.getRandomValues(new Uint8Array(32)));
    setSalt(fresh);
    try {
      localStorage.setItem(saltKey, JSON.stringify({ salt: fresh, at: null }));
    } catch {}
  }, [saltKey]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const { data: commitment } = useReadContract({
    address: d?.hunt,
    abi: huntAbi,
    chainId,
    functionName: "solutionCommitment",
    args: [found.k, x, y, z, address ?? "0x0000000000000000000000000000000000000000", salt ?? "0x"],
    query: { enabled: Boolean(d && address && salt) },
  });

  async function commit() {
    if (!d || !commitment) return;
    const ok = await tx.run("Commit solution", async () => tx.writeContractAsync({ address: d.hunt, abi: huntAbi, chainId, functionName: "commitSolution", args: [commitment] }));
    if (ok) {
      const at = Date.now();
      setCommittedAt(at);
      localStorage.setItem(saltKey, JSON.stringify({ salt, at }));
    }
  }

  async function reveal() {
    if (!d || !salt) return;
    await tx.run("Reveal solution", async () => tx.writeContractAsync({ address: d.hunt, abi: huntAbi, chainId, functionName: "revealSolution", args: [found.k, x, y, z, salt] }));
  }

  const wait = committedAt ? Math.max(0, 75 - Math.floor((now - committedAt) / 1000)) : null;
  return (
    <div className="card solution">
      <span className="label">Possible solution found</span>
      <h3>
        {found.k} = ({x.toString()})³ + ({y.toString()})³ + ({z.toString()})³
      </h3>
      <p>
        Saved on this device. Claim it in two steps: commit (keeps it secret from anyone watching), then reveal after a minute. The contract checks the
        equation itself and pays this target&apos;s prize vault to you. Back up this page&apos;s data before closing the browser.
      </p>
      <div className="row-actions">
        <button className="btn btn-primary" disabled={tx.busy || !commitment || committedAt !== null} onClick={commit}>
          1. Commit
        </button>
        <button className="btn btn-ember" disabled={tx.busy || wait === null || wait > 0} onClick={reveal}>
          {wait && wait > 0 ? `2. Reveal in ${wait}s` : "2. Reveal and claim"}
        </button>
      </div>
      <TxStatus message={tx.message} error={tx.error} />
    </div>
  );
}
