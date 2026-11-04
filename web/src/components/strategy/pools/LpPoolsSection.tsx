"use client";

/**
 * The $U liquidity pools on Tinyman and Pact.
 *
 * ── Why this lives under `strategy/pools/` ─────────────────────────────────
 * It rendered on the Tokens page until 2026-11-04 and moved to Strategy,
 * under the "Liquidity Pools" pill, beside the vaults. The file moved with
 * it: a component in `components/tokens/` that renders only on Strategy is
 * the exact trap CLAUDE.md records under "deliberate oddities", where
 * `StrategySplash` once lived in `liquidity/` and `TradeSplash` in
 * `strategy/`, each named for the page the other directory served.
 *
 * ── What it is NOT ─────────────────────────────────────────────────────────
 * Named `LpPoolsSection`, not `PoolsSection`, because `strategy/pools/`
 * already means PEX's perpetual-market pools — the C-Vault and the direct
 * market pools. These are DEX liquidity pools for the $U token on third-party
 * AMMs, which is a different thing that happens to share the word.
 */

import { useEffect, useState } from "react";
import { Wheat, ArrowUpRight, Info } from "lucide-react";
import { DEX_LABEL, type PoolData, type PoolDex } from "@/lib/pools";
import { MAGNET_GLOW, Panel, PairGlyph } from "@/components/magnetfi/v2/shared";

const fmtUsd = (n: number | null) =>
  n == null ? "—" : n >= 1_000_000 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1_000 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`;
const fmtApr = (n: number | null) => (n == null ? "—" : `${n.toFixed(2)}%`);

function DexBadge({ dex }: { dex: PoolDex }) {
  return (
    <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[11px] font-medium text-gray-300">
      {DEX_LABEL[dex]}
    </span>
  );
}

function PoolCard({ p }: { p: PoolData }) {
  // A farm can be live without a rate: Pact computes farm APR against what is
  // staked, so a funded farm nobody has staked into yet reports 0. Those are
  // precisely the pools worth staking into, so the badge follows farmLive and
  // the rate is shown only when there is one.
  const farmRate = p.farmApr != null && p.farmApr > 0;
  const farming = p.farmLive || farmRate;
  return (
    /*
      The shared magnet-400 neon, the same ring-plus-shadow every other card
      on the site carries — the vaults, the MagnetFi collateral cards and the
      Trade terminal. These pools arrived from the Tokens page without it and
      read as a different product beside the vault they now sit next to.

      `MAGNET_GLOW` rather than a copy of its values: it was tuned against the
      red a stale card carries, and a second set of numbers would drift from
      the rest of the site the first time either moved.
    */
    <Panel className={`animate-enter-1 hover-depth flex flex-col p-6 ${MAGNET_GLOW}`}>
      <div className="mb-5 flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <PairGlyph tokens={["$U", p.partner]} />
          <div>
            <p className="font-display text-base font-semibold text-white">{p.pair}</p>
            <p className="mt-0.5 flex flex-wrap gap-1.5">
              {p.venues.map((v) => <DexBadge key={v.dex} dex={v.dex} />)}
            </p>
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
          {/* Only when there is a rate to quote. The badge above already says a
              farm exists; a second element repeating that in words added length
              without information, and it was the first thing to wrap awkwardly
              on a phone. */}
          {farmRate && <span>Farm <span className="font-mono text-green-300">{fmtApr(p.farmApr)}</span></span>}
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between text-sm">
        <span className="text-gray-400">Liquidity</span>
        <span className="font-mono text-white">{fmtUsd(p.tvlUsd)}</span>
      </div>

      {/* Per-venue split, only when the pair runs in more than one place.
          The blended headline above is what a dollar earns across the pair; this
          is where it earns it, which is the number someone choosing a venue
          needs. Measured 2026-10-10 the two U/ALGO pools paid 3.69% and 0.42% —
          an 8.8x gap that a single averaged figure would have hidden. */}
      {p.venues.length > 1 && (
        <div className="mt-4 space-y-1.5 border-t border-white/5 pt-3">
          {p.venueData.map((v) => (
            <div key={v.dex} className="flex items-center justify-between text-xs">
              <span className="text-gray-500">{DEX_LABEL[v.dex]}</span>
              <span className="flex items-baseline gap-2">
                <span className="font-mono text-gray-400">{fmtUsd(v.tvlUsd)}</span>
                <span className="font-mono text-green-400/80">{fmtApr(v.totalApr)}</span>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-5 flex flex-col gap-2">
        {p.venues.map((v) => (
          <a key={v.dex} href={v.addLiquidityUrl} target="_blank" rel="noopener noreferrer"
            className="inline-flex w-fit items-center gap-1.5 text-sm font-semibold text-magnet-300 transition-colors hover:text-magnet-200">
            Add liquidity on {DEX_LABEL[v.dex]} <ArrowUpRight className="h-3.5 w-3.5" />
          </a>
        ))}
      </div>
    </Panel>
  );
}

export function LpPoolsSection() {
  const [pools, setPools] = useState<PoolData[] | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    fetch("/api/pools", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setPools(d.pools))
      .catch(() => setErr(true));
  }, []);

  return (
    <section className="mb-10">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500">$U Liquidity Pools</h2>
          <p className="mt-1 text-sm text-gray-400">
            Provide liquidity to <span className="font-semibold text-white">$U</span> pools on Tinyman and
            Pact to earn trading fees — plus farm rewards whenever incentives are live.
          </p>
        </div>
        <span className="hidden shrink-0 text-xs text-gray-500 sm:inline">Live from Tinyman &amp; Pact</span>
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

      {/* The icon row is the flex container; the copy is a single <p> inside it.
          Previously the <p> itself was the flex container, which made every
          child its own flex item — so "Farming" was pulled out of the sentence
          into its own gapped column and the rest wrapped beside it as a second
          column. It read as a label with a paragraph hanging off it rather than
          as one sentence. */}
      <div className="mt-5 flex items-start gap-2 text-xs text-gray-500">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <p>
          <span className="font-medium text-gray-400">Farming</span> badge indicates a farm is currently live for
          the associated liquidity pool. Farm pools pay reward incentives on top of swap fees.
        </p>
      </div>
    </section>
  );
}
