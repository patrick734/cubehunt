import { NextResponse } from "next/server";

// Read-only JSON-RPC relay for browsers: the public Robinhood node sends no CORS headers. Only read methods pass;
// wallets send transactions through their own RPC, never through here.
const UPSTREAM = process.env.ROBINHOOD_RPC_URL || process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const ALLOWED = new Set(["eth_chainId", "eth_blockNumber", "eth_call", "eth_getBalance", "eth_getBlockByNumber", "eth_getCode", "eth_getLogs", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory", "net_version"]);
const MAX_BATCH = 20;

type Req = { method?: unknown };

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const list = (Array.isArray(body) ? body : [body]) as Req[];
  if (list.length === 0 || list.length > MAX_BATCH || list.some((r) => typeof r?.method !== "string" || !ALLOWED.has(r.method as string))) {
    return NextResponse.json({ error: "method not allowed" }, { status: 403 });
  }
  const res = await fetch(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  return new NextResponse(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
}
