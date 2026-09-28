// Network-free. The live check (that Coinbase's series actually tracks PEX's
// index, measured at 0.03-0.09% drift) is a one-off verification, not a test —
// making it a test would put a third party's uptime in our suite.
//
// What IS worth testing is the parsing: Coinbase returns rows newest-first in
// [time, low, high, open, close, volume] order, and getting either wrong draws
// a chart that is backwards or reads the wrong field as the price.

import { describe, expect, it } from "vitest";
import {
  CHART_RANGES, ChartUnavailableError, changePct, fetchCandles, rangeLabel,
  type Candle,
} from "./perpsChart";
import { PEX_MARKETS } from "./perps";

const ALGO = PEX_MARKETS.algoUsd.id;
const ok = (body: unknown): typeof fetch =>
  (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;

// [time, low, high, open, close, volume] — newest first, as Coinbase sends it.
const ROWS = [
  [1_700_003_600, 0.12, 0.14, 0.13, 0.135, 100],
  [1_700_000_000, 0.10, 0.12, 0.11, 0.115, 200],
];

describe("fetchCandles", () => {
  it("returns candles oldest-first, whatever order they arrive in", async () => {
    const c = await fetchCandles(ALGO, "1d", ok(ROWS));
    expect(c.map((x) => x.t)).toEqual([1_700_000_000, 1_700_003_600]);
  });

  it("reads Coinbase's column order, not a guessed one", async () => {
    // Getting this wrong plots the low as the close and the chart is subtly,
    // unfalsifiably wrong.
    const [first] = await fetchCandles(ALGO, "1d", ok(ROWS));
    expect(first).toEqual<Candle>({ t: 1_700_000_000, l: 0.10, h: 0.12, o: 0.11, c: 0.115 });
  });

  it("throws rather than returning empty, so a caller cannot draw a flat zero", async () => {
    await expect(fetchCandles(ALGO, "1d", ok([]))).rejects.toBeInstanceOf(ChartUnavailableError);
  });

  it("refuses a market it has no product for", async () => {
    await expect(fetchCandles(999, "1d", ok(ROWS))).rejects.toBeInstanceOf(ChartUnavailableError);
  });

  it("refuses a non-200 and a wrong-shaped body", async () => {
    const bad = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(fetchCandles(ALGO, "1d", bad)).rejects.toBeInstanceOf(ChartUnavailableError);
    await expect(fetchCandles(ALGO, "1d", ok({ nope: true }))).rejects.toBeInstanceOf(ChartUnavailableError);
  });

  it("drops malformed rows rather than plotting NaN", async () => {
    const mixed = [...ROWS, [1_700_007_200, "x", null, 1, undefined, 1]];
    const c = await fetchCandles(ALGO, "1d", ok(mixed));
    expect(c).toHaveLength(2);
    expect(c.every((x) => Number.isFinite(x.c))).toBe(true);
  });

  it("propagates a network failure as ChartUnavailableError", async () => {
    const boom = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    await expect(fetchCandles(ALGO, "1d", boom)).rejects.toBeInstanceOf(ChartUnavailableError);
  });
});

describe("ranges", () => {
  it("every offered range has a granularity and a label", async () => {
    // A missing entry would fetch `undefined` granularity and 422 at runtime.
    for (const r of CHART_RANGES) {
      expect(rangeLabel(r)).toMatch(/^[0-9]+[HDW]$/);
      // Aggregated intervals (4H, 1W) fold the two rows into one bucket, so
      // the count is not fixed — what matters is that it fetches at all.
      const c = await fetchCandles(ALGO, r, ok(ROWS));
      expect(c.length).toBeGreaterThan(0);
    }
  });

  it("offers them shortest first", () => {
    expect(CHART_RANGES).toEqual(["1h", "4h", "1d", "1w"]);
  });
});

describe("candle invariants", () => {
  it("keeps low <= min(open, close) and high >= max(open, close)", async () => {
    // The chart draws the body between open and close and the wick between low
    // and high. A row violating this renders inside-out — the body escaping its
    // own wick — so it is worth asserting on the parsed shape rather than
    // trusting the feed.
    const c = await fetchCandles(ALGO, "1d", ok(ROWS));
    for (const x of c) {
      expect(x.l).toBeLessThanOrEqual(Math.min(x.o, x.c));
      expect(x.h).toBeGreaterThanOrEqual(Math.max(x.o, x.c));
    }
  });
});

describe("aggregation", () => {
  // 4H and 1W are built from 1h and 1d candles: the exchange does not serve
  // them. Getting this wrong silently mislabels every bar on those intervals.
  // 4h-aligned: 1_700_000_000 is NOT (it sits 8000s into a bucket), so eight
  // candles from there correctly span three buckets rather than two.
  const ALIGNED = 1_699_992_000;
  const hourly = (n: number, base = ALIGNED) =>
    Array.from({ length: n }, (_, i) => [base + i * 3600, 10 + i, 30 + i, 20 + i, 25 + i, 1]);

  it("folds four hourly candles into one 4H candle", async () => {
    const c = await fetchCandles(ALGO, "4h", ok(hourly(8).reverse()));
    expect(c).toHaveLength(2);
    // open of first, max high, min low, close of last.
    expect(c[0].o).toBe(20);
    expect(c[0].h).toBe(33);
    expect(c[0].l).toBe(10);
    expect(c[0].c).toBe(28);
  });

  it("aligns buckets to absolute time, not to where the response starts", async () => {
    // Starting mid-bucket must not shift every subsequent boundary.
    const rows = hourly(8, ALIGNED + 2 * 3600).reverse();
    const c = await fetchCandles(ALGO, "4h", ok(rows));
    for (const x of c) expect(x.t % (4 * 3600)).toBe(0);
  });

  it("keeps a partial trailing bucket, which is the live candle", async () => {
    const c = await fetchCandles(ALGO, "4h", ok(hourly(5).reverse()));
    expect(c).toHaveLength(2);
  });

  it("leaves unaggregated intervals untouched", async () => {
    const rows = hourly(4).reverse();
    const c = await fetchCandles(ALGO, "1h", ok(rows));
    expect(c).toHaveLength(4);
  });
});

describe("changePct", () => {
  it("measures first open to last close", async () => {
    const c = await fetchCandles(ALGO, "1d", ok(ROWS));
    // open 0.11 -> close 0.135
    expect(changePct(c)).toBeCloseTo(((0.135 - 0.11) / 0.11) * 100, 6);
  });

  it("returns null when there is nothing to compare", () => {
    expect(changePct([])).toBeNull();
    expect(changePct([{ t: 1, o: 1, h: 1, l: 1, c: 1 }])).toBeNull();
  });
});
