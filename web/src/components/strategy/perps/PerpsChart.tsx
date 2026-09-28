"use client";

// Price history, as the page's centrepiece.
//
// Hand-rolled SVG rather than a charting library. This needs candles, axes, a
// crosshair and a readout; `lightweight-charts` would add ~45 kB gzipped to a
// 99 kB page for that plus zoom, pan and drawing tools — capability that fights
// a product whose whole thesis is "not a trading terminal". If indicators or
// drawings are ever wanted, that is when a library earns its weight.
//
// ── The one thing this component must not do ────────────────────────────────
// It must not let the reference price be mistaken for the price you trade at.
// The card quotes an EXECUTION price — the oracle index plus PEX's impact,
// which on ALGO is a flat 55 bps step that routinely puts a long's entry below
// the index. So PEX's live index is drawn ON the chart, labelled, and the
// history's source is named underneath. Two prices, visibly two.
//
// ── Why it measures its own width ───────────────────────────────────────────
// The first version used `preserveAspectRatio="none"`, which stretches the
// viewBox to the container and distorts everything non-uniformly. That is
// survivable for a line and wrong for a crosshair: mapping a pointer position
// back to a candle needs the rendered geometry to match the drawn geometry.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { getOraclePayload, price12ToUsd } from "@/lib/perpsOracle";
import { PEX_APPS } from "@/lib/perps";
import {
  CHART_RANGES, ChartUnavailableError, candleInterval, changePct, fetchCandles,
  rangeGranularity, rangeLabel,
  type Candle, type ChartRange,
} from "@/lib/perpsChart";

const UP = "#4ade80";
const DOWN = "#f87171";
const INDEX_COLOUR = "#c4b5fd";

const H = 380;
const PAD = { top: 16, right: 64, bottom: 28, left: 12 };

const fmtPrice = (p: number) =>
  p >= 1000 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
  : p >= 1 ? `$${p.toFixed(2)}` : `$${p.toFixed(6)}`;

/** Axis labels want fewer digits than a quote does. */
const fmtAxis = (p: number) =>
  p >= 1000 ? p.toLocaleString("en-US", { maximumFractionDigits: 0 })
  : p >= 1 ? p.toFixed(2) : p.toFixed(5);

/**
 * Axis labels: enough to place a candle in the span, not enough to clutter.
 *
 * A week of hourly candles wants dates across the bottom; four hours of 5m
 * candles wants clock times.
 */
const fmtAxisTime = (t: number, range: ChartRange) => {
  const d = new Date(t * 1000);
  return rangeGranularity(range) >= 3600 && range === "1w"
    ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
};

/**
 * The readout must identify the exact candle under the cursor.
 *
 * The axis formatter was doing both jobs, which meant hovering an HOURLY candle
 * on the 1W chart showed only "Sep 25" — no hour, on a bar that covers one. A
 * label that cannot distinguish a candle from its twenty-three neighbours is
 * not a label for that candle.
 */
const fmtReadoutTime = (t: number, range: ChartRange) => {
  const d = new Date(t * 1000);
  const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  // Anything spanning more than a day needs the date to be unambiguous.
  return range === "1w" || range === "24h"
    ? `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time}`
    : time;
};

/**
 * A price line drawn across the chart.
 *
 * Colours are the card's: red for liquidation, green for take-profit, so the
 * chart and the card say the same thing in the same language.
 */
type PriceLine = { price: number; label: string; colour: string; dash: string };

type Props = {
  marketId: number;
  label: string;
  /** Entry, liquidation, take-profit and stop-loss, as the card quotes them. */
  lines?: PriceLine[];
};

export function PerpsChart({ marketId, label, lines = [] }: Props) {
  const [range, setRange] = useState<ChartRange>("24h");
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  /** Drives the grab cursor; a ref alone would not re-render to show it. */
  const [dragging, setDragging] = useState(false);
  /**
   * Vertical zoom, as a divisor on the auto-fitted price range.
   *
   * 1 is "fit everything". Above 1 the visible range shrinks, so the same price
   * move covers more pixels — candles get taller and small moves become
   * readable. Dragging the price axis changes it, which is the gesture people
   * already know from every trading chart.
   *
   * Clamped both ways: far enough in to read a tick, not so far out that the
   * series becomes a flat line.
   */
  const [zoom, setZoom] = useState(1);
  const drag = useRef<{ y: number; zoom: number } | null>(null);

  /**
   * The visible slice of the series: how many candles, ending where.
   *
   * `span` null means "all of them" — the default, and what a range button
   * resets to. Narrowing it is the horizontal counterpart of the price zoom:
   * fewer candles across the same width means each one is wider, which is how
   * you get a handful of bars to actually fill the chart.
   *
   * `end` is an index into the full series, so panning is just moving it.
   */
  /**
   * How far the visible price range is shifted from its auto fit, in price.
   *
   * Zero fits the data. Non-zero lets the view move past the series' own high
   * and low — which is the point: a take-profit above every candle drawn, or a
   * liquidation below them, is exactly the level worth looking at, and with a
   * pure auto-fit it can only ever sit pinned to the edge.
   *
   * Held in price units rather than pixels so it stays meaningful when the
   * zoom or the data changes underneath it.
   */
  const [priceOffset, setPriceOffset] = useState(0);
  const [span, setSpan] = useState<number | null>(null);
  const [end, setEnd] = useState<number | null>(null);
  const pan = useRef<{ x: number; y: number; end: number; offset: number } | null>(null);
  /** Time-axis drag: the horizontal counterpart of the price-axis drag. */
  const timeDrag = useRef<{ x: number; span: number; end: number } | null>(null);

  /** The candles actually drawn, and where the slice starts in the full array. */
  const visible = useMemo(() => {
    if (!candles) return null;
    if (span === null) return { rows: candles, from: 0 };
    const last = Math.min(candles.length - 1, end ?? candles.length - 1);
    const from = Math.max(0, last - span + 1);
    return { rows: candles.slice(from, last + 1), from };
  }, [candles, span, end]);
  /** 0 until measured — `geom` is null anyway until candles arrive. */
  const [width, setWidth] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Real pixel width, so pointer position maps back to a candle exactly.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    // Whole pixels only. Sub-pixel churn re-runs the geometry on every frame,
    // and a panel that resizes in response can feed itself a ResizeObserver
    // loop — which is one of the ways this flickered.
    const ro = new ResizeObserver(([e]) => {
      const w = Math.max(280, Math.round(e.contentRect.width));
      setWidth((prev) => (prev === w ? prev : w));
    });
    ro.observe(el);
    setWidth(Math.max(280, el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);

  /**
   * PEX's live index, from the SAME signed payload the card quotes from.
   *
   * Deliberately not the unsigned `latest-prices` bundle: this line's whole job
   * is to be the number the trade is priced against, and sourcing it elsewhere
   * would let it drift from the card by exactly the amount nobody would notice.
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

  useEffect(() => {
    let alive = true;
    setCandles(null);
    setError(null);
    setHover(null);
    // A zoom or a window fitted to one series means nothing against another.
    setZoom(1);
    setSpan(null);
    setEnd(null);
    setPriceOffset(0);
    const load = (first: boolean) => {
      fetchCandles(marketId, range)
        .then((c) => { if (alive) setCandles(c); })
        .catch((e) => {
          // Keep the last good series on a refresh failure rather than blanking.
          if (alive && first) setError(e instanceof ChartUnavailableError ? e.message : String(e));
        });
    };
    load(true);
    const id = setInterval(() => load(false), 60_000);
    return () => { alive = false; clearInterval(id); };
  }, [marketId, range]);

  const geom = useMemo(() => {
    const candles = visible?.rows;
    if (!candles || candles.length < 2 || width <= 0) return null;
    // Every drawn line is included in the scale, or a liquidation far below the
    // visible range would silently fall outside the plot — which is the one
    // line a user most needs to see the distance to.
    const drawn = lines.map((l) => l.price).filter((v) => Number.isFinite(v));
    let min = Math.min(...candles.map((c) => c.l), indexUsd ?? Infinity, ...drawn);
    let max = Math.max(...candles.map((c) => c.h), indexUsd ?? -Infinity, ...drawn);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
      const base = candles[candles.length - 1].c;
      min = base * 0.995; max = base * 1.005;
    }
    const padY = (max - min) * 0.08;
    min -= padY; max += padY;

    // Zoom around the LAST CLOSE rather than the midpoint: the current price is
    // what a trader is reading against, and anchoring there keeps it on screen
    // however far in you go. A midpoint anchor drifts it off the top or bottom.
    if (zoom !== 1) {
      const anchor = candles[candles.length - 1].c;
      min = anchor - (anchor - min) / zoom;
      max = anchor + (max - anchor) / zoom;
    }
    // Then shift the whole window. Applied after the zoom so dragging moves by
    // the same number of pixels however far in you are.
    min += priceOffset; max += priceOffset;

    const innerW = width - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const y = (v: number) => PAD.top + (1 - (v - min) / (max - min)) * innerH;
    const slot = innerW / candles.length;
    const bodyW = Math.max(slot * 0.62, 1);
    const cx = (i: number) => PAD.left + slot * (i + 0.5);

    const bars = candles.map((c, i) => {
      const top = y(Math.max(c.o, c.c));
      const bottom = y(Math.min(c.o, c.c));
      return {
        cx: cx(i), up: c.c >= c.o,
        wickTop: y(c.h), wickBottom: y(c.l),
        bodyY: top,
        // A doji would otherwise be a zero-height rect — invisible, leaving a
        // bare wick that reads as a rendering fault.
        bodyH: Math.max(bottom - top, 1),
      };
    });

    // Four gridlines is enough to read a level without becoming a ledger.
    const ticks = Array.from({ length: 5 }, (_, i) => min + ((max - min) * i) / 4);
    return { bars, bodyW, y, cx, min, max, innerW, innerH, slot, ticks };
  }, [visible, indexUsd, width, lines, zoom, priceOffset]);

  const onMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    // A drag on the price axis owns the pointer until it is released.
    if (timeDrag.current && candles && geom) {
      const total = candles.length;
      // Drag right to pull the bars apart — fewer visible, each wider. 420px is
      // one doubling, matching the price axis so both handles feel the same.
      const dx = e.clientX - timeDrag.current.x;
      const next = Math.round(timeDrag.current.span / Math.pow(2, dx / 420));
      const clamped = Math.min(total, Math.max(10, next));
      // Anchored on the right edge: the latest candle stays put, which is what
      // you are usually reading against.
      setSpan(clamped === total ? null : clamped);
      setEnd(clamped === total ? null : timeDrag.current.end);
      return;
    }
    if (pan.current && geom && candles) {
      // Vertical: drag down and the content follows, which means the visible
      // price window moves up. Converted through the current scale so a pixel
      // of movement is a pixel of movement at any zoom.
      const dy = e.clientY - pan.current.y;
      const perPixel = (geom.max - geom.min) / geom.innerH;
      setPriceOffset(pan.current.offset + dy * perPixel);

      // Horizontal: whole candles, so the series never lands between slots and
      // shimmers. Only when a window is actually set — at full span there is
      // nothing to scroll through.
      if (span !== null) {
        const moved = Math.round((pan.current.x - e.clientX) / geom.slot);
        const target = pan.current.end + moved;
        setEnd(Math.min(candles.length - 1, Math.max(span - 1, target)));
      }
      return;
    }
    if (drag.current) {
      const dy = drag.current.y - e.clientY;
      // Up zooms in. 420px of travel is one doubling — 180 made a small wrist
      // movement jump several steps, which is unusable for fine adjustment.
      const next = drag.current.zoom * Math.pow(2, dy / 420);
      setZoom(Math.min(40, Math.max(0.35, next)));
      return;
    }
    if (!geom || !visible) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const i = Math.floor((x - PAD.left) / geom.slot);
    setHover(i >= 0 && i < (visible?.rows.length ?? 0) ? i : null);
  }, [geom, visible, candles, span]);

  const endDrag = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    setDragging(false);
    if (!drag.current && !pan.current && !timeDrag.current) return;
    drag.current = null;
    pan.current = null;
    timeDrag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }, []);

  /**
   * Wheel over the plot zooms horizontally, anchored under the cursor.
   *
   * Anchoring matters: zooming toward the middle drags whatever you were
   * looking at off to one side, so you end up chasing it. Keeping the candle
   * under the pointer fixed is what makes this feel like magnifying rather than
   * scrolling.
   */
  const onWheel = useCallback((e: WheelEvent) => {
    if (!candles || !geom || !visible) return;
    // Non-passive, so this actually stops the page scrolling underneath.
    e.preventDefault();
    const total = candles.length;
    const current = span ?? total;
    // 8% per notch rather than 20%: a trackpad sends many small events and a
    // fifth of the window per event made it impossible to land anywhere.
    const step = Math.pow(1.08, e.deltaY > 0 ? 1 : -1);
    const next = Math.round(current * step);
    // Rounding can stall on small windows — force at least one candle of change.
    const moved = next === current ? current + (e.deltaY > 0 ? 1 : -1) : next;
    // Ten candles is about as far in as stays legible; the whole series is as
    // far out as there is anything to show.
    const clamped = Math.min(total, Math.max(10, moved));
    if (clamped === current) return;

    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left - PAD.left) / geom.innerW));
    const underCursor = visible.from + Math.round(frac * (visible.rows.length - 1));
    const newLast = Math.round(underCursor + (1 - frac) * (clamped - 1));
    setSpan(clamped === total ? null : clamped);
    setEnd(clamped === total ? null : Math.min(total - 1, Math.max(clamped - 1, newLast)));
  }, [candles, geom, visible, span]);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  const change = candles ? changePct(candles) : null;
  const up = (change ?? 0) >= 0;
  const rows = visible?.rows ?? null;
  const active = hover !== null && rows ? rows[hover] : null;
  /**
   * The headline price is ALWAYS the latest in the series.
   *
   * It used to switch to whatever was hovered, which made the largest number on
   * the panel change under the cursor — and because the OHLC row only existed
   * while hovering, the header grew and shrank with it and the whole panel
   * jumped. The hovered values belong in the readout row, which is now always
   * present, so nothing reflows.
   */
  const headline = candles ? candles[candles.length - 1] : null;
  /** Hovered candle when there is one, otherwise the latest — never absent. */
  const readout = active ?? headline;

  return (
    <div className="rounded-2xl border border-white/10 bg-black/40 p-4 backdrop-blur-sm sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-baseline gap-2.5">
            <h2 className="font-display text-lg font-semibold text-white">{label}</h2>
            {headline && (
              <span className="font-display text-lg font-bold tabular-nums text-white">
                {fmtPrice(headline.c)}
              </span>
            )}
            {change !== null && (
              <span className={`text-xs font-medium tabular-nums ${up ? "text-green-300" : "text-red-300"}`}>
                {up ? "+" : ""}{change.toFixed(2)}%
              </span>
            )}
            {/* A 1W chart is built from HOURLY candles. Without this the bars
                read as days and every one of them is misinterpreted. */}
            <span className="text-[11px] text-white/35">{candleInterval(range)} candles</span>
          </div>
          {/* Always rendered, so hovering cannot change the header's height.
              Showing the latest candle when nothing is hovered is more useful
              than a blank row of the same size. */}
          <div className="mt-1 flex h-4 flex-wrap items-center gap-x-3 text-[11px] tabular-nums text-white/45">
            {readout && (
              <>
                <span>{fmtReadoutTime(readout.t, range)}</span>
                <span>O <span className="text-white/70">{fmtAxis(readout.o)}</span></span>
                <span>H <span className="text-white/70">{fmtAxis(readout.h)}</span></span>
                <span>L <span className="text-white/70">{fmtAxis(readout.l)}</span></span>
                <span>C <span className={readout.c >= readout.o ? "text-green-300" : "text-red-300"}>{fmtAxis(readout.c)}</span></span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {(zoom !== 1 || span !== null || priceOffset !== 0) && (
            <button onClick={() => { setZoom(1); setSpan(null); setEnd(null); setPriceOffset(0); }}
              title="Reset the price scale and the visible range"
              className="mr-1 rounded-md bg-white/[0.06] px-2 py-1 text-[11px] font-medium text-white/60 transition-colors hover:text-white/90">
              reset
            </button>
          )}
          {CHART_RANGES.map((r) => (
            <button key={r} onClick={() => setRange(r)}
              className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                r === range ? "bg-white/10 text-white" : "text-white/40 hover:text-white/70"}`}>
              {rangeLabel(r)}
            </button>
          ))}
        </div>
      </div>

      {/* overflow-hidden because the svg is sized in real pixels from a
          measurement: between a container resize and the next render it can
          briefly be wider than its parent, and on a phone that would show up
          as horizontal page scroll. */}
      <div ref={boxRef} className="mt-3 overflow-hidden">
        {error && (
          <div className="flex items-center justify-center rounded-xl border border-white/5 bg-white/[0.02]"
            style={{ height: H }}>
            <p className="flex items-center gap-2 px-4 text-center text-xs text-white/40">
              <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
              Price history is unavailable right now. This does not affect trading.
            </p>
          </div>
        )}
        {!error && !geom && (
          <div className="animate-pulse rounded-xl border border-white/5 bg-white/[0.02]" style={{ height: H }} />
        )}
        {!error && geom && candles && (
          /* touch-pan-y, deliberately: the browser keeps vertical touch
             gestures so the page still scrolls past a full-width chart, and
             horizontal ones come to us for panning. Vertical chart panning is
             mouse and trackpad only — trapping page scroll on a phone is a
             worse trade than losing one gesture. */
          <svg ref={svgRef} width={width} height={H}
            style={{ cursor: dragging ? "grabbing" : "crosshair" }}
            className="touch-pan-y select-none"
            onPointerMove={onMove}
            onPointerDown={(e) => {
              // The price axis strip has its own handler and stops propagation
              // there, so a pointer down reaching the svg is over the plot.
              if (!candles || !visible) return;
              pan.current = {
                x: e.clientX, y: e.clientY,
                end: visible.from + visible.rows.length - 1,
                offset: priceOffset,
              };
              e.currentTarget.setPointerCapture?.(e.pointerId);
              setDragging(true);
            }}
            onPointerUp={endDrag} onPointerCancel={endDrag}
            onPointerLeave={(e) => { endDrag(e); setHover(null); }}
            onDoubleClick={() => { setSpan(null); setEnd(null); setZoom(1); setPriceOffset(0); }}
            role="img" aria-label={`${label} price candles, last ${rangeLabel(range)}`}>
            <defs>
              {/* Zoomed candles must not paint over the axis or escape the
                  panel. Everything price-scaled is drawn inside this. */}
              <clipPath id={`plot-${marketId}`}>
                <rect x={PAD.left} y={PAD.top}
                  width={Math.max(0, width - PAD.left - PAD.right)}
                  height={H - PAD.top - PAD.bottom} />
              </clipPath>
            </defs>
            {/* Gridlines and price axis */}
            {geom.ticks.map((v, i) => (
              <g key={i}>
                <line x1={PAD.left} x2={width - PAD.right} y1={geom.y(v)} y2={geom.y(v)}
                  stroke="#ffffff" strokeOpacity="0.05" strokeWidth="1" />
                <text x={width - PAD.right + 8} y={geom.y(v) + 3.5}
                  fill="#ffffff" fillOpacity="0.3" fontSize="10"
                  fontFamily="ui-monospace, monospace">{fmtAxis(v)}</text>
              </g>
            ))}

            {/* Candles. No per-bar dimming on hover: tying every candle's
                opacity to `hover` re-rendered all of them on every pointer
                move, and at 168 bars that is the jank. The crosshair already
                marks which one is selected. */}
            <g clipPath={`url(#plot-${marketId})`}>
            {geom.bars.map((b, i) => (
              <g key={i}>
                <line x1={b.cx} x2={b.cx} y1={b.wickTop} y2={b.wickBottom}
                  stroke={b.up ? UP : DOWN} strokeWidth="1" opacity="0.85" />
                <rect x={b.cx - geom.bodyW / 2} y={b.bodyY} width={geom.bodyW} height={b.bodyH}
                  fill={b.up ? UP : DOWN} opacity="0.9" />
              </g>
            ))}

            </g>

            {/* Time axis — a few labels, not one per candle. */}
            {[0, 0.25, 0.5, 0.75, 1].map((f, i) => {
              const idx = Math.min(rows!.length - 1, Math.round(f * (rows!.length - 1)));
              return (
                <text key={i} x={geom.cx(idx)} y={H - 8} textAnchor="middle"
                  fill="#ffffff" fillOpacity="0.28" fontSize="10"
                  fontFamily="ui-monospace, monospace">{fmtAxisTime(rows![idx].t, range)}</text>
              );
            })}

            {/* Crosshair */}
            {active && hover !== null && (
              <g pointerEvents="none">
                <line x1={geom.cx(hover)} x2={geom.cx(hover)} y1={PAD.top} y2={H - PAD.bottom}
                  stroke="#ffffff" strokeOpacity="0.25" strokeWidth="1" strokeDasharray="3 3" />
                <line x1={PAD.left} x2={width - PAD.right} y1={geom.y(active.c)} y2={geom.y(active.c)}
                  stroke="#ffffff" strokeOpacity="0.25" strokeWidth="1" strokeDasharray="3 3" />
                <rect x={width - PAD.right + 2} y={geom.y(active.c) - 8} width={PAD.right - 4} height={16}
                  rx="3" fill="#ffffff" fillOpacity="0.12" />
                <text x={width - PAD.right + 8} y={geom.y(active.c) + 3.5}
                  fill="#ffffff" fontSize="10" fontFamily="ui-monospace, monospace">
                  {fmtAxis(active.c)}
                </text>
              </g>
            )}

            {/* The card's prices: entry, liquidation, take-profit, stop. Drawn
                above the candles and labelled in the margin, so the distance to
                each is readable at a glance rather than inferred from numbers
                in a panel below. */}
            {lines.filter((l) => {
              // Zooming can push a price out of view. Drawing it clamped at the
              // edge would put a liquidation line somewhere it is not, which is
              // worse than not drawing it — the panel still states the number.
              const y = geom.y(l.price);
              return y >= PAD.top && y <= H - PAD.bottom;
            }).map((l) => (
              <g key={l.label} pointerEvents="none">
                <line x1={PAD.left} x2={width - PAD.right} y1={geom.y(l.price)} y2={geom.y(l.price)}
                  stroke={l.colour} strokeWidth="1" strokeDasharray={l.dash} opacity="0.85" />
                <text x={PAD.left + 4} y={geom.y(l.price) - 4}
                  fill={l.colour} fontSize="9.5" fontFamily="ui-monospace, monospace"
                  opacity="0.95">{l.label}</text>
                <rect x={width - PAD.right + 2} y={geom.y(l.price) - 8} width={PAD.right - 4} height={16}
                  rx="3" fill={l.colour} fillOpacity="0.16" />
                <text x={width - PAD.right + 8} y={geom.y(l.price) + 3.5}
                  fill={l.colour} fontSize="10" fontFamily="ui-monospace, monospace">
                  {fmtAxis(l.price)}
                </text>
              </g>
            ))}

            {/* The time axis, as a grab handle. Dragging it right pulls the
                bars apart and left pushes them together — the horizontal
                counterpart of the price axis, so a user who finds one finds the
                other. Double-click restores the full range. */}
            <rect x={PAD.left} y={H - PAD.bottom}
              width={Math.max(0, width - PAD.left - PAD.right)} height={PAD.bottom}
              fill="transparent"
              style={{ cursor: "ew-resize", touchAction: "none" }}
              onPointerDown={(e) => {
                // Same reason as the price axis: without this the svg's handler
                // also fires and starts a 2D pan on the same gesture.
                e.stopPropagation();
                if (!candles || !visible) return;
                timeDrag.current = {
                  x: e.clientX,
                  span: span ?? candles.length,
                  end: visible.from + visible.rows.length - 1,
                };
                e.currentTarget.setPointerCapture?.(e.pointerId);
                setHover(null);
              }}
              onDoubleClick={() => { setSpan(null); setEnd(null); }} />

            {/* The price axis, as a grab handle. Dragging it up zooms in and
                down zooms out, which is the gesture this control has everywhere
                else. Double-click restores the fit. */}
            <rect x={width - PAD.right} y={PAD.top}
              width={PAD.right} height={H - PAD.top - PAD.bottom}
              fill="transparent"
              // touchAction none on the strip only: the chart itself keeps
              // pan-y so the page still scrolls, but a vertical drag HERE is a
              // zoom rather than a scroll.
              style={{ cursor: "ns-resize", touchAction: "none" }}
              onPointerDown={(e) => {
                // **Stop here.** Pointer events bubble, so without this the
                // svg's own handler also fired and started a horizontal pan on
                // the same gesture — `onMove` checks pan first, so dragging the
                // price axis scrolled the chart sideways instead of zooming.
                e.stopPropagation();
                drag.current = { y: e.clientY, zoom };
                e.currentTarget.setPointerCapture?.(e.pointerId);
                setHover(null);
              }}
              onDoubleClick={() => setZoom(1)} />

            {/* PEX's live index — drawn last so it sits above the candles and
                cannot be read as one of them. */}
            {indexUsd !== null
              && geom.y(indexUsd) >= PAD.top && geom.y(indexUsd) <= H - PAD.bottom && (
              <g pointerEvents="none">
                <line x1={PAD.left} x2={width - PAD.right} y1={geom.y(indexUsd)} y2={geom.y(indexUsd)}
                  stroke={INDEX_COLOUR} strokeWidth="1" strokeDasharray="4 3" opacity="0.8" />
                <rect x={width - PAD.right + 2} y={geom.y(indexUsd) - 8} width={PAD.right - 4} height={16}
                  rx="3" fill={INDEX_COLOUR} fillOpacity="0.18" />
                <text x={width - PAD.right + 8} y={geom.y(indexUsd) + 3.5}
                  fill={INDEX_COLOUR} fontSize="10" fontFamily="ui-monospace, monospace">
                  {fmtAxis(indexUsd)}
                </text>
              </g>
            )}
          </svg>
        )}
      </div>

      {/* Naming both prices, because they are not the same price. */}
      <p className="mt-2 text-[10px] leading-relaxed text-white/30">
        Candles from Coinbase as a market reference.{" "}
        <span className="text-violet-300/60">Dashed violet</span> is PEX&apos;s live oracle price, which is
        what your trade is quoted against — your entry also includes PEX&apos;s price impact, so it
        will differ from both.
      </p>
    </div>
  );
}
