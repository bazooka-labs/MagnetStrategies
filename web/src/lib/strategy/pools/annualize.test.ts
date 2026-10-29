/**
 * `pickLongest` — the guards, not the arithmetic.
 *
 * Annualizing a realised return is a product decision taken against the
 * evidence: the same vault on 2026-10-28 gave +812% from 7 days, **−26% from
 * 30**, and +183% from 55. What makes the displayed figure defensible is not
 * the formula but the conditions around it, and those are what break silently.
 */
import { describe, expect, it } from "vitest";
import {
  pickLongest, holdingPeriods, periodLabel, MIN_ANNUALIZE_DAYS,
  type PoolStats, type PoolReturn,
} from "./performance";

/** A plausible index series: both start at 1.0, each ends at its own return. */
const series = (productPct: number, holdPct: number, n = 6) =>
  Array.from({ length: n }, (_, k) => ({
    ts: 1_790_000_000 + k * 86_400,
    product: 1 + (productPct / 100) * (k / (n - 1)),
    hold: 1 + (holdPct / 100) * (k / (n - 1)),
  }));

const ret = (
  period: PoolReturn["period"], productPct: number, days: number,
  /** The window's first-day anchor. Omitted = a bundle with no share prices. */
  startSharePrice: number | null = null, startTs = 0,
): PoolReturn => ({
  period, productPct, holdPct: 0, vsHoldingPoints: 0,
  benchmarkKind: "geometric_mean_50_50", points: Math.max(2, Math.round(days)), days,
  hasGaps: false, series: series(productPct, 0), startSharePrice, startTs,
});
const stats = (returns: PoolStats["returns"]): PoolStats =>
  ({ income: null, ret: null, retUnavailableReason: null, returns, reasons: {} });

describe("it picks the longest window, never the most flattering", () => {
  it("takes the 55-day window over a far better 7-day one", () => {
    const a = pickLongest(stats({
      "7d": ret("7d", 3.70, 6),        // +812% annualized — the tempting one
      "30d": ret("30d", -2.38, 29),
      "90d": ret("90d", 17.00, 55),
    }));
    expect(a?.days).toBe(55);
    expect(a?.realisedPct).toBe(17.00);
    expect(Math.round(a!.annualizedPct)).toBe(183);
  });

  it("will return a NEGATIVE headline when the long window is negative", () => {
    // The figure is not allowed to only ever flatter. A losing vault must say so.
    const a = pickLongest(stats({ "30d": ret("30d", -2.38, 29) }));
    expect(a!.annualizedPct).toBeLessThan(0);
    expect(Math.round(a!.annualizedPct)).toBe(-26);
  });

  it("uses the real day span, not the period label", () => {
    // The bundle's "90d" holds 55 days of history. Annualizing against the
    // LABEL would read +89% instead of the true +183% — understating by half.
    const a = pickLongest(stats({ "90d": ret("90d", 17.00, 55) }));
    expect(Math.round(a!.annualizedPct)).toBe(183);
    expect(Math.round((Math.pow(1.17, 365 / 90) - 1) * 100)).toBe(89);
  });
});

describe("it refuses rather than guesses", () => {
  it("returns null below the minimum span, however good the number", () => {
    // 13 days of +20% annualizes past 10,000%. The guard is the point.
    expect(pickLongest(stats({ "7d": ret("7d", 20, MIN_ANNUALIZE_DAYS - 1) }))).toBeNull();
  });

  it("accepts exactly at the minimum", () => {
    expect(pickLongest(stats({ "30d": ret("30d", 5, MIN_ANNUALIZE_DAYS) }))).not.toBeNull();
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

/**
 * ── Extending the window to the live share price ──
 *
 * PEX republishes once a day (`as_of` 00:00 UTC, posted ~00:10), so a figure
 * read straight from the bundle is up to 24 hours stale and moves once. The
 * share price moves on every re-mark, so pairing the bundle's FIRST day with
 * the live price refreshes the headline continuously.
 *
 * The property that makes this safe is that it only ever moves the END of the
 * window forward. Shortening the window is what produces the dispersion the
 * tests above exist to prevent, so "never shortens" is asserted directly.
 */
describe("the live share price extends the window rather than shortening it", () => {
  // 55 days of history ending at the bundle's last day, now 2 days further on.
  const START_TS = 1_790_000_000;
  const NOW = START_TS + 57 * 86_400;
  const bundle = stats({ "90d": ret("90d", 17.00, 55, 1.032995, START_TS) });

  it("prices the window off the LIVE share price when given one", () => {
    const a = pickLongest(bundle, 1.211418, NOW)!;
    // 1.211418 / 1.032995 - 1 = +17.27%, against the bundle's own +17.00%.
    expect(a.realisedPct).toBeCloseTo(17.27, 1);
    expect(a.days).toBeCloseTo(57, 5);
    expect(Math.round(a.annualizedPct)).toBe(177);
  });

  it("falls back to the bundle's own figure when there is no live price", () => {
    const a = pickLongest(bundle, null, NOW)!;
    expect(a.realisedPct).toBe(17.00);
    expect(a.days).toBe(55);
    expect(Math.round(a.annualizedPct)).toBe(183);
  });

  it("falls back when the bundle carries no start anchor", () => {
    // Older bundles, and any window whose first point omits share_price_usd.
    const a = pickLongest(stats({ "90d": ret("90d", 17.00, 55) }), 1.211418, NOW)!;
    expect(a.days).toBe(55);
    expect(a.realisedPct).toBe(17.00);
  });

  it("NEVER shortens the window, whatever the clock says", () => {
    // A clock behind the bundle's own span — skew, or a stale `nowSec`. The
    // answer must stay the bundle's 55 days rather than become a 3-day
    // extrapolation, which is the failure this whole module is built against.
    const a = pickLongest(bundle, 1.211418, START_TS + 3 * 86_400)!;
    expect(a.days).toBe(55);
    expect(a.realisedPct).toBe(17.00);
  });

  it("refuses a live price of zero rather than annualizing a total loss", () => {
    const a = pickLongest(bundle, 0, NOW)!;
    expect(a.realisedPct).toBe(17.00); // falls back, does not report −100%
  });

  it("reports a LOSS when the live price has fallen below the start", () => {
    // The extension must be able to move the headline down, not only up.
    const a = pickLongest(bundle, 0.90, NOW)!;
    expect(a.realisedPct).toBeLessThan(0);
    expect(a.annualizedPct).toBeLessThan(0);
  });

  it("still refuses a window under the minimum after extending", () => {
    const short = stats({ "7d": ret("7d", 3.70, 6, 1.0, START_TS) });
    expect(pickLongest(short, 1.05, START_TS + 8 * 86_400)).toBeNull();
    expect(MIN_ANNUALIZE_DAYS).toBe(14);
  });
});

/**
 * `holdingPeriods` — what the modal's ladder lists.
 *
 * The bundle's period NAMES outrun its history. With 56 days recorded, `90d`
 * and `total` are the same 48 points under two labels, and listing both padded
 * the ladder with a duplicate row that read as a fourth data point.
 */
describe("holdingPeriods", () => {
  it("collapses windows that cover the same span", () => {
    // The real 2026-10-29 shape: 90d and total both 56 days, +17.15%.
    const list = holdingPeriods(stats({
      "7d": ret("7d", 2.08, 6),
      "30d": ret("30d", 1.27, 29),
      "90d": ret("90d", 17.15, 56),
      "total": ret("total", 17.15, 56),
    }));
    expect(list.map((r) => Math.round(r.days))).toEqual([6, 29, 56]);
  });

  it("keeps the denser series when two labels tie on span", () => {
    const sparse = { ...ret("90d", 17.15, 56), points: 20 };
    const dense = { ...ret("total", 17.15, 56), points: 48 };
    const list = holdingPeriods(stats({ "90d": sparse, "total": dense }));
    expect(list).toHaveLength(1);
    expect(list[0].points).toBe(48);
  });

  it("orders shortest first, so the ladder reads as a progression", () => {
    const list = holdingPeriods(stats({
      "90d": ret("90d", 17.15, 56),
      "7d": ret("7d", 2.08, 6),
      "30d": ret("30d", 1.27, 29),
    }));
    expect(list.map((r) => r.days)).toEqual([6, 29, 56]);
  });

  it("drops windows PEX could not compute, rather than zeroing them", () => {
    const list = holdingPeriods(stats({ "7d": ret("7d", 2.08, 6), "30d": null }));
    expect(list.map((r) => r.period)).toEqual(["7d"]);
  });

  it("returns nothing for a vault with no published history", () => {
    expect(holdingPeriods(null)).toEqual([]);
    expect(holdingPeriods(stats({}))).toEqual([]);
  });
});

/**
 * `periodLabel` — what a window is CALLED, which is not what it is annualized
 * over.
 *
 * `days` is the elapsed span, last sample minus first, because that is the
 * denominator compounding needs. Seven daily samples have six intervals, so a
 * full 7-day window measures `days === 6`. Correct for the arithmetic, and it
 * made the ladder read "6 days" and "29 days" — correct figures that look
 * like off-by-one bugs.
 */
describe("periodLabel", () => {
  it("uses PEX's own name when the window is FULL", () => {
    // Verified against the live bundle 2026-10-29: 7d carries exactly 7 daily
    // samples spanning 6 days, 30d exactly 30 spanning 29.
    expect(periodLabel({ ...ret("7d", 2.08, 6), points: 7 })).toBe("7 days");
    expect(periodLabel({ ...ret("30d", 1.27, 29), points: 30 })).toBe("30 days");
  });

  it("falls back to the measured span when the window is SHORT", () => {
    /**
     * 90d held 48 samples against a nominal 90 — short by 42. Calling it
     * "90 days" would claim history this vault has never had.
     *
     * The count drifts as history accrues — 55 on 2026-10-28, 56 on the 29th
     * — and is deliberately not rounded: this label is the denominator of the
     * compounding the modal invites the reader to check, and the same +17.16%
     * reads 181% a year over 56 days, 186% over 55 and 218% over 50.
     */
    expect(periodLabel({ ...ret("90d", 17.15, 56, 1.0, 1_788_307_200), points: 48 }))
      .toBe("56 days");
    // Same window, no start anchor: identical answer.
    expect(periodLabel({ ...ret("90d", 17.15, 56), points: 48 })).toBe("56 days");
  });

  it("promotes itself once the history arrives", () => {
    // The same window, a month of days later. No code change needed.
    expect(periodLabel({ ...ret("90d", 17.15, 89), points: 90 })).toBe("90 days");
  });

  it("always reports the span for `total`, which has no nominal length", () => {
    const at = (pts: number) =>
      periodLabel({ ...ret("total", 17.15, 56, 1.0, 1_788_307_200), points: pts });
    expect(at(48)).toBe("56 days");
    expect(at(900)).toBe("56 days");
  });

  it("does not feed annualization, which keeps the elapsed span", () => {
    /**
     * The whole point of keeping the two apart. Compounding 15.27% over the
     * LABEL's 90 days instead of the measured 89 understates the result, and
     * the error grows as the label and the span diverge.
     */
    const w = { ...ret("90d", 15.27, 89, 1.0, 1_788_307_200), points: 90 };
    expect(periodLabel(w)).toBe("90 days");
    const a = pickLongest(stats({ "90d": w }))!;
    expect(a.days).toBe(89);
    expect(Math.round(a.annualizedPct))
      .toBe(Math.round((Math.pow(1.1527, 365 / 89) - 1) * 100));
  });
});
