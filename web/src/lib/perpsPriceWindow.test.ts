// The chart's visible price range.
//
// Extracted from PerpsChart's `geom` precisely so it could be tested: the
// component is a .tsx the vitest glob does not include, and audit 11 found the
// defect here by arithmetic rather than by any test.
//
// Numbers below are the live MainNet state the audit measured, not invented.

import { describe, expect, it } from "vitest";
import { priceWindow } from "./perpsChart";

// ALGO/USD, 1d range, as served while the bug was live.
const ALGO = { lo: 0.1184, hi: 0.1289, lastClose: 0.1205, indexUsd: 0.120518 };
/** A real 1.0x long's liquidation: 99.4% below the index. */
const LIQ_1X = 0.000736;
/** A real 5x long's liquidation: ~17% below. */
const LIQ_5X = 0.099981;

const frac = (w: { min: number; max: number }) => (ALGO.hi - ALGO.lo) / (w.max - w.min);

describe("a far line cannot collapse the candles", () => {
  it("ignores a near-1x liquidation", () => {
    const w = priceWindow({ ...ALGO, drawn: [LIQ_1X] });
    const bare = priceWindow({ ...ALGO, drawn: [] });
    expect(w).toEqual(bare);
  });

  it("keeps the candles on at least a fifth of the plot", () => {
    // Measured before the bound: 18.6px of 264px — 7%.
    expect(frac(priceWindow({ ...ALGO, drawn: [LIQ_1X] }))).toBeGreaterThan(0.2);
  });

  it("never returns a negative floor", () => {
    // `formatPriceUsd(-0.009517…)` returns "$-0.009517", and it reached the
    // y-axis. A price is never negative.
    for (const drawn of [[LIQ_1X], [0], [-1], [0.0000001], []]) {
      expect(priceWindow({ ...ALGO, drawn }).min).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("a line worth seeing still stretches it", () => {
  it("includes a 5x liquidation", () => {
    // The whole point of putting lines in the scale: the distance to
    // liquidation is what the chart is read for.
    const w = priceWindow({ ...ALGO, drawn: [LIQ_5X] });
    expect(w.min).toBeLessThanOrEqual(LIQ_5X);
    expect(w.min).toBeLessThan(priceWindow({ ...ALGO, drawn: [] }).min);
  });

  it("includes a take-profit above the range", () => {
    const tp = 0.1400;
    expect(priceWindow({ ...ALGO, drawn: [tp] }).max).toBeGreaterThanOrEqual(tp);
  });

  it("drops a line beyond the bound rather than clamping it to the edge", () => {
    // The chart filters out-of-range lines; a liquidation drawn at the edge
    // would sit at a price it is not. This asserts the window does not quietly
    // stretch to meet it.
    const w = priceWindow({ ...ALGO, drawn: [LIQ_1X] });
    expect(w.min).toBeGreaterThan(LIQ_1X);
  });
});

describe("degenerate inputs", () => {
  it("falls back around the last close when the range is flat", () => {
    const w = priceWindow({ lo: 0.12, hi: 0.12, lastClose: 0.12, indexUsd: null, drawn: [] });
    expect(w.min).toBeLessThan(0.12);
    expect(w.max).toBeGreaterThan(0.12);
  });

  it("tolerates a null index", () => {
    const w = priceWindow({ ...ALGO, indexUsd: null, drawn: [] });
    expect(w.min).toBeGreaterThan(0);
    expect(w.max).toBeGreaterThan(w.min);
  });

  it("keeps the index inside the window when it sits outside the candles", () => {
    const w = priceWindow({ ...ALGO, indexUsd: 0.1310, drawn: [] });
    expect(w.max).toBeGreaterThanOrEqual(0.1310);
  });
});
