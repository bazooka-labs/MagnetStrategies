/**
 * `pickLongest` — the guards, not the arithmetic.
 *
 * Annualising a realised return is a product decision taken against the
 * evidence: the same vault on 2026-10-28 gave +812% from 7 days, **−26% from
 * 30**, and +183% from 55. What makes the displayed figure defensible is not
 * the formula but the conditions around it, and those are what break silently.
 */
import { describe, expect, it } from "vitest";
import { pickLongest, MIN_ANNUALISE_DAYS, type PoolStats, type PoolReturn } from "./performance";

const ret = (period: PoolReturn["period"], productPct: number, days: number): PoolReturn => ({
  period, productPct, holdPct: 0, vsHoldingPoints: 0,
  benchmarkKind: "geometric_mean_50_50", points: Math.max(2, Math.round(days)), days, hasGaps: false,
});
const stats = (returns: PoolStats["returns"]): PoolStats =>
  ({ income: null, ret: null, retUnavailableReason: null, returns, reasons: {} });

describe("it picks the longest window, never the most flattering", () => {
  it("takes the 55-day window over a far better 7-day one", () => {
    const a = pickLongest(stats({
      "7d": ret("7d", 3.70, 6),        // +812% annualised — the tempting one
      "30d": ret("30d", -2.38, 29),
      "90d": ret("90d", 17.00, 55),
    }));
    expect(a?.days).toBe(55);
    expect(a?.realisedPct).toBe(17.00);
    expect(Math.round(a!.annualisedPct)).toBe(183);
  });

  it("will return a NEGATIVE headline when the long window is negative", () => {
    // The figure is not allowed to only ever flatter. A losing vault must say so.
    const a = pickLongest(stats({ "30d": ret("30d", -2.38, 29) }));
    expect(a!.annualisedPct).toBeLessThan(0);
    expect(Math.round(a!.annualisedPct)).toBe(-26);
  });

  it("uses the real day span, not the period label", () => {
    // The bundle's "90d" holds 55 days of history. Annualising against the
    // LABEL would read +89% instead of the true +183% — understating by half.
    const a = pickLongest(stats({ "90d": ret("90d", 17.00, 55) }));
    expect(Math.round(a!.annualisedPct)).toBe(183);
    expect(Math.round((Math.pow(1.17, 365 / 90) - 1) * 100)).toBe(89);
  });
});

describe("it refuses rather than guesses", () => {
  it("returns null below the minimum span, however good the number", () => {
    // 13 days of +20% annualises past 10,000%. The guard is the point.
    expect(pickLongest(stats({ "7d": ret("7d", 20, MIN_ANNUALISE_DAYS - 1) }))).toBeNull();
  });

  it("accepts exactly at the minimum", () => {
    expect(pickLongest(stats({ "30d": ret("30d", 5, MIN_ANNUALISE_DAYS) }))).not.toBeNull();
  });

  it("returns null with no history at all", () => {
    expect(pickLongest(stats({}))).toBeNull();
    expect(pickLongest(null)).toBeNull();
  });

  it("refuses a total loss rather than returning NaN", () => {
    // -100% cannot be compounded; Math.pow of a negative base to a fractional
    // exponent is NaN, which would render as "NaN%" on the card.
    const a = pickLongest(stats({ "90d": ret("90d", -100, 55) }));
    expect(a).toBeNull();
  });

  it("ignores a window with zero span", () => {
    expect(pickLongest(stats({ "7d": ret("7d", 5, 0) }))).toBeNull();
  });
});
