"use client";

import { useState } from "react";
import { formatEther, formatUnits, parseEther, parseUnits, zeroAddress } from "viem";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { vaultsAbi } from "@/generated/abis";
import { TxStatus, useTx } from "@/components/Tx";
import { useDeployment } from "@/lib/deployment";

type VaultView = {
  id: bigint;
  kind: number;
  status: number;
  k: number;
  title: string;
  ref: string;
  patronCount: bigint;
  tokens: readonly `0x${string}`[];
  held: readonly bigint[];
  usd: bigint;
  usdComplete: boolean;
  paidTo: string;
};

const STATUS = ["Open", "Paid out", "Moved"];

export default function VaultsPage() {
  const { deployment: d, chainId } = useDeployment();
  const { data: count } = useReadContract({ address: d?.vaults, abi: vaultsAbi, chainId, functionName: "vaultCount", query: { enabled: Boolean(d) } });
  const n = Number(count ?? 0n);
  const { data } = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(d && n) },
    contracts: d ? Array.from({ length: n }, (_, i) => ({ address: d.vaults, abi: vaultsAbi, functionName: "vaultInfo", args: [BigInt(i + 1)], chainId }) as const) : [],
  });
  const vaults = (data ?? []).flatMap((r) => (r.status === "success" ? [r.result as unknown as VaultView] : []));
  return (
    <div className="wrap page">
      <div className="page-head">
        <div>
          <span className="eyebrow">Prize vaults</span>
          <h1>Fund the hunt</h1>
          <p className="muted">
            Each target has a prize vault. Only the hunt contract can pay a HUNT vault, and only to whoever submits an answer the chain itself verifies.
            There is no team withdrawal. A small fee on each deposit buys and burns $CUBE; the rest goes in the vault and
            earns you points (votes).
          </p>
        </div>
      </div>
      {!d && <div className="card notice">Vaults open when the contracts are live.</div>}
      <div className="vault-grid">
        {vaults.map((v) => (
          <VaultCard key={String(v.id)} v={v} />
        ))}
      </div>
    </div>
  );
}

function VaultCard({ v }: { v: VaultView }) {
  const { deployment: d, chainId } = useDeployment();
  const { isConnected } = useAccount();
  const tx = useTx();
  const [asset, setAsset] = useState<"USDG" | "ETH">("USDG");
  const [amount, setAmount] = useState("10");
  const { data: fee } = useReadContract({ address: d?.vaults, abi: vaultsAbi, chainId, functionName: "depositFeeBps", query: { enabled: Boolean(d) } });
  const { data: ppu } = useReadContract({ address: d?.vaults, abi: vaultsAbi, chainId, functionName: "pointsPerUsd", query: { enabled: Boolean(d) } });
  const bps = Number(fee ?? 0n);
  let wei: bigint | null = null;
  try {
    wei = asset === "USDG" ? parseUnits(amount as `${number}`, 6) : parseEther(amount as `${number}`);
  } catch {
    wei = null;
  }
  const open = v.status === 0;

  async function give() {
    if (!d || !wei) return;
    if (asset === "USDG") {
      await tx.run("Fund vault", async ({ ensureAllowance }) => {
        await ensureAllowance(d.usdg, d.vaults, wei!);
        return tx.writeContractAsync({ address: d.vaults, abi: vaultsAbi, chainId, functionName: "deposit", args: [v.id, d.usdg, wei!] });
      });
    } else {
      await tx.run("Fund vault", async () => tx.writeContractAsync({ address: d.vaults, abi: vaultsAbi, chainId, functionName: "depositETH", args: [v.id], value: wei! }));
    }
  }

  const holdings = v.tokens
    .map((t, i) => ({ t, h: v.held[i] }))
    .filter((x) => x.h > 0n)
    .map((x) => (x.t === zeroAddress ? `${formatEther(x.h)} ETH` : x.t.toLowerCase() === d?.usdg.toLowerCase() ? `${formatUnits(x.h, 6)} USDG` : `${x.h} units of ${x.t.slice(0, 8)}…`));

  return (
    <div className="card vault" id={`v${v.id}`}>
      <span className="label">
        Vault {String(v.id)} · {v.kind === 0 ? "HUNT" : "PROOF"} · {STATUS[v.status]}
      </span>
      <h3>{v.title}</h3>
      <div className="stat-value">${Number(formatUnits(v.usd, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })}{v.usdComplete ? "" : "+"}</div>
      <p className="small">{holdings.length ? holdings.join(" + ") : "Empty so far"} · {String(v.patronCount)} patron{v.patronCount === 1n ? "" : "s"}</p>
      {open && (
        <>
          <div className="deposit-row">
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.trim().replace(",", "."))} aria-label="Amount" />
            <select value={asset} onChange={(e) => setAsset(e.target.value as "USDG" | "ETH")} aria-label="Asset">
              <option>USDG</option>
              <option>ETH</option>
            </select>
            <button className="btn btn-primary" disabled={!isConnected || !wei || tx.busy} onClick={give}>
              {isConnected ? "Give" : "Connect"}
            </button>
          </div>
          <p className="fine">
            {(bps / 100).toFixed(2)}% buys and burns $CUBE. {asset === "USDG" && wei ? `About ${Math.floor(Number(formatUnits((wei * BigInt(10_000 - bps)) / 10_000n, 6)) * Number(ppu ?? 0n)).toLocaleString()} points.` : "ETH earns points only if the DAO has an ETH price feed."}
          </p>
          <TxStatus message={tx.message} error={tx.error} />
        </>
      )}
      {!open && v.paidTo !== zeroAddress && <p className="small">Paid to {v.paidTo}</p>}
    </div>
  );
}
