"use client";

// The Trading Terminal tab. Hero block mirrors MagnetTokenView so the arm reads as part of the
// same product family — same rounded-2xl panel, hairline, drifting blob, display
// face and status pill.

"use client";

import { useMemo, useState } from "react";
import type { CardOverlay } from "@/components/strategy/perps/PerpsCard";
import type { PositionLine } from "@/components/strategy/perps/PositionsPanel";
import dynamic from "next/dynamic";
import { Info } from "lucide-react";
import { ACTIVE_MARKET_ID, PEX_MARKETS } from "@/lib/perps";
import { Panel } from "@/components/magnetfi/v2/shared";

// Sized and shaped like the section it replaces — no border or background of
// its own, because the Panel around it already draws those.
const pulse = () => <div className="m-5 h-[560px] rounded-xl bg-white/5 animate-pulse sm:m-6" />;

// Pulls in @pdex/sdk and algosdk — keep it off the server and out of the
// initial bundle.
const PerpsCard = dynamic(
  () => import("@/components/strategy/perps/PerpsCard").then((m) => m.PerpsCard),
  { ssr: false, loading: pulse },
);

// Also client-only: it reads chain state for the connected wallet.
const PositionsPanel = dynamic(
  () => import("@/components/strategy/perps/PositionsPanel").then((m) => m.PositionsPanel),
  { ssr: false },
);

const PerpsInfoModal = dynamic(
  () => import("@/components/strategy/perps/PerpsInfoModal").then((m) => m.PerpsInfoModal),
  { ssr: false },
);

const PerpsChartPanel = dynamic(
  () => import("@/components/strategy/perps/PerpsChartPanel").then((m) => m.PerpsChartPanel),
  // Section-shaped, like the card's pulse: no border or background, because
  // the Panel around it draws those.
  { ssr: false, loading: () => <div className="m-4 h-[600px] rounded-xl bg-white/5 animate-pulse sm:m-5" /> },
);

export function PerpsView() {
  /**
   * Lifted so the chart and the card cannot disagree about which market is
   * being shown. The card keeps its own fallback state for standalone use.
   */
  const [marketId, setMarketId] = useState<number>(ACTIVE_MARKET_ID);
  const [infoOpen, setInfoOpen] = useState(false);
  /**
   * The card's quoted prices, for the chart to draw.
   *
   * The card owns these numbers and reports them; the chart never derives its
   * own. Two components computing an entry or liquidation price separately is
   * how they come to disagree, and disagreeing about a liquidation price is not
   * a cosmetic failure.
   */
  const [overlay, setOverlay] = useState<CardOverlay | null>(null);
  /**
   * Lifted for the same reason `marketId` is: the market toggle sits in the
   * chart panel, and while a signature is in flight it must not move. See
   * `PerpsChartPanel`'s `busy` prop.
   */
  const [busy, setBusy] = useState(false);
  /**
   * Levels of the positions actually HELD, reported by the positions panel.
   *
   * Separate from `overlay`, which is the order being composed. Keeping them
   * apart is the whole fix: the chart's entry and liquidation lines used to
   * come from the card's prospective quote, so a page refresh — which clears
   * the collateral field by design — left the quote null and took the lines
   * with it. A held position's levels do not depend on anything being typed.
   */
  const [positionLines, setPositionLines] = useState<PositionLine[]>([]);

  const lines = useMemo(() => {
    const out: { price: number; label: string; colour: string; dash: string }[] = [];
    const add = (p: bigint | null, label: string, colour: string, dash: string) => {
      if (p !== null && p > BigInt(0)) out.push({ price: Number(p) / 1e12, label, colour, dash });
    };

    /*
     * HELD first, and drawn SOLID.
     *
     * These are positions with money in them; the composer's lines describe an
     * order that does not exist yet. Solid versus dashed is the distinction,
     * and it survives both being on screen at once — which happens whenever
     * someone sizes a second order while already holding one.
     *
     * Named by side only when both sides are held in this market, which is
     * possible on PEX and would otherwise produce two identical labels.
     */
    const held = positionLines.filter((l) => l.marketId === marketId);
    const bothSides = held.length > 1;
    for (const l of held) {
      const who = bothSides ? `${l.side} ` : "";
      add(l.entryPrice12, `Your ${who}entry`, "#e5e7eb", "");
      add(l.liquidationPrice12, `Your ${who}liquidation`, "#f87171", "");
    }

    // The order being composed, dashed. Same colours the card uses for the
    // same concepts.
    if (overlay) {
      add(overlay.entryPrice12, "Entry", "#e5e7eb", "5 4");
      add(overlay.liquidationPrice12, "Liquidation", "#f87171", "2 3");
      add(overlay.takeProfitPrice12, "Take profit", "#4ade80", "6 4");
      add(overlay.stopLossPrice12, "Stop", "#fbbf24", "2 3");
    }
    return out;
  }, [overlay, positionLines, marketId]);
  const market = Object.values(PEX_MARKETS).find((m) => m.id === marketId);

  return (
    <>
      {/*
        No page header here.
        ──────────────────────────────────────────────────────────────────────
        It carried the Magnet mark, "Trading Terminal" and a line describing
        what the product does. The arrival splash now says all three, a beat
        earlier and at full attention, so repeating them in a card the user
        scrolls past is the chrome that makes a product feel like a brochure.

        What was load-bearing in it were the two controls, and they keep their
        colours: teal for live status, amber for the thing that opens the risk
        disclosure. Right-aligned, out of the reading path, and a quiet top edge
        rather than a full-width card competing with the terminal under it.
      */}
      <div className="mb-6 flex flex-wrap items-center justify-end gap-2">
        <span className="inline-flex w-fit items-center gap-2 rounded-full border border-teal-500/30 bg-teal-500/10 px-3 py-1.5 text-xs font-medium text-teal-200">
          <span className="h-1.5 w-1.5 rounded-full bg-teal-400 animate-pulse" />
          Live on MainNet
        </span>

        {/* Amber, matching the risk warnings it opens. A help-link grey would
            read as optional; this is where "you can lose everything you put in"
            lives, and it is now the only route to it — so it had to stay a pill
            and stay visible rather than becoming a footnote. */}
        <button onClick={() => setInfoOpen(true)} aria-haspopup="dialog"
          className="inline-flex w-fit items-center gap-2 rounded-full border border-amber-400/30 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-200 transition-colors hover:border-amber-400/50 hover:bg-amber-500/15 hover:text-amber-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500">
          <Info className="h-3.5 w-3.5" />
          More info
        </button>
      </div>

      {/* ONE box. The chart, the order form and what you already hold are a
          single card divided by seams, not three panels stacked with 24px of
          page showing between them — which read as three unrelated products.
          Reading the market, opening a position and watching it are one
          activity, and the chart is the context every number in the form is
          read against, so it leads.

          The Panel carries no padding: each section supplies its own, so the
          seams can run edge to edge. Each section draws the seam ABOVE itself,
          which is what lets `PositionsPanel` take its rule with it when no
          wallet is connected. */}
      <Panel>
        <PerpsChartPanel marketId={marketId} label={market?.label ?? ""}
          onMarketChange={setMarketId} lines={lines} busy={busy}
          indexUsd={overlay?.indexPrice12 ? Number(overlay.indexPrice12) / 1e12 : null} />
        <PerpsCard marketId={marketId} onMarketChange={setMarketId}
          onOverlayChange={setOverlay} onBusyChange={setBusy} />
        <PositionsPanel onLinesChange={setPositionLines} />
      </Panel>
      <PerpsInfoModal open={infoOpen} onClose={() => setInfoOpen(false)} />
    </>
  );
}
