"use client";

import { useEffect, useState } from "react";
import { Wheat, ArrowUpRight, Info } from "lucide-react";
import { DEX_LABEL, type PoolData } from "@/lib/pools";
import { Panel, PairGlyph } from "@/components/magnetfi/v2/shared";

const fmtUsd = (n: number | null) =>
  n == null ? "—" : n >= 1_000_000 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1_000 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`;
const fmtApr = (n: number | null) => (n == null ? "—" : `${n.toFixed(2)}%`);

function DexBadge({ dex }: { dex: PoolData["dex"] }) {
  return (
    <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[11px] font-medium text-gray-300">
      {DEX_LABEL[dex]}
    </span>
  );
}

function PoolCard({ p }: { p: PoolData }) {
  const farming = p.farmApr != null && p.farmApr > 0;
  return (
    <Panel className="flex flex-col p-6 transition-colors hover:border-magnet-500/30">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <PairGlyph tokens={["mUSD", p.partner]} />
          <div>
            <p className="font-display text-base font-semibold text-white">{p.pair}</p>
            <p className="mt-0.5"><DexBadge dex={p.dex} /></p>
          </div>
        </div>
        {farming && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-green-500/30 bg-green-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-green-300">
            <Wheat className="h-3 w-3" /> Farming
          </span>
        )}
      </div>

      {/* Total APR headline */}
      <div className="rounded-xl border border-white/5 bg-black/30 p-4">
        <p className="text-[11px] uppercase tracking-wider text-gray-500">Total 7-Day APR</p>
        <p className="mt-1 font-mono text-3xl font-bold text-green-400">{fmtApr(p.totalApr)}</p>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-500">
          <span>Swap Fees <span className="font-mono text-gray-300">{fmtApr(p.feeApr)}</span></span>
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

export function MusdPoolsSection() {
  const [pools, setPools] = useState<PoolData[] | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    fetch("/api/musd-pools", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setPools(d.pools))
      .catch(() => setErr(true));
  }, []);

  return (
    <section className="mb-10">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500">mUSD Liquidity Pools</h2>
          <p className="mt-1 text-sm text-gray-400">
            Provide liquidity to <span className="font-semibold text-white">mUSD</span> pools on Algorand
            DEXes to earn trading fees — plus farm rewards whenever incentives are live.
          </p>
        </div>
        <span className="hidden shrink-0 text-xs text-gray-500 sm:inline">Live from Tinyman</span>
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
  );
}
