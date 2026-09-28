// Network-free. The live check (that Coinbase's series actually tracks PEX's
// index, measured at 0.03-0.09% drift) is a one-off verification, not a test —
// making it a test would put a third party's uptime in our suite.
//
// What IS worth testing is the parsing: Coinbase returns rows newest-first in
// [time, low, high, open, close, volume] order, and getting either wrong draws
// a chart that is backwards or reads the wrong field as the price.

import { describe, expect, it } from "vitest";
import { ChartUnavailableError, changePct, fetchCandles, type Candle } from "./perpsChart";
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
    const c = await fetchCandles(ALGO, "24h", ok(ROWS));
    expect(c.map((x) => x.t)).toEqual([1_700_000_000, 1_700_003_600]);
  });

  it("reads Coinbase's column order, not a guessed one", async () => {
    // Getting this wrong plots the low as the close and the chart is subtly,
    // unfalsifiably wrong.
    const [first] = await fetchCandles(ALGO, "24h", ok(ROWS));
    expect(first).toEqual<Candle>({ t: 1_700_000_000, l: 0.10, h: 0.12, o: 0.11, c: 0.115 });
  });

  it("throws rather than returning empty, so a caller cannot draw a flat zero", async () => {
    await expect(fetchCandles(ALGO, "24h", ok([]))).rejects.toBeInstanceOf(ChartUnavailableError);
  });

  it("refuses a market it has no product for", async () => {
    await expect(fetchCandles(999, "24h", ok(ROWS))).rejects.toBeInstanceOf(ChartUnavailableError);
  });

  it("refuses a non-200 and a wrong-shaped body", async () => {
    const bad = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(fetchCandles(ALGO, "24h", bad)).rejects.toBeInstanceOf(ChartUnavailableError);
    await expect(fetchCandles(ALGO, "24h", ok({ nope: true }))).rejects.toBeInstanceOf(ChartUnavailableError);
  });

  it("drops malformed rows rather than plotting NaN", async () => {
    const mixed = [...ROWS, [1_700_007_200, "x", null, 1, undefined, 1]];
    const c = await fetchCandles(ALGO, "24h", ok(mixed));
    expect(c).toHaveLength(2);
    expect(c.every((x) => Number.isFinite(x.c))).toBe(true);
  });

  it("propagates a network failure as ChartUnavailableError", async () => {
    const boom = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    await expect(fetchCandles(ALGO, "24h", boom)).rejects.toBeInstanceOf(ChartUnavailableError);
  });
});

describe("changePct", () => {
  it("measures first open to last close", async () => {
    const c = await fetchCandles(ALGO, "24h", ok(ROWS));
    // open 0.11 -> close 0.135
    expect(changePct(c)).toBeCloseTo(((0.135 - 0.11) / 0.11) * 100, 6);
  });

  it("returns null when there is nothing to compare", () => {
    expect(changePct([])).toBeNull();
    expect(changePct([{ t: 1, o: 1, h: 1, l: 1, c: 1 }])).toBeNull();
  });
});
