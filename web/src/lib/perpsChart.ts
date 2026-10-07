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

export type ChartRange = "1h" | "4h" | "1d" | "1w";

/** Coinbase product per market. Market 2 is synthetic — there is no ASA to price. */
const PRODUCT: Record<number, string> = {
  [PEX_MARKETS.algoUsd.id]: "ALGO-USD",
  [PEX_MARKETS.btcUsd.id]: "BTC-USD",
};

/**
 * **These are candle INTERVALS, not ranges.**
 *
 * "1D" means one candle covers one day, and the axis shows as many days as fit
 * — which is what the control means on every other trading chart. An earlier
 * version read them as ranges ("show me the last day") and chose the
 * granularity itself, so picking 1D gave 96 fifteen-minute candles. Same
 * buttons, completely different chart.
 *
 * Coinbase only serves 60, 300, 900, 3600, 21600 and 86400 second candles, so
 * 4h and 1w are built by aggregating: four 1h candles, or seven 1d candles.
 * Aggregation is open-of-first, max-high, min-low, close-of-last — the same
 * arithmetic the exchange would do.
 *
 * `fetchSec` is sized to stay under Coinbase's 300-row response cap.
 */
const INTERVAL: Record<ChartRange, {
  granularity: number; aggregate: number; fetchSec: number; label: string;
}> = {
  "1h": { granularity: 3600, aggregate: 1, fetchSec: 280 * 3600, label: "1H" },
  "4h": { granularity: 3600, aggregate: 4, fetchSec: 280 * 3600, label: "4H" },
  "1d": { granularity: 86400, aggregate: 1, fetchSec: 280 * 86400, label: "1D" },
  "1w": { granularity: 86400, aggregate: 7, fetchSec: 280 * 86400, label: "1W" },
};

/** The intervals the chart offers, shortest first. */
export const CHART_RANGES: ChartRange[] = ["1h", "4h", "1d", "1w"];

/**
 * How many candles to show before the user pans or zooms.
 *
 * A FRACTION of what was fetched, not a fixed count. Showing everything left
 * nothing to drag into, so panning silently did nothing at the default view —
 * and a fixed count breaks the other way: 4H returns only ~70 candles, so a
 * 90-candle window would again have shown all of them and had no slack.
 *
 * Two-thirds leaves a third of the series to pan back through on every
 * interval, whatever the exchange's row cap allows us to fetch.
 */
export const defaultVisible = (total: number): number =>
  Math.max(20, Math.floor(total * 0.66));

/** Short label for the interval buttons. */
export const rangeLabel = (r: ChartRange): string => INTERVAL[r].label;

/** Seconds one candle covers, after aggregation. */
export const rangeGranularity = (r: ChartRange): number =>
  INTERVAL[r].granularity * INTERVAL[r].aggregate;

/**
 * How long one candle covers, for display.
 *
 * Worth stating on screen: the 4H bars are aggregated from hourly candles and
 * the 1W bars from daily ones, so a reader who assumes each bar is a native
 * exchange candle is misreading the granularity.
 */
export function candleInterval(r: ChartRange): string {
  const g = rangeGranularity(r);
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

  const { granularity, aggregate, fetchSec } = INTERVAL[range];
  const end = Math.floor(Date.now() / 1000);
  const start = end - fetchSec;
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
  candles.sort((a, b) => a.t - b.t);
  return aggregate > 1 ? aggregateCandles(candles, aggregate, granularity) : candles;
}

/** The last 24 hours, as one summary. Prices in USD. */
export type DayStats = { open: number; high: number; low: number; close: number };

/**
 * Rolling 24-hour high, low and open — NOT the calendar daily candle.
 *
 * A daily candle resets at 00:00 UTC, so at 00:30 its "high" and "low" describe
 * thirty minutes while still being labelled 24h. Every exchange's 24h figures
 * are a rolling window for that reason, and a trader reading "24h low" during
 * the first hours of a UTC day would otherwise be reading a number that is true
 * only of this morning.
 *
 * Hourly granularity: the extremes are then the hour's real high and low rather
 * than a sampled close, and 24 rows is one cheap request.
 *
 * `open` is the oldest bucket's open, so a change computed against it spans the
 * full window.
 */
export async function fetchDayStats(
  marketId: number, fetchImpl: typeof fetch = fetch,
): Promise<DayStats> {
  const product = PRODUCT[marketId];
  if (!product) throw new ChartUnavailableError(`no price history configured for market ${marketId}`);

  const end = Math.floor(Date.now() / 1000);
  const start = end - 24 * 3600;
  const url = `https://api.exchange.coinbase.com/products/${product}/candles`
    + `?granularity=3600&start=${new Date(start * 1000).toISOString()}`
    + `&end=${new Date(end * 1000).toISOString()}`;

  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { accept: "application/json" } });
  } catch (e) {
    throw new ChartUnavailableError(e instanceof Error ? e.message : String(e));
  }
  if (!res.ok) throw new ChartUnavailableError(`24h stats returned ${res.status}`);

  const raw: unknown = await res.json();
  if (!Array.isArray(raw)) throw new ChartUnavailableError("24h stats had an unexpected shape");

  // Coinbase rows are [time, low, high, open, close, volume], newest first.
  const rows: Candle[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [t, l, h, o, c] = row as number[];
    if (![t, l, h, o, c].every((v) => typeof v === "number" && Number.isFinite(v))) continue;
    rows.push({ t, l, h, o, c });
  }
  if (rows.length === 0) throw new ChartUnavailableError("24h stats were empty");
  rows.sort((a, b) => a.t - b.t);

  return {
    open: rows[0].o,
    close: rows[rows.length - 1].c,
    high: Math.max(...rows.map((r) => r.h)),
    low: Math.min(...rows.map((r) => r.l)),
  };
}

/**
 * The visible price range, before zoom and panning.
 *
 * Extracted from `PerpsChart`'s `geom` so it can be tested: the component lives
 * in a `.tsx` the vitest glob does not include, and this is the one piece of
 * that memo where being wrong is visible to a trader rather than merely untidy.
 *
 * Drawn lines stretch the range, but only so far. Including every line is right
 * for a liquidation a few percent away — that distance is what a trader reads
 * the chart for. It is wrong for a position near 1x, whose liquidation sits
 * 97-99% below the index: the candles then compress into a flat band and the
 * axis runs NEGATIVE. Measured on live state: a real 1.0x long put a 24h series
 * into 18.6px of a 264px plot and printed "$-0.009517" on the axis, and three of
 * eight live PEX positions were in that range.
 *
 * The bound is readability, not a price. A line may push the window out by at
 * most twice the candle range on each side, so the candles keep at least a fifth
 * of the plot. Lines outside the result are not clamped to the edge — the chart
 * drops them, because a liquidation line drawn somewhere it is not is worse than
 * one not drawn.
 */
export function priceWindow(input: {
  /** Lowest low and highest high of the visible candles. */
  lo: number;
  hi: number;
  /** Fallback anchor when the range is degenerate. */
  lastClose: number;
  indexUsd: number | null;
  /** Finite prices of the lines being drawn. */
  drawn: number[];
}): { min: number; max: number } {
  const { lo, hi, lastClose, indexUsd, drawn } = input;
  const room = (hi - lo) * 2;
  const inScale = drawn.filter((v) => v >= lo - room && v <= hi + room);
  let min = Math.min(lo, indexUsd ?? Infinity, ...inScale);
  let max = Math.max(hi, indexUsd ?? -Infinity, ...inScale);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    min = lastClose * 0.995;
    max = lastClose * 1.005;
  }
  const padY = (max - min) * 0.08;
  min -= padY;
  max += padY;
  // A price is never negative. Padding can push a low `min` under zero even
  // with the bound above, and the axis would render the tick as "$-0.0095".
  if (min < 0) min = 0;
  return { min, max };
}

/**
 * Combine `n` candles into one, for intervals the exchange does not serve.
 *
 * Buckets are aligned to absolute time rather than to the start of the array,
 * so a 4h candle always covers 00:00-04:00 and not whatever four hours the
 * response happened to begin on. A partial trailing bucket is kept: the current
 * period is genuinely in progress, and dropping it would hide the live candle.
 */
function aggregateCandles(rows: Candle[], n: number, granularity: number): Candle[] {
  const bucketSec = granularity * n;
  const out: Candle[] = [];
  let cur: Candle | null = null;
  let curBucket = -1;
  for (const c of rows) {
    const bucket = Math.floor(c.t / bucketSec);
    if (bucket !== curBucket) {
      if (cur) out.push(cur);
      curBucket = bucket;
      cur = { t: bucket * bucketSec, o: c.o, h: c.h, l: c.l, c: c.c };
      continue;
    }
    cur!.h = Math.max(cur!.h, c.h);
    cur!.l = Math.min(cur!.l, c.l);
    cur!.c = c.c;
  }
  if (cur) out.push(cur);
  return out;
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
