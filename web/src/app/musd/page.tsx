"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import dynamic from "next/dynamic";
import { useWallet } from "@/hooks/useWallet";
import { PROTOCOL_LIVE, formatUsd } from "@/lib/magnetfi";
import {
  getProtocolStats, getStrategyStats,
  type ProtocolStats, type StrategyStats,
} from "@/lib/magnetfiReads";
import { Stat } from "@/components/magnetfi/v2/shared";

const pulse = () => <div className="h-96 rounded-2xl border border-white/10 bg-black/40 animate-pulse" />;

// Reuse the exact mint/redeem swap tab — no transaction logic is re-implemented here.
const MusdTab = dynamic(
  () => import("@/components/magnetfi/v2/MusdTab").then((m) => m.MusdTab),
  { ssr: false, loading: pulse },
);

export default function MusdPage() {
  const { algodClient } = useWallet();
  const [stats, setStats] = useState<ProtocolStats | null>(null);
  const [strat, setStrat] = useState<StrategyStats | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    if (!PROTOCOL_LIVE || !algodClient) return;
    getProtocolStats(algodClient).then(setStats).catch(() => setErr(true));
    getStrategyStats(algodClient).then(setStrat).catch(() => { /* backing falls back to reserve/circulating */ });
  }, [algodClient]);

  const val = (n?: number, dp = 0) =>
    PROTOCOL_LIVE ? (stats ? `$${formatUsd(n ?? 0, dp)}` : err ? "—" : "…") : "Soon";

  // Fully/over-backed shows "+100%" (a raw 57,000% when circulating is tiny reads as nonsense);
  // an actual under-backed state still shows the true percentage so it's never hidden.
  const backingRatioNum = strat
    ? strat.backingRatio
    : stats
      ? stats.circulating > 0 ? stats.psmUsdc / stats.circulating : 1
      : null;
  const backing =
    backingRatioNum == null
      ? (PROTOCOL_LIVE ? (err ? "—" : "…") : "Soon")
      : backingRatioNum >= 1
        ? "+100%"
        : `${(backingRatioNum * 100).toFixed(2)}%`;

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      {/* Hero */}
      <div className="relative mb-8 overflow-hidden rounded-2xl border border-white/10 bg-black/40 px-6 py-8 backdrop-blur-sm sm:px-10 sm:py-10">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-magnet-500/60 to-transparent" />
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="animate-blob-drift absolute -right-16 -top-16 h-56 w-56 rounded-full bg-magnet-600/20 blur-3xl" />
        </div>

        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <div className="h-14 w-14 shrink-0 overflow-hidden rounded-2xl shadow-lg shadow-magnet-900/50">
              <Image src="/musd-icon.png" alt="mUSD" width={56} height={56} className="h-full w-full object-cover" />
            </div>
            <div>
              <h1 className="font-display magnet-glow-soft text-3xl font-bold text-white sm:text-4xl">mUSD</h1>
              <p className="mt-1 max-w-xl text-sm text-gray-300">
                Magnet Strategies&apos; <span className="font-semibold text-white">USDC-backed</span> stablecoin.
              </p>
            </div>
          </div>

          <span className="inline-flex w-fit items-center gap-2 rounded-full border border-green-500/30 bg-green-500/10 px-3 py-1.5 text-xs font-medium text-green-200">
            <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse-slow" />
            $1.00 · USDC-backed 1:1
          </span>
        </div>
      </div>

      {/* Peg Stability Module metrics */}
      <section className="mb-10">
        <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-gray-500">Peg Stability Module</h2>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="mUSD Peg" value="$1.00" sub="Market Price" />
          <Stat label="Circulating Supply" value={val(stats?.circulating)} sub="Held by Users" />
          <Stat label="Available USDC" value={val(stats?.psmUsdc)} sub="PSM balance for mUSD swaps" accent="green" />
          <Stat label="Backing Ratio" value={backing} sub="USDC Reserves" accent="green" />
        </div>
      </section>

      {/* Mint / redeem — reused verbatim from the mUSD tab */}
      <section>
        <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-gray-500">Mint &amp; redeem</h2>
        <MusdTab />
      </section>
    </div>
  );
}
