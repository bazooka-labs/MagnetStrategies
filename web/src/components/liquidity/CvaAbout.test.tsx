// @vitest-environment jsdom

/**
 * The About modal.
 *
 * Two things are worth binding here, and they are both about HONESTY rather
 * than layout:
 *
 *   1. The APR is labelled with the window it covers. PEX publishes a 7-day
 *      income APR and nothing longer; the longer windows in the bundle are
 *      share-price RETURNS, which include trader P&L the APR excludes. A
 *      future edit that relabels the 7d figure as a 30d one, or annualises a
 *      30-day return into an APR, is the exact mistake this repo already made
 *      and removed — so the "past 7 days" attribution is asserted.
 *   2. The downside is in the body. A modal that explains four ways to earn
 *      and buries the counterparty risk is a brochure, so the presence of the
 *      loss language is a test, not a convention.
 */
import { cleanup, render, screen, fireEvent, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CvaAbout } from "./CvaAbout";
import type { PoolStats } from "@/lib/strategy/performance";

/** Shaped like the real bundle's cva payload on 2026-10-23. */
const STATS: PoolStats = {
  income: {
    totalPct: 7.57, feePct: 1.52, yieldPct: 6.05,
    feeUsd7d: 0.260478, yieldUsd7d: 1.666851,
    windowStart: 1792195200, windowEnd: 1792800000, missingEvents: 0,
  },
  ret: {
    period: "30d", productPct: 5.64, holdPct: -4.0, vsHoldingPoints: 9.64,
    benchmarkKind: "geometric_mean_50_50", points: 30, hasGaps: false,
  },
  retUnavailableReason: null,
  returns: {
    "7d": { period: "7d", productPct: 2.90, holdPct: -3.25, vsHoldingPoints: 6.15,
      benchmarkKind: "geometric_mean_50_50", points: 7, hasGaps: false },
    "30d": { period: "30d", productPct: 5.64, holdPct: -4.0, vsHoldingPoints: 9.64,
      benchmarkKind: "geometric_mean_50_50", points: 30, hasGaps: false },
    "90d": { period: "90d", productPct: 15.27, holdPct: 6.03, vsHoldingPoints: 9.24,
      benchmarkKind: "geometric_mean_50_50", points: 43, hasGaps: true },
  },
  reasons: { total: "insufficient_history" },
};

afterEach(cleanup);

const openIt = (stats: PoolStats | null = STATS, stale = false) => {
  render(<CvaAbout stats={stats} stale={stale} />);
  fireEvent.click(screen.getByRole("button", { name: /About/ }));
  return screen.getByRole("dialog");
};

describe("the trigger", () => {
  it("shows nothing until pressed", () => {
    render(<CvaAbout stats={STATS} stale={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens and closes", () => {
    render(<CvaAbout stats={STATS} stale={false} />);
    fireEvent.click(screen.getByRole("button", { name: /About/ }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the rate it was opened for", () => {
  it("shows PEX's APR and its two components", () => {
    const d = openIt();
    expect(within(d).getByText("7.57%")).toBeTruthy();
    expect(within(d).getByText(/1\.52% fees \+ 6\.05% yield/)).toBeTruthy();
  });

  it("attributes the APR to a 7-DAY window, never a longer one", () => {
    // PEX publishes no 30-day APR. Relabelling this is the failure mode.
    const d = openIt();
    expect(within(d).getByText(/past 7 days/)).toBeTruthy();
    const apr = within(d).getByText("7.57%").parentElement?.parentElement?.textContent ?? "";
    expect(apr).not.toMatch(/30[- ]?day/i);
  });

  it("shows every window PEX published, as a return rather than a rate", () => {
    const d = openIt();
    expect(within(d).getByText("+2.90%")).toBeTruthy();
    expect(within(d).getAllByText("+5.64%").length).toBeGreaterThan(0);
    expect(within(d).getByText("+15.27%")).toBeTruthy();
    // Never annualised — a 30-day run extrapolated to a year reads ~100% here.
    expect(within(d).getByText(/not annualised/)).toBeTruthy();
  });

  it("says a window is short of history instead of printing a zero", () => {
    const d = openIt();
    expect(within(d).getByText(/not enough history yet/)).toBeTruthy();
  });

  it("marks a window whose history has gaps", () => {
    const d = openIt();
    expect(within(d).getAllByText(/gaps/).length).toBeGreaterThan(0);
  });

  it("does not invent a rate when PEX published none", () => {
    const d = openIt({ income: null, ret: null, retUnavailableReason: "unavailable",
      returns: {}, reasons: {} });
    expect(within(d).getByText(/has not published a rate/)).toBeTruthy();
    expect(within(d).queryByText(/%\s*$/)).toBeNull();
  });

  it("flags a stale bundle rather than presenting it as current", () => {
    const d = openIt(STATS, true);
    expect(within(d).getByText("STALE")).toBeTruthy();
  });
});

describe("what it explains", () => {
  it("covers PEX, the counterparty role, the income, and who manages it", () => {
    const d = openIt();
    for (const heading of ["What PEX is", "Who is on the other side",
      "How it earns", "How PEX manages it"]) {
      expect(within(d).getByText(heading), heading).toBeTruthy();
    }
  });

  it("names Ultrade and says the capital is not ours", () => {
    const d = openIt();
    // Twice now — the explainer panel and the audit bullet both name it.
    expect(within(d).getAllByText(/Ultrade/).length).toBeGreaterThan(0);
    expect(within(d).getByText(/custodies none of the money/)).toBeTruthy();
  });

  /**
   * These three moved here when the page's amber caveat panel was removed as
   * PEX-specific page chrome. The panel was the ONLY place each was stated, so
   * these tests exist to make the move permanent: deleting a box is not a
   * reason to stop saying what it said.
   */
  it("keeps the disclosures the removed caveat panel used to carry", () => {
    const d = openIt();
    expect(within(d).getByText(/no external\s+audit/)).toBeTruthy();
    expect(within(d).getByText(/holds no\s+funds and operates no exchange/)).toBeTruthy();
    expect(within(d).getByText(/positive APR can sit\s+alongside a negative return/)).toBeTruthy();
  });

  it("says which figures are chain reads and which are not", () => {
    const d = openIt();
    expect(within(d).getByText(/read directly from the chain/)).toBeTruthy();
  });

  it("states the downside in the body, not as a footnote", () => {
    const d = openIt();
    expect(within(d).getByText(/You can lose money/)).toBeTruthy();
    // The specific mechanism, not just a generic risk warning.
    expect(within(d).getByText(/share price falls when traders win/)).toBeTruthy();
  });

  it("states the round-trip cost and the exit terms", () => {
    const d = openIt();
    expect(within(d).getByText(/0\.2% in and 0\.2% out/)).toBeTruthy();
    expect(within(d).getByText(/\$5 minimum withdrawal/)).toBeTruthy();
  });

  it("says the figures are unsigned, as PEX documents them", () => {
    const d = openIt();
    expect(within(d).getByText(/unsigned/)).toBeTruthy();
  });
});
