import dynamic from "next/dynamic";
import Image from "next/image";
import { MAGNET_GLOW, Panel } from "@/components/magnetfi/v2/shared";
import { VestigeChart } from "@/components/VestigeChart";
import { TvlRankStat } from "@/components/TvlRankStat";
import { StatCell } from "@/components/tokens/StatCell";
import type { MagnetYtd } from "@/lib/tokenStats";

const pulse = () => <div className="h-64 rounded-2xl border border-white/10 bg-black/40 animate-pulse" />;

const HaystackSwap = dynamic(
  () => import("@/components/HaystackSwap").then((m) => m.HaystackSwap),
  { ssr: false, loading: pulse }
);

export function MagnetTokenView({
  holders,
  price,
  tvl,
  ytd,
}: {
  holders: string;
  price: string;
  tvl: string;
  /** Null when Vestige could not be read — the cell shows a dash, not a zero. */
  ytd: MagnetYtd | null;
}) {
  const since = ytd
    ? ytd.since.toLocaleDateString("en-US", {
        month: "short", day: "numeric", timeZone: "UTC",
      })
    : null;
  return (
    <>
      {/*
        ── One card, since 2026-11-07 ────────────────────────────────────────
        The hero and the stats panel were two stacked blocks with IDENTICAL
        chrome: same `rounded-2xl`, same `border-white/10`, same
        `bg-black/40 backdrop-blur-sm`, and each drew its own top hairline. It
        was the same card rendered twice with a gap between, which is what made
        the page read as a header bolted onto a widget rather than one object.

        Merged, `Panel` supplies all of that once and the glow wraps the whole
        thing. The header is now a padded section inside it, divided from the
        stats by a hairline rather than by empty page.

        ── The padding had to come down with it ──
        It was `py-8 sm:py-10`, sized for a card standing on its own. Inside
        the merged card that read as a tall empty strip above a dense row of
        stat cells, with the title floating in the middle of it. `py-5 sm:py-6`
        puts the title band in proportion with the cells beneath. Both were
        rasterised and compared before choosing.

        ── Known trade-off, accepted ──
        The merged card is long: on a desktop viewport its bottom edge — and
        so the bottom of the glow — sits below the fold, where two shorter
        blocks each closed on screen. That is inherent to merging them, not a
        spacing bug, and is not worth "fixing" by shrinking the chart.
      */}
      <Panel glowClass={MAGNET_GLOW} className="animate-enter mb-8">
      <div className="relative px-6 py-5 sm:px-10 sm:py-6">
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="animate-blob-drift absolute -right-16 -top-16 h-56 w-56 rounded-full bg-magnet-600/20 blur-3xl" />
        </div>

        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <div className="h-14 w-14 shrink-0 overflow-hidden rounded-2xl shadow-lg shadow-magnet-900/50">
              {/* No scale. The 1.2x zoom was there to make the OLD mark — a small glyph on
                  a padded canvas — fill this tile. The ASA artwork is framed to its own
                  edges, so the same zoom clipped the magnet's feet. */}
              <Image src="/tokens/u.png" alt="$U" width={56} height={56} className="h-full w-full object-cover" priority />
            </div>
            <div>
              {/* One step up from `text-3xl sm:text-4xl` on 2026-11-07.

                  It now heads a card roughly twice as tall, and a title sized
                  for the old standalone hero read small against it. This is
                  deliberately LARGER than the mUSD hero's h1, which still
                  carries 3xl/4xl and heads a card of the original height —
                  the two are on different pages and sized to what each one
                  actually caps. */}
              <h1 className="font-display magnet-glow-soft text-4xl font-bold text-white sm:text-5xl">
                Magnet Token
              </h1>
              {/* MOCKUP 2026-11-07. Was "Built to compound liquidity across
                  Algorand DeFi." — accurate but generic, and it read like a
                  tagline on a page that now sits inside the Strategy arm.
                  $U was the first product; the line says so. */}
              <p className="mt-1 max-w-xl text-sm text-gray-300">
                The Original Strategy.
              </p>
            </div>
          </div>

          {/* A right-aligned column, holding one pill today.

              It was three — a mainnet status badge, About $U, and
              LiveProposalsPill — and three in a ROW crowded the mark at tablet
              width and wrapped unpredictably, which is why it is a column. The
              status badge went some time ago and the proposals pill moved to
              the mUSD hero on 2026-11-07.

              Kept as a column rather than collapsed: it gains a second pill
              again the moment anything else belongs here. See the note at the
              foot of this file. */}
        </div>

        {/* MOCKUP 2026-11-07: the About modal, opened out onto the page.

            Same amber frame the modal used — `border-amber-400/25` on the
            solid `#0b0b0d` surface — so it still reads as the same object,
            just no longer behind a button. Solid rather than the site's
            translucent panel for the reason AboutModal records: an animated
            field runs behind every route, and body copy being read is the one
            place that motion is not ambience.

            Sits between the subheader and the metric row, so the page reads
            name → what it is → how it is doing. */}
        <div className="relative mt-5 overflow-hidden rounded-2xl border border-amber-400/25 bg-[#0b0b0d] p-5 sm:p-6">
          <h2 className="font-display text-lg font-semibold text-amber-200">What is $U?</h2>
          <div className="mt-3 space-y-3 text-sm leading-relaxed text-gray-400">
            <p>
              Magnet token ($U) is the native asset of Magnet Strategies, an Algorand DeFi
              organization, with the goal of outperforming a simple ALGO holding over time.
              Launched in June 2025, $U has a fixed supply of 750,000 tokens (ASA ID:{" "}
              <span className="font-mono text-gray-300">3081853135</span>).
            </p>
            <p>
              $U is positioned to capture the broader Algorand market through its strategic LP
              pairings, as well as earn yield across additional DeFi strategies like node
              staking rewards. Track Magnet&apos;s performance below and decide if you&apos;d
              like to add $U to your Algorand portfolio using our swap tooling provided by
              TxnLab.
            </p>
          </div>
        </div>
      </div>

        <div className="border-t border-white/10" />

        {/* Five across on desktop. On two columns the fifth would sit alone in a
            half-width cell with a hanging divider, so it spans the row — a
            deliberate last-row rule, not a gap. */}
        <div className="grid grid-cols-2 divide-x divide-y divide-white/10 lg:grid-cols-5 lg:divide-y-0">
          <StatCell label="Price" value={price} sub="USDC" tone="green" />
          <StatCell label="Holders" value={holders} sub="Active wallets" tone="amber" />
          <StatCell label="Total TVL" value={tvl} sub="$U pools on Tinyman & Pact" tone="teal" />
          <TvlRankStat />
          {/*
            ── Treasury left this row on 2026-11-07, YTD took its place ─────
            The treasury figure is still on the mUSD page, which is where it
            belongs: it is USDC available for liquidity, a fact about the
            protocol's balance sheet rather than about $U.

            What a reader of THIS page wants is whether the thing has worked,
            and the protocol's stated goal is to beat holding vanilla ALGO —
            so the figure is in ALGO, not dollars. A dollar return would read
            as a gain in a month when ALGO itself rose further, which is
            exactly when this number most needs to be honest.

            The sub-line carries the arithmetic rather than a sentence under
            it: "1.4015 → 1.4716" is a measurement showing its own basis,
            where "+5.00%" alone is a claim.
          */}
          <div className="col-span-2 lg:col-span-1">
            <StatCell
              label="YTD vs ALGO"
              value={ytd ? `${ytd.pct >= 0 ? "+" : ""}${ytd.pct.toFixed(2)}%` : "—"}
              sub={ytd
                ? `${ytd.base.toFixed(4)} → ${ytd.now.toFixed(4)} ALGO since ${since}`
                : "Couldn't read the price history"}
              tone={ytd && ytd.pct < 0 ? "red" : "green"}
            />
          </div>
        </div>

        <div className="border-t border-white/10" />

        {/* ── The chart gets its own padding, since 2026-11-07 ───────────
            The iframe sat flush against the card: its dark body met the
            card's border on the left and bottom with no gap, so the two
            edges read as one smudged line rather than as a chart inside a
            card. Every other block in this card is inset — the header by
            `px-6 py-5`, the stat cells by `p-5`, the swap by its own `p-5` —
            and the chart was the only one that was not.

            `rounded-xl overflow-hidden` as well as the padding: once inset,
            a hard-cornered rectangle inside a `rounded-2xl` card is the next
            thing that looks unfinished. */}
        <div className="grid lg:grid-cols-5 lg:divide-x lg:divide-white/10">
          <div className="lg:col-span-3 p-4 sm:p-5">
            <div className="overflow-hidden rounded-xl">
              <VestigeChart assetId={3081853135} denominatingAssetId={0} title="Magnet ($U) / ALGO Chart" />
            </div>
          </div>
          <div className="lg:col-span-2">
            <HaystackSwap />
          </div>
        </div>
      </Panel>

      {/*
        ── Two things left this view on 2026-11-04 ─────────────────────────────
        The $U liquidity pools moved to the Strategy page's "Liquidity Pools"
        pill, beside the vaults: providing liquidity is a strategy, and this
        view is about the token itself. See
        components/strategy/pools/LpPoolsSection.tsx.

        Governance moved the other way, to /tokens behind the mUSD page's
        "Governance" pill, and the contract moved with it: mVote locks mUSD and
        UVote is retired. A vote no longer concerns a $U holder as such.

        ── `LiveProposalsPill` followed it on 2026-11-07 ──────────────────────
        It stayed here for three days on a discovery argument: a visitor to
        this hero is a protocol participant, and the pill was the only standing
        pointer to an open vote. That was the right call while governance had
        no live proposal to point at and this page had the most traffic.

        With mVote's first proposal open the argument flips. Voting is weighted
        by mUSD, so the holder who can act on the pill is the one reading the
        mUSD hero — and the pill now sits there, beside "About mUSD", one pill
        away from the Governance tab it opens rather than one page away.

        Nothing replaces either one here. A stub reading "governance moved" is a
        navigational dead end dressed as content, and a pointer whose audience
        is on another page is close to the same thing.
      */}
    </>
  );
}
