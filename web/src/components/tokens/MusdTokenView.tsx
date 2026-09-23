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
import { Panel } from "@/components/magnetfi/v2/shared";
import { VestigeChart } from "@/components/VestigeChart";
import { AboutModal } from "@/components/tokens/AboutModal";
import { MusdPoolsSection } from "@/components/tokens/MusdPoolsSection";

const pulse = () => <div className="h-96 rounded-2xl border border-white/10 bg-black/40 animate-pulse" />;

// Reuse the exact mint/redeem swap tab — no transaction logic is re-implemented here.
const MusdTab = dynamic(
  () => import("@/components/magnetfi/v2/MusdTab").then((m) => m.MusdTab),
  { ssr: false, loading: pulse },
);

function StatCell({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: "green" | "purple" | "red";
}) {
  const valueColor =
    accent === "green" ? "text-green-400"
    : accent === "purple" ? "text-magnet-300"
    : accent === "red" ? "text-red-400"
    : "text-white";
  return (
    <div className="p-5">
      <p className="text-xs font-medium uppercase tracking-wider text-gray-500">{label}</p>
      <p className={`mt-2 font-mono text-2xl font-bold ${valueColor}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-gray-500">{sub}</p>}
    </div>
  );
}

export function MusdTokenView() {
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

  // Static $1 peg until a live market-price feed is wired (see the "Market Price" subtext). When
  // that lands, pegPrice becomes the live quote and the metric turns red automatically below $1.
  const pegPrice = 1;
  const underPeg = pegPrice < 1;
  const underBacked = backingRatioNum != null && backingRatioNum < 1;

  return (
    <>
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

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <AboutModal triggerLabel="About mUSD" heading="What is mUSD?">
              <p>
                Magnet USD is an Algorand-native stablecoin issued by Magnet Strategies. It holds
                a 1:1 peg to USDC through a protocol-owned Peg Stability Module (PSM), and is
                fully collateral-backed. Users mint mUSD by either depositing USDC 1:1 (no fee),
                or by borrowing against specified collateral options.
              </p>
            </AboutModal>
            <span className="inline-flex w-fit items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1.5 text-xs font-medium text-blue-200">
              <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
              Live on Algorand mainnet
            </span>
          </div>
        </div>
      </div>

      {/* Stats + chart + swap, one unified panel */}
      <Panel className="mb-8">
        <div className="grid grid-cols-2 divide-x divide-y divide-white/10 lg:grid-cols-4 lg:divide-y-0">
          <StatCell label="mUSD Peg" value={`$${pegPrice.toFixed(2)}`} sub="Market Price" accent={underPeg ? "red" : "green"} />
          <StatCell label="Circulating Supply" value={val(stats?.circulating)} sub="Held by Users" accent="purple" />
          <StatCell label="Available USDC" value={val(stats?.psmUsdc)} sub="PSM balance for mUSD swaps" accent="green" />
          <StatCell label="Backing Ratio" value={backing} sub="USDC Reserves" accent={underBacked ? "red" : "green"} />
        </div>

        <div className="border-t border-white/10" />

        <div className="grid lg:grid-cols-5 lg:divide-x lg:divide-white/10">
          <div className="lg:col-span-3">
            <VestigeChart assetId={3615600399} denominatingAssetId={31566704} title="mUSD / USDC Chart" />
          </div>
          <div className="lg:col-span-2">
            <MusdTab />
          </div>
        </div>
      </Panel>

      {/* mUSD liquidity pools */}
      <MusdPoolsSection />
    </>
  );
}
