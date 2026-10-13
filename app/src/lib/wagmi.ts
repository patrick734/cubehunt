import { createConfig, http, injected } from "wagmi";
import { READ_RPC, robinhoodChain } from "./chains";

export const wagmiConfig = createConfig({
  chains: [robinhoodChain],
  connectors: [injected()],
  transports: { [robinhoodChain.id]: http(READ_RPC, { batch: { batchSize: 5 } }) },
  ssr: true,
});

export const defaultChainId = robinhoodChain.id;
