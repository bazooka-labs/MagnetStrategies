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
import { ENABLED_MARKET_IDS, PEX_APPS, PEX_MARKETS } from "@/lib/perps";
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

/**
 * Simple vs Advanced.
 *
 * Named for what the user gets, not for which library renders it: "Advanced"
 * buys indicators and drawing tools and costs the position lines, because a
 * third-party iframe cannot be told where your liquidation price is.
 */
function ViewToggle({ advanced, onChange }: { advanced: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.02] p-0.5">
      {([["Position lines", false], ["Drawing tools", true]] as const).map(([text, v]) => (
        <button key={text} onClick={() => onChange(v)}
          className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
            advanced === v ? "bg-white/10 text-white" : "text-white/40 hover:text-white/70"}`}>
          {text}
        </button>
      ))}
    </div>
  );
}

const SCRIPT_SRC =
  "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
/**
 * The chart's height in pixels, passed to the widget EXPLICITLY.
 *
 * `autosize: true` defers sizing to whatever the embed decides the container
 * is, and two attempts at feeding it the right container both came out
 * pancaked. An explicit `height` is deterministic: the widget builds its iframe
 * at exactly this many pixels and nothing has to agree about anything.
 *
 * The container is therefore NOT given a fixed height — it wraps whatever the
 * widget produces, plus the ~32px copyright strip the embed appends. Forcing a
 * height on it as well is what left the iframe fighting a box that was already
 * constrained.
 */
const HEIGHT = 560;

const fmtPrice = (p: number) =>
  p >= 1000 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
  : p >= 1 ? `$${p.toFixed(2)}` : `$${p.toFixed(6)}`;

const MARKETS = Object.values(PEX_MARKETS).filter((m) => ENABLED_MARKET_IDS.includes(m.id));

/**
 * The market toggle, shared by both branches.
 *
 * It has to be reachable on the fallback path too: the card no longer carries a
 * selector, so a blocked TradingView script would otherwise leave the user with
 * no way to switch markets at all.
 */
function MarketToggle({ marketId, onChange }: { marketId: number; onChange: (id: number) => void }) {
  return (
    <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-white/[0.02] p-1">
      {MARKETS.map((m) => {
        const on = m.id === marketId;
        return (
          <button key={m.id} onClick={() => onChange(m.id)}
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
              on ? "bg-magnet-500/20 text-white" : "text-white/45 hover:text-white/75"}`}>
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

type Props = {
  marketId: number;
  label: string;
  onMarketChange: (id: number) => void;
  /** Entry, liquidation and take-profit, as the card quotes them. */
  lines?: { price: number; label: string; colour: string; dash: string }[];
};

export function PerpsChartPanel({ marketId, label, onMarketChange, lines = [] }: Props) {
  /**
   * Which chart is showing.
   *
   * These are not interchangeable and the choice is a real one. TradingView has
   * the indicator library and the drawing palette; it is an iframe rendering
   * its own feed, so it cannot draw OUR prices — the embed exposes no runtime
   * API and no price-line configuration.
   *
   * Our chart can draw them, because we own every pixel: entry, liquidation,
   * take-profit and the PEX oracle, all on the candles.
   *
   * The advanced chart is the default: indicators and drawing tools are the
   * reason it is here, and the position lines it cannot draw are all still
   * readable on the card itself.
   */
  const [advanced, setAdvanced] = useState(true);
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
    // Deliberately unsized: the widget sets the iframe from the config below.
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
      // Explicit rather than autosize — see HEIGHT.
      autosize: false,
      width: "100%",
      height: HEIGHT,
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

  // Our chart when chosen, and whenever TradingView is unavailable.
  if (!advanced || blocked || !SYMBOL[marketId]) {
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <MarketToggle marketId={marketId} onChange={onMarketChange} />
          {!blocked && SYMBOL[marketId] && (
            <ViewToggle advanced={false} onChange={setAdvanced} />
          )}
        </div>
        <PerpsChart marketId={marketId} label={label} lines={lines} />
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-black/40 p-4 backdrop-blur-sm sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Market toggle. It lives here rather than in the card because the
            chart is what it most obviously governs — and because the card and
            the chart must never disagree about which market is shown. */}
        <MarketToggle marketId={marketId} onChange={onMarketChange} />

        <ViewToggle advanced onChange={setAdvanced} />

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

      {/* No fixed height: the widget sizes its own iframe, and constraining the
          wrapper as well is what squashed it. `minHeight` only reserves space
          so the page does not jump while the script loads. */}
      <div className="tradingview-widget-container mt-3 overflow-hidden rounded-xl"
        ref={holder} style={{ minHeight: HEIGHT, width: "100%" }} />

      <p className="mt-2 text-[10px] leading-relaxed text-white/30">
        Chart by TradingView, showing Coinbase as a market reference.{" "}
        <span className="text-violet-300/60">PEX oracle</span> above is the price your trade is
        quoted against — it is a different feed and will not match the chart exactly. Your entry
        also includes PEX&apos;s price impact, so it will differ from both.
      </p>
    </div>
  );
}
