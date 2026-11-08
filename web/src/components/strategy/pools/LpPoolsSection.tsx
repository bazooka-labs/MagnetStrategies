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
import { Blocks, Wheat, ArrowUpRight, Info } from "lucide-react";
import { DEX_LABEL, type PoolData, type PoolDex } from "@/lib/pools";
import { ALGO_GLOW, MAGNET_GLOW, Panel, PairGlyph } from "@/components/magnetfi/v2/shared";
import { SectionHero } from "@/components/magnetfi/v2/SectionHero";
import { MusdPoolsSection } from "@/components/tokens/MusdPoolsSection";

const fmtUsd = (n: number | null) =>
  n == null ? "—" : n >= 1_000_000 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1_000 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`;
const fmtApr = (n: number | null) => (n == null ? "—" : `${n.toFixed(2)}%`);

/**
 * The shared shape of a status badge, so the two are a matched set.
 *
 * They stack on the same card — tALGO is liquid staking AND farming — and two
 * pills of different sizes above one another reads as a mistake.
 *
 * Sized down from `text-[11px] px-2.5 gap-1.5`, which made "Liquid Staking"
 * 115px wide and left the pair name 79px against the 80px it needed. The
 * header is a fixed two-column squeeze, so the budget was the real problem:
 * at the old size a single extra character in any pool name wrapped the
 * title. 10px type and tighter padding buys the title back about 18px, which
 * is room for a name, not just for this one.
 */
const BADGE =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full border "
  + "px-2 py-0.5 text-[10px] font-semibold";

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
      The shared neon, the same ring-plus-shadow every other card on the site
      carries — the vaults, the MagnetFi collateral cards, the Trade terminal.
      These pools arrived from the Tokens page without it and read as a
      different product beside the vault they now sit next to.

      ── Through `glowClass`, NOT `className` ──
      Panel's default shadow includes `shadow-black/40`, which sets
      `--tw-shadow-color` and recolours any shadow arriving via `className`
      to black. The glow then shows as its ring alone: a thin neon border
      with no halo. Panel's own doc comment warns about this and says it is
      how the prop first shipped; it is also how THIS first shipped, one
      commit ago, until the border-with-no-glow was spotted on the page.

      Gold for the ALGO-family pool, purple for the rest — the same split
      MagnetFi draws between its ALGO/USDC vault and the $U ones. Read off
      the pool, so this knows about an ACCENT, not about a pool id.
    */
    <Panel
      /*
        No `hover-depth` here, deliberately.

        That utility sets `box-shadow` on hover, and a box-shadow REPLACES
        rather than adds — so hovering swapped the neon glow below for a dim
        purple-and-black shadow. It read as the card darkening under the
        pointer, which is the opposite of what a hover usually signals, and it
        undid the one thing these cards are styled for.

        The glow is constant now. These cards are not buttons — the actual
        control is the "Add liquidity" link inside each one, which has its own
        hover state — so the card never needed a pointer affordance of its own.
      */
      className="animate-enter-1 flex flex-col p-6"
      glowClass={p.accent === "gold" ? ALGO_GLOW : MAGNET_GLOW}
    >
      <div className="mb-5 flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <PairGlyph tokens={["$U", p.partner]} />
          <div>
            {/* `whitespace-nowrap`: a pair name is one label and must never
                split. "U / uALGO" needs 80px and had 79, so it broke into
                "U /" over "uALGO" while "U / tALGO" at 76 fit — two cards of
                the same kind, side by side, laid out differently over one
                pixel. `U / FOLKS` at 78 was a character away from the same. */}
            <p className="whitespace-nowrap font-display text-base font-semibold text-white">{p.pair}</p>
            <p className="mt-0.5 flex flex-wrap gap-1.5">
              {p.venues.map((v) => <DexBadge key={v.dex} dex={v.dex} />)}
            </p>
          </div>
        </div>
        {/*
          Two badges can be true at once, so they live in a wrapping column
          rather than as one element pinned to the right.

          uALGO is the case: its Tinyman farm starts next month, at which
          point it is both liquid staking AND farming. A single right-hand
          slot would have had them fighting over it — and at 360px a row of
          two would push the pair name into a second line.

          Amber for liquid staking, matching the gold glow these two cards
          carry, and distinct from the green that means "a farm is paying".
          The two badges answer different questions: one is what the pool IS,
          the other is what it is doing this week.
        */}
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {p.liquidStaking && (
            <span className={`${BADGE} border-amber-400/30 bg-amber-400/10 text-amber-200`}>
              <Blocks className="h-3 w-3" /> Liquid Staking
            </span>
          )}
          {farming && (
            <span className={`${BADGE} border-green-500/30 bg-green-500/10 text-green-300`}>
              <Wheat className="h-3 w-3" /> Farming
            </span>
          )}
        </div>
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
        {/*
          Inside the rate box, because it is about the rate.

          A pool pinned to the front with "—" where its APR should be reads as
          a broken card, and nothing else here can say why: the figure is
          absent precisely because the pool has no history yet. Amber rather
          than grey so it registers as a note about this number, not as more
          small print.
        */}
        {p.note && (
          <p className="mt-2.5 border-t border-white/5 pt-2.5 text-[11px] leading-relaxed text-amber-200/70">
            {p.note}
          </p>
        )}
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
      {/*
        ── The Finance page's section header, reused ─────────────────────────
        This was a 12px uppercase label with a paragraph under it — the kind
        of heading that reads as a caption on a list rather than as the top of
        a section. The Bank's vault pages have carried a proper hero since
        `SectionHero` was extracted, and the note on that component is the
        argument: two hand-built header rows with different title weights and
        description colours are what made one page look unfinished beside the
        other.

        Imported rather than copied, for the same reason it was extracted.
        `SectionHero` renders an `h1`; this tab has no other, and the pills
        are mutually exclusive so only one tab's heading is ever in the
        document.
      */}
      {/* "Liquidity Pools", not "$U Liquidity Pools", since 2026-11-07: the
          mUSD pools moved here from the mUSD page and the heading now covers
          both assets. */}
      <SectionHero
        title="Liquidity Pools"
        description={<>
          Provide liquidity to <span className="font-semibold text-white">$U</span> and{" "}
          <span className="font-semibold text-white">mUSD</span> pools on Tinyman and Pact to
          earn trading fees — plus farm rewards whenever incentives are live.
        </>}
      >
        {/* A label, not an action — the slot is for things you can do, and
            this is the one thing worth saying beside the title: the figures
            below are live reads, not a published table. */}
        <span className="text-xs text-gray-500">Live from Tinyman &amp; Pact</span>
      </SectionHero>

      {/* Each group gets a quiet label now that there are two of them under
          one hero. The pair names make the split obvious — "U / X" against
          "mUSD / USDC" — but a reader scrolling should not have to infer a
          section boundary from the contents of the cards. */}
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
        $U pools
      </h2>

      {err ? (
        <Panel className="p-8 text-center"><p className="text-sm text-gray-400">Couldn&apos;t load pool data. Try refreshing.</p></Panel>
      ) : !pools ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => <div key={i} className="h-56 rounded-2xl border border-white/10 bg-black/40 animate-pulse" />)}
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {/*
            Featured first, then by rate.

            The sort is by APR descending, which puts a pool with no fee
            history LAST — so a pool on the day it opens, which is exactly
            when it is worth showing, sorts to the bottom. `featured` is the
            editorial override; everything else keeps the old ordering.
          */}
          {[...pools]
            .sort((a, b) => (Number(b.featured ?? false) - Number(a.featured ?? false))
              || ((b.totalApr ?? -1) - (a.totalApr ?? -1)))
            .map((p) => <PoolCard key={p.id} p={p} />)}
        </div>
      )}

      {/* The mUSD pools, moved here from the mUSD page. Embedded, so it
          contributes a group heading and a grid rather than its own hero and
          its own copy of the legend below. */}
      <div className="mt-8">
        <MusdPoolsSection embedded />
      </div>

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
          the associated liquidity pool. Farm pools pay reward incentives on top of swap fees.{" "}
          <span className="font-medium text-gray-400">Liquid Staking</span> marks a pool whose other side is
          ALGO staked for consensus through a third party — tALGO on Tinyman, uALGO on Myth Finance — so the
          position carries that protocol&apos;s risk as well as the pool&apos;s.
        </p>
      </div>
    </section>
  );
}
