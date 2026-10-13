"use client";

import { deployment, type Deployment } from "@/generated/deployment";
import { defaultChainId } from "./wagmi";

/// The live deployment (null until CubeHunt is on chain) and the chain every read and write targets.
export function useDeployment(): { deployment: Deployment | null; chainId: typeof defaultChainId } {
  return { deployment, chainId: defaultChainId };
}
