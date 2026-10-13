"use client";

import { useState } from "react";
import { brand, tradeUrl } from "@/lib/brand";
import { explorerAddress } from "@/lib/chains";

export function TokenCA({ address = brand.tokenAddress }: { address?: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!address) return <span className="ca muted">{brand.token} launches on Pons. The only official address will be posted here.</span>;
  return (
    <span className="ca">
      <span className="chip">{brand.token} CA</span>
      <code>{address}</code>
      <button
        className="btn btn-sm"
        onClick={() => {
          navigator.clipboard?.writeText(address);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <a className="btn btn-sm" href={explorerAddress(address)} target="_blank" rel="noreferrer">
        Explorer ↗
      </a>
      <a className="btn btn-sm btn-primary" href={tradeUrl(address)} target="_blank" rel="noreferrer">
        Buy on Pons ↗
      </a>
    </span>
  );
}
