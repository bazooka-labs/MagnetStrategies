"use client";

// The Trading Terminal tab. Hero block mirrors MagnetTokenView so the arm reads as part of the
// same product family — same rounded-2xl panel, hairline, drifting blob, display
// face and status pill.

"use client";

import { useMemo, useState } from "react";
import type { CardOverlay } from "@/components/strategy/perps/PerpsCard";
import type { PositionLine } from "@/components/strategy/perps/PositionsPanel";
import dynamic from "next/dynamic";
import { ACTIVE_MARKET_ID, PEX_MARKETS } from "@/lib/strategy/pex/config";
import { heldLineQualifiers } from "@/lib/strategy/perps/positionLines";
import { Panel, MAGNET_GLOW } from "@/components/magnetfi/v2/shared";

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
     * Labels are qualified only as far as it takes to tell them apart — the
     * rule, and why it has three cases rather than two, lives in
     * `heldLineQualifiers` beside its tests.
     */
    const held = positionLines.filter((l) => l.marketId === marketId);
    const qualifiers = heldLineQualifiers(held);
    for (const [i, l] of held.entries()) {
      const who = qualifiers[i];
      add(l.entryPrice12, `Your ${who}entry`, "#e5e7eb", "");
      /*
       * The liquidation level is drawn only when it is a BOUNDARY AHEAD of the
       * price — two conditions, both from PEX rather than inferred here.
       *
       * `liquidatableNow` means the position is already inside the liquidatable
       * region, and the figure returned is then that region's far edge: on a
       * long it sits ABOVE the index while still labelled `at_or_below`. Drawn,
       * it is a solid red "Your liquidation" line in the PROFIT direction on a
       * position a keeper can close out now.
       *
       * The direction check is the belt: a long liquidates at or below, a short
       * at or above. It is also what finally makes `liquidationDirection` a
       * read field — it was carried and never read, which is the shape of audit
       * 10's first ship blocker.
       */
      const ahead = l.side === "long" ? "at_or_below" : "at_or_above";
      if (!l.liquidatableNow && l.liquidationDirection === ahead) {
        add(l.liquidationPrice12, `Your ${who}liquidation`, "#f87171", "");
      }
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

        One control survives it. "Live on MainNet" went: a status badge styled
        as a pill sat beside a button styled as a pill, so the clickable thing
        and the label looked alike — the same confusion the token headers had —
        and the terminal showing live prices already says it is live.
      */}
      {/*
        The "More info" trigger moved INTO the card on 2026-11-08.
        ──────────────────────────────────────────────────────────────────────
        It was the last thing in this file's own markup: one button, right
        aligned, alone in a full-width row above the card, with 58px of empty
        page between the two. Nothing anchored it — the page header that used
        to sit beside it had been removed, and the button was left behind
        holding the space on its own.

        It now rides at the end of the chart panel's control row, where the
        market pills, the chart toggle and the timeframes already live, so it
        reads as part of the terminal rather than as something floating above
        it. The card starts 58px higher as a result.

        The state stays here. `PerpsInfoModal` is a sibling of the card, not a
        child of the chart panel, so the panel gets a callback and nothing
        else — moving the modal down into the panel would put a dialog about
        the whole product inside the component that draws candles.
      */}

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
      {/* Same MAGNET_GLOW the C-Vault card and the MagnetFi vault cards carry,
          so the three arms read as one product. It REPLACES the Panel's default
          drop shadow rather than stacking — that default sets
          --tw-shadow-color: black, which would recolour the glow to black if
          it were passed through className. */}
      <Panel glowClass={MAGNET_GLOW}>
        <PerpsChartPanel marketId={marketId} label={market?.label ?? ""}
          onMarketChange={setMarketId} lines={lines} busy={busy} onInfo={() => setInfoOpen(true)}
          indexUsd={overlay?.indexPrice12 ? Number(overlay.indexPrice12) / 1e12 : null} />
        <PerpsCard marketId={marketId} onMarketChange={setMarketId}
          onOverlayChange={setOverlay} onBusyChange={setBusy} />
        <PositionsPanel onLinesChange={setPositionLines} />
      </Panel>
      <PerpsInfoModal open={infoOpen} onClose={() => setInfoOpen(false)} />
    </>
  );
}
