"use client";

// The chart panel: TradingView's advanced chart, with indicators and drawing
// tools, and PEX's live oracle price kept beside it.
//
// ── Why the PEX price is still here ─────────────────────────────────────────
// Our own chart drew PEX's oracle price as a dashed line ON the candles, so the
// reference price and the price you trade against were visibly two things. The
// widget renders its own feed in its own iframe and cannot carry that overlay,
// so the guard moves outside the chart instead of disappearing.
//
// It is not decoration. The card quotes an EXECUTION price — the oracle index
// plus PEX's impact, which on ALGO is a flat 55 bps step that routinely puts a
// long's entry BELOW the index. A chart quietly disagreeing with the entry
// beside it is the defect class six audits have been chasing, and swapping in a
// third-party chart makes the gap wider, not narrower: TradingView shows
// Coinbase's last trade, PEX prices from its own oracle median.
//
// ── Why our chart is still in the tree ──────────────────────────────────────
// Not as a toggle — as a fallback. Ad blockers routinely block TradingView's
// embed, and a blocked script would otherwise leave a dead panel in the middle
// of the page. If the widget fails to load, the SVG chart renders instead.

import { useEffect, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { getOraclePayload, price12ToUsd } from "@/lib/perpsOracle";
import { PEX_APPS, PEX_MARKETS } from "@/lib/perps";
import { PerpsChart } from "./PerpsChart";

/**
 * TradingView symbols, on the same venue our own chart used.
 *
 * Coinbase rather than Binance: Binance is geo-blocked in some regions (it
 * returns 451 from here), and keeping the venue stable means the widget and the
 * fallback do not show materially different prices.
 */
const SYMBOL: Record<number, string> = {
  [PEX_MARKETS.algoUsd.id]: "COINBASE:ALGOUSD",
  [PEX_MARKETS.btcUsd.id]: "COINBASE:BTCUSD",
};

const SCRIPT_SRC =
  "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
const HEIGHT = 520;

const fmtPrice = (p: number) =>
  p >= 1000 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
  : p >= 1 ? `$${p.toFixed(2)}` : `$${p.toFixed(6)}`;

type Props = { marketId: number; label: string };

export function PerpsChartPanel({ marketId, label }: Props) {
  const holder = useRef<HTMLDivElement>(null);
  const [blocked, setBlocked] = useState(false);

  /** PEX's live index, from the SAME signed payload the card quotes from. */
  const [indexUsd, setIndexUsd] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    setIndexUsd(null);
    const read = () => {
      getOraclePayload(PEX_APPS.trading, marketId)
        .then((o) => { if (alive) setIndexUsd(price12ToUsd(o.indexPrice12)); })
        .catch(() => { /* the panel still renders; only the figure is missing */ });
    };
    read();
    const id = setInterval(read, 10_000);
    return () => { alive = false; clearInterval(id); };
  }, [marketId]);

  useEffect(() => {
    const el = holder.current;
    const symbol = SYMBOL[marketId];
    if (!el || !symbol) return;

    // The embed reads its configuration from the script tag's own text, so the
    // element has to be built by hand rather than rendered.
    el.innerHTML = "";
    const inner = document.createElement("div");
    inner.className = "tradingview-widget-container__widget";
    inner.style.height = `${HEIGHT}px`;
    el.appendChild(inner);

    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.type = "text/javascript";
    script.innerHTML = JSON.stringify({
      symbol,
      interval: "60",
      timezone: "Etc/UTC",
      theme: "dark",
      style: "1",                  // candles
      locale: "en",
      autosize: true,
      // The point of the swap: the drawing palette and the indicator picker.
      hide_side_toolbar: false,
      hide_top_toolbar: false,
      withdateranges: true,
      allow_symbol_change: false,  // the market follows the card, not the widget
      save_image: false,
      backgroundColor: "rgba(0, 0, 0, 0.4)",
      gridColor: "rgba(255, 255, 255, 0.06)",
      support_host: "https://www.tradingview.com",
    });
    // Ad blockers block this embed routinely. A dead panel in the middle of the
    // page is a worse outcome than a simpler chart, so failure falls back.
    script.onerror = () => setBlocked(true);
    el.appendChild(script);

    return () => { el.innerHTML = ""; };
  }, [marketId]);

  if (blocked || !SYMBOL[marketId]) return <PerpsChart marketId={marketId} label={label} />;

  return (
    <div className="rounded-2xl border border-white/10 bg-black/40 p-4 backdrop-blur-sm sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg font-semibold text-white">{label}</h2>

        {/* The number the card actually prices against. Outside the chart now,
            because the widget cannot carry the overlay — but never absent. */}
        <div className="flex items-center gap-2 rounded-lg border border-violet-400/25 bg-violet-500/10 px-3 py-1.5">
          <span className="text-[10px] font-medium uppercase tracking-wide text-violet-200/70">
            PEX oracle
          </span>
          <span className="text-sm font-bold tabular-nums text-violet-100">
            {indexUsd === null ? "…" : fmtPrice(indexUsd)}
          </span>
        </div>
      </div>

      <div className="tradingview-widget-container mt-3 overflow-hidden rounded-xl"
        ref={holder} style={{ height: HEIGHT }} />

      <p className="mt-2 text-[10px] leading-relaxed text-white/30">
        Chart by TradingView, showing Coinbase as a market reference.{" "}
        <span className="text-violet-300/60">PEX oracle</span> above is the price your trade is
        quoted against — it is a different feed and will not match the chart exactly. Your entry
        also includes PEX&apos;s price impact, so it will differ from both.
      </p>
    </div>
  );
}
