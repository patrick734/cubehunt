"use client";

import Link from "next/link";
import { formatEther } from "viem";
import { CubeMark } from "@/components/Header";
import { MinerPanel } from "@/components/MinerPanel";
import { Targets } from "@/components/Targets";
import { useHunt } from "@/hooks/useHunt";

export default function Home() {
  const h = useHunt();
  const s = h.stats;
  return (
    <div className="wrap page">
      <section className="hero">
        <div>
          <span className="eyebrow">Open problems · Robinhood Chain</span>
          <h1>
            Seven numbers nobody has written as <span className="accent">x³ + y³ + z³</span>.
          </h1>
          <p className="lead">
            114, 390, 627, 633, 732, 921 and 975 are the only numbers below 1000 still waiting. Mine them from your browser: the chain checks every share
            itself, and if anyone ever finds a real answer, the contract pays that number&apos;s prize vault on the spot.
          </p>
          <div className="hero-cta">
            <a href="#mine" className="btn btn-primary">
              Start mining
            </a>
            <Link href="/how" className="btn">
              How it works
            </Link>
          </div>
          <p className="hero-note">33 and 42 fell in 2019 after decades. The band we search, 10^20 ≤ |z| &lt; 10^21, is beyond every published search.</p>
        </div>
        <div className="hero-art" aria-hidden>
          <CubeMark className="hero-cube" />
        </div>
      </section>

      <div className="strip">
        <div className="stat">
          <div className="stat-label">Shares checked on chain</div>
          <div className="stat-value">{s ? s.shares.toLocaleString() : "–"}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Miners</div>
          <div className="stat-value">{s ? s.miners.toLocaleString() : "–"}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Solved</div>
          <div className="stat-value">{s ? `${s.solved} of ${s.targets}` : "0 of 7"}</div>
        </div>
        <div className="stat">
          <div className="stat-label">$CUBE burned</div>
          <div className="stat-value">{h.burned !== undefined ? Number(formatEther(h.burned)).toLocaleString(undefined, { maximumFractionDigits: 0 }) : "–"}</div>
          <div className="stat-hint">{h.totalFees !== undefined ? `${formatEther(h.totalFees)} ETH in share fees` : "every fee buys and burns $CUBE"}</div>
        </div>
      </div>

      <section className="section" id="mine">
        <div className="grid-2">
          <MinerPanel />
          <div className="stack">
            <div className="card">
              <span className="label">Your account</span>
              <div className="stats-grid two">
                <div>
                  <div className="stat-label">Points (votes)</div>
                  <div className="stat-value small">{h.myPoints !== undefined ? h.myPoints.toLocaleString() : "–"}</div>
                </div>
                <div>
                  <div className="stat-label">Shares accepted</div>
                  <div className="stat-value small">{h.myShares !== undefined ? h.myShares.toLocaleString() : "–"}</div>
                </div>
              </div>
              <p className="small">Points vote in the CubeHunt DAO, which runs the prize vaults through a 48-hour timelock. They can&apos;t be transferred or sold.</p>
            </div>
            <div className="card notice">
              <span className="label">What a share is</span>
              <p className="small">
                For a prime p, z ≡ ∛k (mod p) makes p divide k − z³. Your browser picks such z in the band, sets d = x + y = ±p and tests whether
                (4(k − z³)/d − d²)/3 can be a perfect square. Candidates that pass nine square tests, and whose hash with your address meets the season&apos;s
                difficulty, are shares. A perfect square is a solution.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <div>
            <h2>The seven targets</h2>
            <p>Every share, miner and prize below is read live from the CubeHunt contracts.</p>
          </div>
        </div>
        <Targets />
      </section>
    </div>
  );
}
