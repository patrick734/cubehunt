"use client";

import { zeroAddress } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import { buyBurnAbi, huntAbi, pointsAbi, vaultsAbi } from "@/generated/abis";
import { useDeployment } from "@/lib/deployment";

export type TargetRow = {
  k: number;
  zMin: bigint;
  zMax: bigint;
  shares: bigint;
  miners: bigint;
  solved: boolean;
  vaultId: bigint;
  finder: string;
  x: bigint;
  y: bigint;
  z: bigint;
};

/** Everything the hunt pages read, refreshed every 15 s. */
export function useHunt() {
  const { deployment: d, chainId } = useDeployment();
  const { address } = useAccount();
  const me = address ?? zeroAddress;
  const { data, refetch } = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(d) },
    contracts: d
      ? [
          { address: d.hunt, abi: huntAbi, functionName: "stats", chainId },
          { address: d.hunt, abi: huntAbi, functionName: "allTargets", chainId },
          { address: d.hunt, abi: huntAbi, functionName: "shareFee", chainId },
          { address: d.hunt, abi: huntAbi, functionName: "minerInfo", args: [me], chainId },
          { address: d.points, abi: pointsAbi, functionName: "balanceOf", args: [me], chainId },
          { address: d.points, abi: pointsAbi, functionName: "totalSupply", chainId },
          { address: d.buyBurn, abi: buyBurnAbi, functionName: "totalBurned", chainId },
          { address: d.buyBurn, abi: buyBurnAbi, functionName: "token", chainId },
          { address: d.hunt, abi: huntAbi, functionName: "guardianActive", chainId },
          { address: d.vaults, abi: vaultsAbi, functionName: "depositFeeBps", chainId },
          { address: d.hunt, abi: huntAbi, functionName: "totalFees", chainId },
        ]
      : [],
  });
  const r = <T,>(i: number) => (data?.[i]?.status === "success" ? (data[i].result as T) : undefined);
  const stats = r<readonly [bigint, bigint, bigint, bigint, bigint, number, number, bigint, boolean]>(0);
  const targets = (r<readonly TargetRow[]>(1) ?? []).map((t) => ({ ...t, k: Number(t.k) }));
  const miner = r<{ shares: bigint; seasonShares: bigint; work: bigint }>(3);
  const token = r<string>(7);
  return {
    d,
    chainId,
    live: Boolean(d),
    stats: stats && {
      shares: stats[0],
      miners: stats[2],
      targets: stats[3],
      solved: stats[4],
      season: Number(stats[5]),
      bits: Number(stats[6]),
      pointsPerShare: stats[7],
      paused: stats[8],
    },
    targets,
    shareFee: r<bigint>(2),
    myShares: miner?.shares,
    myPoints: r<bigint>(4),
    pointsSupply: r<bigint>(5),
    burned: r<bigint>(6),
    cube: token && token !== zeroAddress ? token : null,
    guardianActive: r<boolean>(8),
    depositFeeBps: r<bigint>(9),
    totalFees: r<bigint>(10),
    refetch,
  };
}
