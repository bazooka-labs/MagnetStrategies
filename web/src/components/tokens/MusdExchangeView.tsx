"use client";

/**
 * The Exchange pill, stripped to the trade (2026-11-07).
 *
 * ── Why this is not `MusdTokenView` with flags ───────────────────────────
 * Both pills rendered the same view with one prop different, so switching
 * between them changed a direction badge and a button label and nothing
 * else — the hero, the About paragraph and five stat boxes were identical.
 * A reader could switch and not notice they had.
 *
 * Mint is the mUSD landing page: what the stablecoin is, what backs it, how
 * it is doing. Exchange is one job — see the peg, make the trade — so it is
 * the chart and the swap panel, and no page header at all: the swap panel's
 * own heading is the page's title. See the note where that header used to be.
 *
 * A separate component rather than `showHero` / `showStats` / `showAbout`
 * booleans. Three flags is eight states, of which two are ever rendered,
 * and the other six are a config surface nobody checks. The genuinely
 * shared parts are one line each (`VestigeChart`, `MusdTab`), so there is
 * almost nothing to hoist.
 *
 * ── Two figures it keeps that a bare chart would not ─────────────────────
 * The peg, because the chart shows where the peg has BEEN and this tab is
 * for acting on where it is now.
 *
 * The PSM reserve lives in `MusdTab`'s summary rather than here — the
 * number was already fetched there for the `lowReserve` guard, and it is
 * the ceiling on a redemption. See the note at that row.
 */

import dynamic from "next/dynamic";
import { MAGNET_GLOW, Panel } from "@/components/magnetfi/v2/shared";
import { VestigeChart } from "@/components/VestigeChart";

const pulse = () => <div className="h-96 rounded-2xl border border-white/10 bg-black/40 animate-pulse" />;

const MusdTab = dynamic(
  () => import("@/components/magnetfi/v2/MusdTab").then((m) => m.MusdTab),
  { ssr: false, loading: pulse },
);

export function MusdExchangeView({ marketPrice }: { marketPrice: number | null }) {
  return (
    <Panel glowClass={MAGNET_GLOW} className="animate-enter mb-8">
      {/* The header came out on 2026-11-08. It had been stripped to a bare
          "Exchange mUSD" — no mark, no strapline — which left it saying
          exactly what the swap card's own heading says, eight lines below
          and in the same words. Two titles for one short page.

          The card's heading won because it is the one with something
          attached to it: the strapline and the peg square are laid out
          around it. So the title moved down rather than away, and it
          carries `headingAs="h1"` — this page has no other heading, and
          dropping the `<h1>` outright would have left it with none. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="animate-blob-drift absolute -right-16 -top-16 h-56 w-56 rounded-full bg-magnet-600/20 blur-3xl" />
      </div>

      {/* Same split and the same chart padding as the Mint view, so the two
          tabs sit at the same rhythm even though one is much shorter. */}
      <div className="relative grid lg:grid-cols-5 lg:divide-x lg:divide-white/10">
        <div className="lg:col-span-3 p-4 sm:p-5">
          <div className="overflow-hidden rounded-xl">
            <VestigeChart assetId={3615600399} denominatingAssetId={31566704} title="mUSD / USDC Chart" />
          </div>
        </div>
        <div className="lg:col-span-2 lg:flex lg:flex-col lg:justify-center">
          <MusdTab
            fixed="redeem"
            headingAs="h1"
            subtitle="Swap mUSD back to USDC through the Peg Stability Module, 1:1 redemption rate less the transaction fee."
            peg={marketPrice}
          />
        </div>
      </div>
    </Panel>
  );
}
