"use client";

import { formatEther, zeroAddress } from "viem";
import { useReadContracts } from "wagmi";
import { buyBurnAbi, huntAbi, pointsAbi, timelockAbi, vaultsAbi } from "@/generated/abis";
import { explorerAddress } from "@/lib/chains";
import { useDeployment } from "@/lib/deployment";

export default function SafetyPage() {
  const { deployment: d, chainId } = useDeployment();
  const PROPOSER = "0xb09aa5aeb3702cfd50b6b62bc4532604938f21248a27a1d5ca736082b6819cc1";
  const EXECUTOR = "0xd8aa0f3194971a2a116679f7c2090f6939c8d4e01a2a8d7e41d55e5351469e63";
  const ADMIN = "0x0000000000000000000000000000000000000000000000000000000000000000";
  const { data } = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(d) },
    contracts: d
      ? [
          { address: d.hunt, abi: huntAbi, functionName: "guardianActive", chainId },
          { address: d.hunt, abi: huntAbi, functionName: "guardianUntil", chainId },
          { address: d.timelock, abi: timelockAbi, functionName: "getMinDelay", chainId },
          { address: d.timelock, abi: timelockAbi, functionName: "hasRole", args: [PROPOSER, d.governor], chainId },
          { address: d.timelock, abi: timelockAbi, functionName: "hasRole", args: [EXECUTOR, zeroAddress], chainId },
          { address: d.timelock, abi: timelockAbi, functionName: "hasRole", args: [ADMIN, d.deployer], chainId },
          { address: d.timelock, abi: timelockAbi, functionName: "hasRole", args: [PROPOSER, d.deployer], chainId },
          { address: d.points, abi: pointsAbi, functionName: "mintersSealed", chainId },
          { address: d.buyBurn, abi: buyBurnAbi, functionName: "hasRole", args: [ADMIN, d.timelock], chainId },
          { address: d.buyBurn, abi: buyBurnAbi, functionName: "token", chainId },
          { address: d.buyBurn, abi: buyBurnAbi, functionName: "totalBurned", chainId },
          { address: d.hunt, abi: huntAbi, functionName: "shareFee", chainId },
          { address: d.vaults, abi: vaultsAbi, functionName: "depositFeeBps", chainId },
        ]
      : [],
  });
  const r = <T,>(i: number) => (data?.[i]?.status === "success" ? (data[i].result as T) : undefined);
  const until = r<bigint>(1);
  const checks: [string, boolean | undefined, string][] = [
    ["Timelock delay is 48 hours or more", r<bigint>(2) !== undefined ? r<bigint>(2)! >= 172800n : undefined, `${r<bigint>(2) ? Number(r<bigint>(2)) / 3600 : "…"} hours`],
    ["Only DAO votes can propose", r<boolean>(3), "the governor is the timelock's only proposer"],
    ["Anyone can execute a passed vote after the delay", r<boolean>(4), "no gatekeeper"],
    ["The dev wallet is not timelock admin", r<boolean>(5) === undefined ? undefined : !r<boolean>(5), d?.deployer ?? ""],
    ["The dev wallet cannot propose", r<boolean>(6) === undefined ? undefined : !r<boolean>(6), "no direct path to the money"],
    ["Points minters are sealed", r<boolean>(7), "only the Hunt and the Vaults mint; changing that takes a DAO vote"],
    ["BuyBurn is run by the timelock", r<boolean>(8), "no withdrawal function exists"],
  ];
  const contracts = d ? ([["Hunt", d.hunt], ["Vaults", d.vaults], ["Points", d.points], ["Governor", d.governor], ["Timelock", d.timelock], ["BuyBurn", d.buyBurn]] as const) : [];
  return (
    <div className="wrap page">
      <div className="page-head">
        <div>
          <span className="eyebrow">Safety</span>
          <h1>Who can do what</h1>
          <p className="muted">
            Every line below is read live from the contracts. The guardian (the dev wallet) only does launch setup, its powers end on their own, and it can
            never set prices, mint votes, veto the DAO or move a vault&apos;s money.
          </p>
        </div>
      </div>
      {!d && <div className="card notice">Checks appear when the contracts are live.</div>}
      {d && (
        <>
          <div className="card">
            <span className="label">Guardian</span>
            <h3>{r<boolean>(0) ? "Active (setup only)" : "Ended: no guardian powers left"}</h3>
            <p className="small">
              Powers end {until ? new Date(Number(until) * 1000).toUTCString() : "…"}. It can add targets, create vaults, start the first season and pause
              mining. It cannot change fees, assets, prices or points per dollar, cannot make a wallet a minter, cannot cancel a DAO vote, and cannot move
              vault money.
            </p>
          </div>
          <ul className="checks">
            {checks.map(([label, okv, detail]) => (
              <li key={label} className={okv === undefined ? "card" : okv ? "card ok" : "card bad"}>
                <span className="mark">{okv === undefined ? "…" : okv ? "✓" : "!"}</span>
                <div>
                  <b>{label}</b>
                  <p className="small muted">{detail}</p>
                </div>
              </li>
            ))}
          </ul>
          <div className="card">
            <span className="label">Fees and burn</span>
            <p className="small">
              Share fee {r<bigint>(11) !== undefined ? `${formatEther(r<bigint>(11)!)} ETH` : "…"} per accepted share · deposit fee{" "}
              {r<bigint>(12) !== undefined ? `${Number(r<bigint>(12)) / 100}%` : "…"} · both capped in code (0.0001 ETH and 10%) and changeable only by a DAO
              vote. $CUBE burned so far: {r<bigint>(10) !== undefined ? Number(formatEther(r<bigint>(10)!)).toLocaleString() : "…"}.
              {r<string>(9) && r<string>(9) !== zeroAddress ? "" : " $CUBE is plugged in after its Pons launch; fees wait in the BuyBurn until then."}
            </p>
          </div>
          <div className="card">
            <span className="label">Contracts (verified source)</span>
            <ul className="plain">
              {contracts.map(([n, a]) => (
                <li key={n}>
                  {n}:{" "}
                  <a href={explorerAddress(a)} target="_blank" rel="noreferrer" className="mono">
                    {a}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
