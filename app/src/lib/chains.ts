import { defineChain } from "viem";

// Browsers read through the site's own /api/rpc (the public node sends no CORS headers); the server goes direct.
const DIRECT = process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
export const READ_RPC = typeof window === "undefined" ? DIRECT : "/api/rpc";

export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [DIRECT] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

export function explorerAddress(address: string) {
  return `${robinhoodChain.blockExplorers.default.url}/address/${address}`;
}
export function explorerTx(hash: string) {
  return `${robinhoodChain.blockExplorers.default.url}/tx/${hash}`;
}
