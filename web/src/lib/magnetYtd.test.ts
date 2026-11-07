/**
 * The year mark, and the figure measured from it.
 *
 * ── What is actually fragile here ────────────────────────────────────────
 * Not the percentage — that is one subtraction. It is the two inputs:
 *
 *   1. WHICH DAY the year starts. A hardcoded 2026-06-19 is right for about
 *      seven months and then silently measures a 19-month "year". Nothing
 *      throws and the number stays plausible, which is the same shape as the
 *      two constants that expired in this repo on 2026-11-07.
 *
 *   2. WHICH FIELD of that day's candle. Measured against Vestige
 *      2026-11-07: the 2026-06-19 candle opened 1.4015 and closed 1.4342.
 *      Against a live 1.4716 that is +5.00% from the open and +2.61% from
 *      the close — so reading the wrong field halves the headline.
 */

import { describe, expect, it } from "vitest";
import { MAGNET_INCEPTION, yearMark } from "./tokenStats";

const at = (iso: string) => yearMark(new Date(iso)).toISOString().slice(0, 10);

describe("the year mark", () => {
  it("is inception's date, in whatever year we are in", () => {
    // Magnet launched 2025-06-19; June is month 5 zero-indexed.
    expect(MAGNET_INCEPTION).toEqual({ month: 5, day: 19 });
    expect(at("2026-11-07T18:00:00Z")).toBe("2026-06-19");
  });

  it("rolls back to last year before the anniversary, not forward", () => {
    // The day BEFORE still belongs to the previous year — measuring from a
    // mark in the future would give a negative window.
    expect(at("2026-06-18T23:59:59Z")).toBe("2025-06-19");
    expect(at("2026-06-19T00:00:00Z")).toBe("2026-06-19");
    expect(at("2026-01-05T12:00:00Z")).toBe("2025-06-19");
  });

  it("rolls FORWARD on its own when the next anniversary passes", () => {
    // The whole reason this is computed rather than pinned.
    expect(at("2027-06-18T12:00:00Z")).toBe("2026-06-19");
    expect(at("2027-06-19T00:00:01Z")).toBe("2027-06-19");
    expect(at("2031-12-31T23:00:00Z")).toBe("2031-06-19");
  });

  it("is midnight UTC, so the candle boundary lines up", () => {
    // Vestige's daily candles start at UTC midnight. An hour out and the
    // request straddles two days and takes the wrong one.
    const m = yearMark(new Date("2026-11-07T18:00:00Z"));
    expect(m.getTime() % 86_400_000).toBe(0);
    expect(m.toISOString()).toBe("2026-06-19T00:00:00.000Z");
  });

  it("does not drift with the machine's timezone", () => {
    // `new Date(y, m, d)` is local; this must be UTC or the mark moves by a
    // day for anyone east or west of London.
    expect(yearMark(new Date("2026-06-19T00:30:00Z")).toISOString())
      .toBe("2026-06-19T00:00:00.000Z");
    expect(yearMark(new Date("2026-06-19T23:30:00Z")).toISOString())
      .toBe("2026-06-19T00:00:00.000Z");
  });
});

describe("the percentage", () => {
  const pct = (base: number, now: number) => ((now - base) / base) * 100;

  it("reproduces the measured figure", () => {
    // Vestige, 2026-11-07: open 1.4015 on the mark, 1.4716 live.
    expect(pct(1.4015, 1.4716)).toBeCloseTo(5.00, 2);
  });

  it("is materially different from the close-based figure", () => {
    // The field the baseline reads is not a detail: 2.61% against 5.00%.
    expect(pct(1.4342, 1.4716)).toBeCloseTo(2.61, 2);
    expect(Math.abs(pct(1.4015, 1.4716) - pct(1.4342, 1.4716)))
      .toBeGreaterThan(2);
  });

  it("goes negative when $U lags ALGO, which is the case that must not be green", () => {
    expect(pct(1.4015, 1.3000)).toBeLessThan(0);
    expect(pct(1.4015, 1.3000)).toBeCloseTo(-7.24, 2);
  });
});
