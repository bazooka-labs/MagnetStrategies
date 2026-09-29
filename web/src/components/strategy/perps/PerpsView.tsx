"use client";

// Perps tab. Hero block mirrors MagnetTokenView so the arm reads as part of the
// same product family — same rounded-2xl panel, hairline, drifting blob, display
// face and status pill.

"use client";

import { useMemo, useState } from "react";
import type { CardOverlay } from "@/components/strategy/perps/PerpsCard";
import dynamic from "next/dynamic";
import { Info } from "lucide-react";
import Image from "next/image";
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

  const lines = useMemo(() => {
    if (!overlay) return [];
    const out: { price: number; label: string; colour: string; dash: string }[] = [];
    const add = (p: bigint | null, label: string, colour: string, dash: string) => {
      if (p !== null && p > BigInt(0)) out.push({ price: Number(p) / 1e12, label, colour, dash });
    };
    // Same colours the card uses for the same concepts.
    add(overlay.entryPrice12, "Entry", "#e5e7eb", "5 4");
    add(overlay.liquidationPrice12, "Liquidation", "#f87171", "2 3");
    add(overlay.takeProfitPrice12, "Take profit", "#4ade80", "6 4");
    add(overlay.stopLossPrice12, "Stop", "#fbbf24", "2 3");
    return out;
  }, [overlay]);
  const market = Object.values(PEX_MARKETS).find((m) => m.id === marketId);

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
              <Image
                src="/magnet-icon.png" alt="" width={56} height={56}
                className="h-full w-full object-cover" priority
              />
            </div>
            <div>
              <h1 className="font-display magnet-glow-soft text-3xl font-bold text-white sm:text-4xl">
                Perps
              </h1>
              <p className="mt-1 max-w-xl text-sm text-gray-300">
                Go long or short on {Object.values(PEX_MARKETS).map((m) => m.label.split("/")[0]).join(" and ")} with
                leverage. Pick a direction, an amount and a target — then sign once.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <span className="inline-flex w-fit items-center gap-2 rounded-full border border-green-500/30 bg-green-500/10 px-3 py-1.5 text-xs font-medium text-green-200">
              <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse" />
              Live on MainNet
            </span>

            {/* Amber, matching the risk warnings it opens. A help-link grey
                would read as optional; this is where "you can lose everything
                you put in" now lives. */}
            <button onClick={() => setInfoOpen(true)}
              className="inline-flex w-fit items-center gap-2 rounded-full border border-amber-400/30 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-200 transition-colors hover:border-amber-400/50 hover:bg-amber-500/15">
              <Info className="h-3.5 w-3.5" />
              More info
            </button>
          </div>
        </div>
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
          onMarketChange={setMarketId} lines={lines} busy={busy} />
        <PerpsCard marketId={marketId} onMarketChange={setMarketId}
          onOverlayChange={setOverlay} onBusyChange={setBusy} />
        <PositionsPanel />
      </Panel>
      <PerpsInfoModal open={infoOpen} onClose={() => setInfoOpen(false)} />
    </>
  );
}
