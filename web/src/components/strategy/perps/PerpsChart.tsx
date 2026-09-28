"use client";

// Price history beside the trade card.
//
// Hand-rolled SVG rather than a charting library: this needs a line, a fill and
// a marker, and the page is deliberately lean. A dependency for that would cost
// bundle size and supply-chain surface for no capability we use.
//
// ── The one thing this component must not do ────────────────────────────────
// It must not let the reference price be mistaken for the price you trade at.
// The card quotes an EXECUTION price — the oracle index plus PEX's impact,
// which on ALGO is a flat 55 bps step that routinely puts a long's entry below
// the index. So PEX's live index is drawn ON the chart, labelled, and the
// source of the history is named underneath. Two prices, visibly two.

import { useEffect, useMemo, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { getOraclePayload, price12ToUsd } from "@/lib/perpsOracle";
import { PEX_APPS } from "@/lib/perps";
import {
  ChartUnavailableError, changePct, fetchCandles,
  type Candle, type ChartRange,
} from "@/lib/perpsChart";

const RANGES: ChartRange[] = ["24h", "7d"];

const fmtPrice = (p: number) =>
  p >= 1000 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
  : p >= 1 ? `$${p.toFixed(2)}` : `$${p.toFixed(6)}`;

type Props = {
  marketId: number;
  label: string;
};

const W = 600;
const H = 200;
const PAD = { top: 12, right: 52, bottom: 18, left: 8 };

export function PerpsChart({ marketId, label }: Props) {
  const [range, setRange] = useState<ChartRange>("24h");
  /**
   * PEX's live index, read from the SAME signed payload the card quotes from.
   *
   * Deliberately not a prop and deliberately not the unsigned `latest-prices`
   * convenience bundle: the dashed line's whole job is to be the number the
   * trade is priced against, and sourcing it from anywhere else would let it
   * drift from the card by exactly the amount nobody would notice.
   *
   * This is one small fetch, not the card's six box reads.
   */
  const [indexUsd, setIndexUsd] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    setIndexUsd(null);
    const read = () => {
      getOraclePayload(PEX_APPS.trading, marketId)
        .then((o) => { if (alive) setIndexUsd(price12ToUsd(o.indexPrice12)); })
        .catch(() => { /* the chart still renders; only the marker is missing */ });
    };
    read();
    const id = setInterval(read, 10_000);
    return () => { alive = false; clearInterval(id); };
  }, [marketId]);
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setCandles(null);
    setError(null);
    fetchCandles(marketId, range)
      .then((c) => { if (alive) setCandles(c); })
      .catch((e) => {
        if (!alive) return;
        setError(e instanceof ChartUnavailableError ? e.message : String(e));
      });
    // Refreshed on an interval deliberately longer than the card's: this is
    // context, and a candle bucket does not close more often than this anyway.
    const id = setInterval(() => {
      fetchCandles(marketId, range)
        .then((c) => { if (alive) setCandles(c); })
        .catch(() => { /* keep the last good series rather than blanking */ });
    }, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, [marketId, range]);

  const geom = useMemo(() => {
    if (!candles || candles.length < 2) return null;
    const lows = candles.map((c) => c.l);
    const highs = candles.map((c) => c.h);
    // Include the live index in the scale, so the marker can never fall outside
    // the plot and silently disappear.
    let min = Math.min(...lows, indexUsd ?? Infinity);
    let max = Math.max(...highs, indexUsd ?? -Infinity);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
      const base = candles[candles.length - 1].c;
      min = base * 0.995; max = base * 1.005;
    }
    const padY = (max - min) * 0.08;
    min -= padY; max += padY;

    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const x = (i: number) => PAD.left + (i / (candles.length - 1)) * innerW;
    const y = (v: number) => PAD.top + (1 - (v - min) / (max - min)) * innerH;

    const line = candles.map((c, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(c.c).toFixed(2)}`).join("");
    const area = `${line}L${x(candles.length - 1).toFixed(2)},${(H - PAD.bottom).toFixed(2)}`
      + `L${x(0).toFixed(2)},${(H - PAD.bottom).toFixed(2)}Z`;
    return { line, area, y, min, max, innerW };
  }, [candles, indexUsd]);

  const change = candles ? changePct(candles) : null;
  const up = (change ?? 0) >= 0;
  const stroke = up ? "#4ade80" : "#f87171";

  return (
    <div className="rounded-2xl border border-white/10 bg-black/40 p-4 backdrop-blur-sm sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2 className="font-display text-base font-semibold text-white">{label}</h2>
          {change !== null && (
            <span className={`text-xs font-medium tabular-nums ${up ? "text-green-300" : "text-red-300"}`}>
              {up ? "+" : ""}{change.toFixed(2)}% · {range}
            </span>
          )}
        </div>
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <button key={r} onClick={() => setRange(r)}
              className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                r === range ? "bg-white/10 text-white" : "text-white/40 hover:text-white/70"}`}>
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3">
        {error && (
          <div className="flex h-[200px] items-center justify-center rounded-xl border border-white/5 bg-white/[0.02]">
            <p className="flex items-center gap-2 px-4 text-center text-xs text-white/40">
              <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
              Price history is unavailable right now. This does not affect trading.
            </p>
          </div>
        )}
        {!error && !geom && (
          <div className="h-[200px] animate-pulse rounded-xl border border-white/5 bg-white/[0.02]" />
        )}
        {!error && geom && (
          <svg viewBox={`0 0 ${W} ${H}`} className="h-[200px] w-full" preserveAspectRatio="none"
            role="img" aria-label={`${label} price, last ${range}`}>
            <defs>
              <linearGradient id={`fill-${marketId}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
                <stop offset="100%" stopColor={stroke} stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={geom.area} fill={`url(#fill-${marketId})`} />
            <path d={geom.line} fill="none" stroke={stroke} strokeWidth="1.5"
              vectorEffect="non-scaling-stroke" strokeLinejoin="round" />

            {/* PEX's live index — the number the card actually quotes from.
                Drawn on top so the reference series cannot be read as it. */}
            {indexUsd !== null && (
              <g>
                <line x1={PAD.left} x2={W - PAD.right} y1={geom.y(indexUsd)} y2={geom.y(indexUsd)}
                  stroke="#c4b5fd" strokeWidth="1" strokeDasharray="3 3"
                  vectorEffect="non-scaling-stroke" opacity="0.75" />
                <text x={W - PAD.right + 6} y={geom.y(indexUsd) + 3.5}
                  fill="#c4b5fd" fontSize="10" fontFamily="ui-monospace, monospace">
                  {fmtPrice(indexUsd)}
                </text>
              </g>
            )}
          </svg>
        )}
      </div>

      {/* Naming both prices, because they are not the same price. */}
      <p className="mt-2 text-[10px] leading-relaxed text-white/30">
        History from Coinbase as a market reference.{" "}
        <span className="text-violet-300/60">Dashed line</span> is PEX&apos;s live oracle price, which is
        what your trade is quoted against — your entry also includes PEX&apos;s price impact, so it
        will differ from both.
      </p>
    </div>
  );
}
