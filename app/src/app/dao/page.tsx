"use client";

import { zeroAddress } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import { governorAbi, pointsAbi } from "@/generated/abis";
import { TxStatus, useTx } from "@/components/Tx";
import { useDeployment } from "@/lib/deployment";

const STATE = ["Pending", "Active", "Canceled", "Defeated", "Succeeded", "Queued", "Expired", "Executed"];
type P = { index: bigint; id: bigint; proposer: string; state: number; deadline: bigint; eta: bigint; againstVotes: bigint; forVotes: bigint; abstainVotes: bigint; quorum: bigint; description: string };

export default function DaoPage() {
  const { deployment: d, chainId } = useDeployment();
  const { address } = useAccount();
  const tx = useTx();
  const { data } = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(d) },
    contracts: d
      ? [
          { address: d.governor, abi: governorAbi, functionName: "proposals", args: [0n, 100n], chainId },
          { address: d.governor, abi: governorAbi, functionName: "proposalThreshold", chainId },
          { address: d.governor, abi: governorAbi, functionName: "votingPeriod", chainId },
          { address: d.points, abi: pointsAbi, functionName: "getVotes", args: [address ?? zeroAddress], chainId },
          { address: d.points, abi: pointsAbi, functionName: "totalSupply", chainId },
        ]
      : [],
  });
  const r = <T,>(i: number) => (data?.[i]?.status === "success" ? (data[i].result as T) : undefined);
  const props = [...(r<readonly P[]>(0) ?? [])].reverse();

  async function vote(id: bigint, support: number) {
    if (!d) return;
    await tx.run("Vote", async () => tx.writeContractAsync({ address: d.governor, abi: governorAbi, chainId, functionName: "castVote", args: [id, support] }));
  }

  return (
    <div className="wrap page">
      <div className="page-head">
        <div>
          <span className="eyebrow">CubeHunt DAO</span>
          <h1>Points are votes</h1>
          <p className="muted">
            Points come only from mining shares, funding vaults and discoveries. They can&apos;t be bought on a market or transferred. Proposals need{" "}
            {String(r<bigint>(1) ?? "1000")} points, run for {r<bigint>(2) ? `${Number(r<bigint>(2)) / 3600} hours` : "48 hours"}, need 4% of all points
            to vote, and then wait 48 hours in the timelock before anyone can execute them. No wallet, the team&apos;s included, can skip that.
          </p>
        </div>
      </div>
      <div className="strip three">
        <div className="stat">
          <div className="stat-label">Your votes</div>
          <div className="stat-value">{r<bigint>(3)?.toLocaleString() ?? "–"}</div>
        </div>
        <div className="stat">
          <div className="stat-label">All points</div>
          <div className="stat-value">{r<bigint>(4)?.toLocaleString() ?? "–"}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Proposals</div>
          <div className="stat-value">{props.length}</div>
        </div>
      </div>
      <TxStatus message={tx.message} error={tx.error} />
      {!d && <div className="card notice">The DAO opens when the contracts are live.</div>}
      {d && props.length === 0 && <div className="card notice">No proposals yet. Anyone with {String(r<bigint>(1) ?? "1000")} points can propose through the governor contract.</div>}
      {props.map((p) => (
        <div className="card" key={String(p.id)}>
          <span className="label">
            #{String(p.index)} · {STATE[p.state]} · by {p.proposer.slice(0, 8)}…
          </span>
          <p>{p.description}</p>
          <p className="small num">
            For {p.forVotes.toLocaleString()} · Against {p.againstVotes.toLocaleString()} · Abstain {p.abstainVotes.toLocaleString()}
            {p.quorum ? ` · quorum ${p.quorum.toLocaleString()}` : ""}
          </p>
          {p.state === 1 && (
            <div className="row-actions">
              <button className="btn btn-primary btn-sm" disabled={tx.busy} onClick={() => vote(p.id, 1)}>
                For
              </button>
              <button className="btn btn-sm" disabled={tx.busy} onClick={() => vote(p.id, 0)}>
                Against
              </button>
              <button className="btn btn-sm" disabled={tx.busy} onClick={() => vote(p.id, 2)}>
                Abstain
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
