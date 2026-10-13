"use client";

import Link from "next/link";
import { formatUnits } from "viem";
import { useReadContracts } from "wagmi";
import { vaultsAbi } from "@/generated/abis";
import { useHunt } from "@/hooks/useHunt";
import { useDeployment } from "@/lib/deployment";

const KS = [114, 390, 627, 633, 732, 921, 975];
const sci = (v: bigint) => `10^${v.toString().length - 1}`;

export function Targets() {
  const { deployment: d, chainId } = useDeployment();
  const h = useHunt();
  const rows = h.targets.length ? h.targets : [];
  const { data } = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(d && rows.length) },
    contracts: d ? rows.map((t) => ({ address: d.vaults, abi: vaultsAbi, functionName: "vaultInfo", args: [t.vaultId], chainId }) as const) : [],
  });
  return (
    <div className="board">
      <div className="board-head">
        <span>Target k</span>
        <span>Search band |z|</span>
        <span>Shares</span>
        <span>Prize vault</span>
      </div>
      {rows.length === 0 &&
        KS.map((k) => (
          <div className="board-row targets-row" key={k}>
            <span className="t">x³ + y³ + z³ = {k}</span>
            <span className="v">10^20 to 10^21</span>
            <span className="v">opens at launch</span>
            <span className="v">–</span>
          </div>
        ))}
      {rows.map((t, i) => {
        const v = data?.[i]?.status === "success" ? (data[i].result as { usd: bigint; usdComplete: boolean }) : undefined;
        return (
          <div className="board-row targets-row" key={t.k}>
            <span className="t">
              x³ + y³ + z³ = {t.k} {t.solved && <span className="chip good">SOLVED</span>}
            </span>
            <span className="v">
              {sci(t.zMin)} to {sci(t.zMax)}
            </span>
            <span className="v">
              {t.shares.toLocaleString()} <span className="n">by {t.miners.toString()}</span>
            </span>
            <span className="v">
              {v ? `$${Number(formatUnits(v.usd, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })}${v.usdComplete ? "" : "+"}` : "…"}{" "}
              <Link className="n" href={`/vaults#v${t.vaultId}`}>
                fund ↗
              </Link>
            </span>
          </div>
        );
      })}
    </div>
  );
}
