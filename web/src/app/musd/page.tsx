"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import dynamic from "next/dynamic";
import { useWallet } from "@/hooks/useWallet";
import { PROTOCOL_LIVE, PSM_REDEEM_FEE_BPS, pct, formatUsd } from "@/lib/magnetfi";
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

  const backing = strat
    ? `${(strat.backingRatio * 100).toFixed(strat.backingRatio >= 1 ? 0 : 2)}%`
    : stats
      ? `${stats.circulating > 0 ? Math.round((stats.psmUsdc / stats.circulating) * 100) : 100}%`
      : PROTOCOL_LIVE ? (err ? "—" : "…") : "Soon";

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
          <Stat label="mUSD Circulating" value={val(stats?.circulating)} sub="Outstanding supply" />
          <Stat label="USDC Reserve" value={val(stats?.psmUsdc)} sub="Backing held in the PSM" accent="green" />
          <Stat label="Backing Ratio" value={backing} sub="Reserve ÷ circulating" accent="green" />
          <Stat label="mUSD Peg" value="$1.00" sub={`Redeem fee ${pct(PSM_REDEEM_FEE_BPS)}%`} />
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
