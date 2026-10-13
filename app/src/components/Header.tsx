"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ConnectButton } from "./ConnectButton";

const NAV = [
  { href: "/", label: "Hunt" },
  { href: "/vaults", label: "Prize vaults" },
  { href: "/dao", label: "DAO" },
  { href: "/safety", label: "Safety" },
  { href: "/how", label: "How it works" },
];

export function CubeMark({ className = "brand-mark" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 100 100" aria-hidden>
      <path d="M50 6 L90 28 L90 72 L50 94 L10 72 L10 28 Z" className="cube-face" />
      <path d="M50 6 L90 28 L50 50 L10 28 Z" className="cube-top" />
      <path d="M50 50 L50 94" className="cube-edge" />
      <text x="50" y="76" textAnchor="middle" className="cube-sup">3</text>
    </svg>
  );
}

export function Header() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);
  return (
    <header className="header">
      <Link href="/" className="brand">
        <CubeMark />
        CubeHunt
      </Link>
      <nav id="site-nav" className={open ? "nav open" : "nav"}>
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className={(n.href === "/" ? pathname === "/" : pathname.startsWith(n.href)) ? "active" : undefined}>
            {n.label}
          </Link>
        ))}
      </nav>
      <ConnectButton />
      <button className="menu-btn" aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} aria-controls="site-nav" onClick={() => setOpen((o) => !o)}>
        {open ? "✕" : "☰"}
      </button>
    </header>
  );
}
