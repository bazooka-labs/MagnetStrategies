// Perps — price history for the chart.
//
// ── Why this is not "PEX's chart" ────────────────────────────────────────────
// PEX publishes a SPOT price and nothing else: one point per market, refreshed
// every 2-3 seconds, with no history endpoint and no candle API (checked — the
// artifact bucket 404s on every plausible path and the SDK exposes nothing).
// So a chart has to come from somewhere else, and that "somewhere else" is a
// different price than the one the user trades at.
//
// That distinction is the whole reason this file is careful. The card quotes an
// EXECUTION price: the oracle index, plus PEX's price impact, which on ALGO is a
// flat 55 bps step that routinely puts a long's entry BELOW the index. A chart
// that quietly disagrees with the entry price beside it would be a new instance
// of exactly the defect six audits have been chasing — the screen saying one
// thing while the trade does another.
//
// So: the history is labelled as a market reference, and the caller overlays
// PEX's live index on top of it so the two are visibly different things rather
// than implicitly the same one.
//
// ── Why Coinbase ────────────────────────────────────────────────────────────
// It serves both markets from one methodology and needs no key. Binance returns
// 451 from here (and for users in some regions). Vestige is marginally closer to
// PEX on ALGO — 0.007% against Coinbase's 0.08% when measured — but market 2 is
// synthetic, so there is no Algorand BTC asset for it to price, and one source
// across both markets beats two sources that disagree differently.
//
// PEX's oracle is `exchange-median`, so a centralised-exchange reference is the
// methodologically closer choice anyway.

import { PEX_MARKETS } from "./perps";

export type Candle = {
  /** Unix seconds, bucket start. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
};

export type ChartRange = "1h" | "4h" | "24h" | "1w";

/** Coinbase product per market. Market 2 is synthetic — there is no ASA to price. */
const PRODUCT: Record<number, string> = {
  [PEX_MARKETS.algoUsd.id]: "ALGO-USD",
  [PEX_MARKETS.btcUsd.id]: "BTC-USD",
};

/**
 * Granularity and span per range.
 *
 * Coinbase only accepts 60, 300, 900, 3600, 21600 and 86400 as granularities,
 * and caps a response at 300 candles — so each row is chosen to land between
 * about 48 and 170 candles, which is enough to read a shape without becoming a
 * picket fence at the widths this chart renders at.
 */
const RANGE: Record<ChartRange, { granularity: number; spanSec: number; label: string }> = {
  "1h": { granularity: 60, spanSec: 3600, label: "1H" },              // 1m x 60
  "4h": { granularity: 300, spanSec: 4 * 3600, label: "4H" },         // 5m x 48
  "24h": { granularity: 900, spanSec: 24 * 3600, label: "1D" },       // 15m x 96
  "1w": { granularity: 3600, spanSec: 7 * 24 * 3600, label: "1W" },   // 1h x 168
};

/** The ranges the chart offers, shortest first. */
export const CHART_RANGES: ChartRange[] = ["1h", "4h", "24h", "1w"];

/** Short label for the range buttons. */
export const rangeLabel = (r: ChartRange): string => RANGE[r].label;

/** Seconds per candle for a range. One 1W candle is an HOUR, not a day. */
export const rangeGranularity = (r: ChartRange): number => RANGE[r].granularity;

/**
 * How long one candle covers, for display.
 *
 * Worth stating on screen: a 1W chart is built from hourly candles, and a
 * reader who assumes the bars are daily is misreading every one of them.
 */
export function candleInterval(r: ChartRange): string {
  const g = RANGE[r].granularity;
  if (g >= 86400) return `${g / 86400}d`;
  if (g >= 3600) return `${g / 3600}h`;
  return `${g / 60}m`;
}

export class ChartUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChartUnavailableError";
  }
}

/**
 * Candles for a market, oldest first.
 *
 * Throws `ChartUnavailableError` rather than returning empty: the caller must
 * distinguish "no history" from "a flat line at zero", and an empty array
 * renders as the latter.
 */
export async function fetchCandles(
  marketId: number, range: ChartRange, fetchImpl: typeof fetch = fetch,
): Promise<Candle[]> {
  const product = PRODUCT[marketId];
  if (!product) throw new ChartUnavailableError(`no price history configured for market ${marketId}`);

  const { granularity, spanSec } = RANGE[range];
  const end = Math.floor(Date.now() / 1000);
  const start = end - spanSec;
  const url = `https://api.exchange.coinbase.com/products/${product}/candles`
    + `?granularity=${granularity}&start=${new Date(start * 1000).toISOString()}`
    + `&end=${new Date(end * 1000).toISOString()}`;

  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { accept: "application/json" } });
  } catch (e) {
    throw new ChartUnavailableError(e instanceof Error ? e.message : String(e));
  }
  if (!res.ok) throw new ChartUnavailableError(`price history returned ${res.status}`);

  const raw: unknown = await res.json();
  if (!Array.isArray(raw)) throw new ChartUnavailableError("price history had an unexpected shape");

  // Coinbase rows are [time, low, high, open, close, volume], newest first.
  const candles: Candle[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [t, l, h, o, c] = row as number[];
    if (![t, l, h, o, c].every((v) => typeof v === "number" && Number.isFinite(v))) continue;
    candles.push({ t, l, h, o, c });
  }
  if (candles.length === 0) throw new ChartUnavailableError("price history was empty");
  return candles.sort((a, b) => a.t - b.t);
}

/**
 * **Buckets with no trades are omitted, not zero-filled.**
 *
 * Measured: ALGO/USD at 1m granularity comes back with a 120-second step where
 * one minute had no trades. The chart plots candles by index, so equal pixel
 * spacing is not equal time spacing across such a gap — which is how every
 * trading chart behaves, and the axis labels read their timestamp from the
 * candle they sit under, so each label is true for its own bar.
 *
 * The alternative is inserting synthetic candles to make the spacing uniform.
 * That would draw bars for minutes in which nothing traded, which is worse than
 * a non-linear axis: it invents data.
 */

/** Percentage change across the series, for the header. Null when undefined. */
export function changePct(candles: Candle[]): number | null {
  if (candles.length < 2) return null;
  const first = candles[0].o;
  const last = candles[candles.length - 1].c;
  if (first === 0) return null;
  return ((last - first) / first) * 100;
}
