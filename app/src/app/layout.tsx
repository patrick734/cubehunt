import type { Metadata } from "next";
import { Fraunces, IBM_Plex_Mono, Inter } from "next/font/google";
import type { ReactNode } from "react";
import { Header } from "@/components/Header";
import { Providers } from "@/components/Providers";
import { TokenCA } from "@/components/TokenCA";
import "./globals.css";

const display = Fraunces({ subsets: ["latin"], variable: "--font-display", display: "swap" });
const body = Inter({ subsets: ["latin"], variable: "--font-body", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-mono", display: "swap" });

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://cubehunt.fun";
const description =
  "Mine the seven unsolved sums of three cubes below 1000 from your browser on Robinhood Chain. The chain checks every share and pays a prize vault itself if an answer turns up. Fees buy and burn $CUBE.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "CubeHunt",
  description,
  openGraph: { title: "CubeHunt", description, siteName: "CubeHunt", type: "website" },
  twitter: { card: "summary_large_image", title: "CubeHunt", description },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <Providers>
          <Header />
          <main>{children}</main>
          <footer className="footer">
            <div className="stack-xs">
              <TokenCA />
            </div>
            <span className="num">x³ + y³ + z³ = k · checked on chain · 48h DAO timelock</span>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
