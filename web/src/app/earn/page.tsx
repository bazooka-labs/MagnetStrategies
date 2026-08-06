"use client";

import { useEffect, useState } from "react";
import { Sprout, ArrowUpRight, Info } from "lucide-react";
import { DEX_LABEL, type EarnPoolData } from "@/lib/earn";
import { Panel, PairGlyph } from "@/components/magnetfi/v2/shared";

const fmtUsd = (n: number | null) =>
  n == null ? "—" : n >= 1_000_000 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1_000 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`;
const fmtApr = (n: number | null) => (n == null ? "—" : `${n.toFixed(2)}%`);

function DexBadge({ dex }: { dex: EarnPoolData["dex"] }) {
  return (
    <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[11px] font-medium text-gray-300">
      {DEX_LABEL[dex]}
    </span>
  );
}

function PoolCard({ p }: { p: EarnPoolData }) {
  const farming = p.farmApr != null && p.farmApr > 0;
  return (
    <Panel className="flex flex-col p-6 transition-colors hover:border-magnet-500/30">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <PairGlyph tokens={["$U", p.partner]} />
          <div>
            <p className="font-display text-base font-semibold text-white">{p.pair}</p>
            <p className="mt-0.5"><DexBadge dex={p.dex} /></p>
          </div>
        </div>
        {farming && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-green-500/30 bg-green-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-green-300">
            <Sprout className="h-3 w-3" /> Farming
          </span>
        )}
      </div>

      {/* Total APR headline */}
      <div className="rounded-xl border border-white/5 bg-black/30 p-4">
        <p className="text-[11px] uppercase tracking-wider text-gray-500">Total APR</p>
        <p className="mt-1 font-mono text-3xl font-bold text-green-400">{fmtApr(p.totalApr)}</p>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-500">
          <span>Fee <span className="font-mono text-gray-300">{fmtApr(p.feeApr)}</span></span>
          {farming && <span>Farm <span className="font-mono text-green-300">{fmtApr(p.farmApr)}</span></span>}
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between text-sm">
        <span className="text-gray-400">Liquidity</span>
        <span className="font-mono text-white">{fmtUsd(p.tvlUsd)}</span>
      </div>

      <a href={p.addLiquidityUrl} target="_blank" rel="noopener noreferrer"
        className="mt-5 inline-flex w-fit items-center gap-1.5 text-sm font-semibold text-magnet-300 transition-colors hover:text-magnet-200">
        Add liquidity on {DEX_LABEL[p.dex]} <ArrowUpRight className="h-3.5 w-3.5" />
      </a>
    </Panel>
  );
}

export default function EarnPage() {
  const [pools, setPools] = useState<EarnPoolData[] | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    fetch("/api/earn/pools")
      .then((r) => r.json())
      .then((d) => setPools(d.pools))
      .catch(() => setErr(true));
  }, []);

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      {/* Hero */}
      <div className="relative mb-8 overflow-hidden rounded-2xl border border-white/10 bg-black/40 px-6 py-8 backdrop-blur-sm sm:px-10 sm:py-10">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-magnet-500/60 to-transparent" />
        <div className="animate-blob-drift pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-magnet-600/20 blur-3xl" />
        <div className="relative flex items-center gap-4">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-magnet-600 to-magnet-800 text-white shadow-lg shadow-magnet-900/50">
            <Sprout className="h-7 w-7" />
          </div>
          <div>
            <h1 className="magnet-glow-soft font-display text-3xl font-bold text-white sm:text-4xl">Earn</h1>
            <p className="mt-1 max-w-2xl text-sm text-gray-300">
              Provide liquidity to <span className="font-semibold text-white">$U</span> pools on Tinyman and Pact to
              earn trading fees — plus farm rewards whenever incentives are live. APRs update in real time.
            </p>
          </div>
        </div>
      </div>

      {/* Pools */}
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500">$U Liquidity Pools</h2>
          <span className="text-xs text-gray-500">Live from Tinyman &amp; Pact</span>
        </div>

        {err ? (
          <Panel className="p-8 text-center"><p className="text-sm text-gray-400">Couldn&apos;t load pool data. Try refreshing.</p></Panel>
        ) : !pools ? (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => <div key={i} className="h-56 rounded-2xl border border-white/10 bg-black/40 animate-pulse" />)}
          </div>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {[...pools].sort((a, b) => (b.totalApr ?? -1) - (a.totalApr ?? -1)).map((p) => <PoolCard key={p.id} p={p} />)}
          </div>
        )}

        <p className="mt-5 flex items-start gap-2 text-xs text-gray-500">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          A <span className="font-medium text-gray-400">Farming</span> badge appears whenever a pool has an active
          rewards program — these vary over time and are pulled live, so no pool ever shows a stale incentive.
          Liquidity is added directly on the DEX.
        </p>
      </section>
    </div>
  );
}
