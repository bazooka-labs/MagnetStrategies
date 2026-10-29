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
 *      future edit that relabels the 7d figure as a 30d one, or annualizes a
 *      30-day return into an APR, is the exact mistake this repo already made
 *      and removed — so the "past 7 days" attribution is asserted.
 *   2. The downside is in the body. A modal that explains four ways to earn
 *      and buries the counterparty risk is a brochure, so the presence of the
 *      loss language is a test, not a convention.
 */
import { cleanup, render, screen, fireEvent, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CvaAbout } from "./CvaAbout";
import type { PoolStats } from "@/lib/strategy/pools/performance";

/** Shaped like the real bundle's cva payload on 2026-10-23. */
/** A plausible index series: both start at 1.0, each ends at its own return. */
const series = (productPct: number, holdPct: number, n = 6) =>
  Array.from({ length: n }, (_, k) => ({
    ts: 1_790_000_000 + k * 86_400,
    product: 1 + (productPct / 100) * (k / (n - 1)),
    hold: 1 + (holdPct / 100) * (k / (n - 1)),
  }));

/**
 * The modal renders the ladder as PEX published it and never extends it to the
 * live share price — that is the headline's job. So these fixtures carry no
 * start anchor, which is also the shape of a bundle that omits share prices.
 */
const anchor = { startSharePrice: null, startTs: 0 };

const STATS: PoolStats = {
  income: {
    totalPct: 7.57, feePct: 1.52, yieldPct: 6.05,
    feeUsd7d: 0.260478, yieldUsd7d: 1.666851,
    windowStart: 1792195200, windowEnd: 1792800000, missingEvents: 0,
  },
  ret: {
    period: "30d", productPct: 5.64, holdPct: -4.0, vsHoldingPoints: 9.64,
    benchmarkKind: "geometric_mean_50_50", points: 30, days: 29, hasGaps: false, ...anchor, series: series(5.64, -4.0),
  },
  retUnavailableReason: null,
  returns: {
    "7d": { period: "7d", productPct: 2.90, holdPct: -3.25, vsHoldingPoints: 6.15,
      benchmarkKind: "geometric_mean_50_50", points: 7, days: 6, hasGaps: false, ...anchor, series: series(2.90, -3.25) },
    "30d": { period: "30d", productPct: 5.64, holdPct: -4.0, vsHoldingPoints: 9.64,
      benchmarkKind: "geometric_mean_50_50", points: 30, days: 29, hasGaps: false, ...anchor, series: series(5.64, -4.0) },
    "90d": { period: "90d", productPct: 15.27, holdPct: 6.03, vsHoldingPoints: 9.24,
      benchmarkKind: "geometric_mean_50_50", points: 43, days: 55, hasGaps: true,
      /* Short of its nominal 90, so it is DATED rather than counted. */
      startSharePrice: 1.0, startTs: 1_788_307_200, series: series(15.27, 6.03) },
  },
  reasons: { total: "insufficient_history" },
};

afterEach(() => { cleanup(); vi.useRealTimers(); });

const openIt = (stats: PoolStats | null = STATS, stale = false, sharePrice: number | null = null) => {
  render(<CvaAbout stats={stats} stale={stale} sharePrice={sharePrice} />);
  fireEvent.click(screen.getByRole("button", { name: /Learn more/ }));
  return screen.getByRole("dialog");
};

describe("the trigger", () => {
  it("shows nothing until pressed", () => {
    render(<CvaAbout stats={STATS} stale={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens and closes", () => {
    render(<CvaAbout stats={STATS} stale={false} />);
    fireEvent.click(screen.getByRole("button", { name: /Learn more/ }));
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

  it("keeps the APR, but says outright that it measures something else", () => {
    // It led at 40px under a card headlining +209%, which is the disconnect
    // the rebuild fixed. It stays because it is the only figure isolating
    // what the pool EARNS from what the market did to it.
    const d = openIt();
    expect(within(d).getByText(/A different quantity from/)).toBeTruthy();
    expect(within(d).getByText(/excludes both trader P&L and/)).toBeTruthy();
  });

  it("attributes the APR to a 7-DAY window, never a longer one", () => {
    // PEX publishes no 30-day APR. Relabelling this is the failure mode.
    const d = openIt();
    expect(within(d).getByText(/past 7 days/)).toBeTruthy();
    const apr = within(d).getByText("7.57%").parentElement?.parentElement?.textContent ?? "";
    expect(apr).not.toMatch(/30[- ]?day/i);
  });

  it("shows ONE number per window — the return, never the benchmark gap", () => {
    /**
     * The row used to carry the share-price return AND `+Xpp vs benchmark`
     * beside it. Two numbers on one line read as alternative measures of the
     * same thing, and they are not: the benchmark figure is a DIFFERENCE,
     * how far the vault beat simply holding the assets.
     *
     * The fixture is the real shape of that trap. The 30-day window returned
     * +5.64% against a benchmark that lost 4.0%, so the comparison reads
     * +9.64pp. Showing that as the return overstates it by 71%.
     */
    const d = openIt();
    expect(within(d).getByText("+2.90%")).toBeTruthy();
    expect(within(d).getAllByText("+5.64%").length).toBeGreaterThan(0);
    // Twice now: the ladder row and the chart legend. They are the same
    // measurement and must print identically — the legend used to round to
    // one decimal, so the same number read +15.3% in one place and +15.27%
    // in the other, inviting the reader to treat them as two figures.
    expect(within(d).getAllByText("+15.27%")).toHaveLength(2);

    // The comparison is gone from the ladder entirely.
    expect(within(d).queryByText(/pp vs benchmark/)).toBeNull();
    expect(within(d).queryByText(/\+9\.64/)).toBeNull();
    expect(within(d).queryByText(/\+6\.15/)).toBeNull();
  });

  it("labels windows by their REAL span, not the bundle's period name", () => {
    /**
     * PEX's `7d` holds 7 daily samples spanning 6 days; its `90d` holds 56
     * days of history. Labelling by the period name would claim history the
     * vault does not have — the same error the headline avoids by annualizing
     * the span rather than the label.
     */
    const d = openIt();
    // PEX's 7d carries exactly 7 daily samples and its 30d exactly 30, so
    // those windows are FULL and the publisher's own name for them is right.
    // Printing the interval span — "6 days", "29 days" — made correct
    // figures look like off-by-one bugs.
    expect(within(d).getByText("7 days")).toBeTruthy();
    expect(within(d).getByText("30 days")).toBeTruthy();
    // 90d is the one that is genuinely short: 43 samples against a nominal
    // 90, so it reports its measured span and will say "90 days" on its own
    // once there are 90 days to say it about. The count drifts as history
    // accrues and is deliberately not rounded — see periodDays.
    expect(within(d).getByText("55 days")).toBeTruthy();
    expect(within(d).queryByText("90 days")).toBeNull();
    expect(within(d).queryByText("All time")).toBeNull();
  });

  it("states the one definition it is using", () => {
    const d = openIt();
    expect(within(d).getByText("Holding period returns")).toBeTruthy();
    expect(within(d).getByText(/worth at the start of the window/)).toBeTruthy();
  });

  it("reconciles the ladder with the card's annualized headline", () => {
    /**
     * The disconnect this section was rebuilt to fix: the modal opened with a
     * 4.85% APR directly beneath a card headlining +209%. Both correct, both
     * answering different questions, with nothing joining them.
     *
     * 15.27% over 55 days compounds to +157% a year, computed by the same
     * call the card uses.
     */
    const d = openIt();
    const line = within(d).getByText(/compounds out to/).textContent ?? "";
    expect(line).toMatch(/\+15\.27% over 55 days/);
    expect(line).toMatch(/\+157% a year/);
  });

  it("quotes the LIVE window, and its arithmetic actually holds", () => {
    /**
     * The first version of this sentence read "+17.15% over 56 days compounds
     * out to +232% a year" — the return and span from PEX's bundle, the
     * annualized figure from the live share price. Both numbers were real and
     * the sentence joining them was false: 17.15% over 56 days compounds to
     * 181%, not 232%. A reader checking it would have found the error.
     *
     * So all three figures now come from the one `pickLongest` result. This
     * recomputes the compounding from the rendered text, which is the only
     * way the assertion cannot drift along with the bug.
     */
    const START = 1_790_000_000;
    const withAnchor: PoolStats = {
      ...STATS,
      returns: {
        "90d": { ...STATS.returns["90d"]!, days: 55, productPct: 15.27,
          startSharePrice: 1.0, startTs: START },
      },
    };
    vi.setSystemTime(new Date((START + 58 * 86_400) * 1000));
    // Live price 1.21 over 58 days = +21.00%, not the bundle's +15.27%/55d.
    const d = openIt(withAnchor, false, 1.21);
    const line = within(d).getByText(/compounds out to/).textContent ?? "";

    const m = line.match(/\+([\d.]+)% over (\d+) days compounds out to \+(\d+)% a year/);
    expect(m, `could not parse: ${line}`).toBeTruthy();
    const [realised, days, annual] = m!.slice(1).map(Number);

    expect(realised).toBeCloseTo(21.0, 1);
    expect(days).toBe(58);
    // The claim the sentence makes, recomputed.
    expect(annual).toBe(Math.round((Math.pow(1 + realised / 100, 365 / days) - 1) * 100));
    // And it says why this window outruns the row above it.
    expect(line).toMatch(/3 days fresher than the row above/);
  });

  it("omits the freshness clause when there is no live price to extend to", () => {
    const d = openIt();
    const line = within(d).getByText(/compounds out to/).textContent ?? "";
    expect(line).not.toMatch(/fresher than the row above/);
  });

  it("says plainly that the benchmark gap is not a return", () => {
    const d = openIt();
    expect(within(d).getByText(/That distance is not a return/)).toBeTruthy();
  });

  it("omits a window it has no history for, rather than printing a zero", () => {
    // Only 7d exists here. The danger was ever showing "30 days 0.00%" for a
    // window PEX could not compute; listing only what exists removes it.
    const d = openIt({
      income: null, ret: null, retUnavailableReason: null,
      returns: { "7d": STATS.returns["7d"] },
      reasons: { "30d": "insufficient_history" },
    });
    expect(within(d).getByText("7 days")).toBeTruthy();
    expect(within(d).queryByText("30 days")).toBeNull();
    expect(within(d).queryByText(/0\.00%/)).toBeNull();
  });

  it("shows the sample count instead of a gaps warning", () => {
    /**
     * `· gaps` in amber came off on 2026-10-29. The underlying fact stays:
     * the longest window carries 48 samples across 56 days, so days really
     * are missing. An amber tag made an ordinary property of a daily feed
     * look like a fault; the two counts say the same thing plainly.
     */
    const d = openIt();
    expect(within(d).queryByText(/gaps/i)).toBeNull();
    expect(within(d).getByText(/daily samples across/)).toBeTruthy();
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
  it("carries the detail the card no longer shows", () => {
    // "Managed by PEX · spans both markets" came off the card on 2026-10-28.
    // Both halves of it must survive here or the fact is simply gone.
    const d = openIt();
    expect(within(d).getByText(/spans\s+both markets/)).toBeTruthy();
    expect(within(d).getByText(/ALGO\/USD and BTC\/USD/)).toBeTruthy();
    expect(within(d).getByText("How PEX manages it")).toBeTruthy();
  });

  it("says what you actually deposit", () => {
    // "Takes ALGO + USDC" came off the card on 2026-10-28. The modal already
    // covered the allocation and the rebalancing, but never named the assets
    // — so this was the one fact the move would otherwise have deleted.
    const d = openIt();
    expect(within(d).getByText(/You deposit/)).toBeTruthy();
    expect(within(d).getAllByText(/ALGO \+ USDC/).length).toBeGreaterThan(0);
  });

  it("explains the three sources the card no longer lists", () => {
    // "Returns are generated by earnings from opposite trade positions,
    // ALGO/USDC price movement, and pool swap fees" came off the card on
    // 2026-10-28. All three must survive here, in contribution order.
    const d = openIt();
    const panel = within(d).getByText("How it earns").parentElement;
    const text = (panel?.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toMatch(
      /opposite trade\s*positions.*ALGO\/USDC price\s*movement.*swap fees/,
    );
  });

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
    expect(within(d).getByText(/about 0\.4% behind/)).toBeTruthy();
  });

  /**
   * The spread is NOT a fee to PEX, and saying so is a claim about someone
   * else's deployed contract — so it is pinned rather than left to prose that
   * a future edit might "simplify" back into "costs 0.2%".
   *
   * Verified against the deployed program (sha256 b2fd9b6f…, matching our
   * pin): the burn-spread routine is `proto 1 1` and transfers nothing, every
   * outbound payment goes to `txn Sender` or a market app address, and no
   * global holds a fee destination or accumulator.
   */
  it("says the spread stays in the vault and is not a fee to PEX", () => {
    const d = openIt();
    expect(within(d).getByText(/stays in the vault/)).toBeTruthy();
    expect(within(d).getByText(/not a fee to PEX/)).toBeTruthy();
    expect(within(d).getByText(/nobody collects it/)).toBeTruthy();
  });

  it("names the concrete number a depositor will actually see", () => {
    // The report that prompted this was "$25 in, $24.95 arrived". An
    // explanation that never shows the arithmetic does not answer it.
    const d = openIt();
    expect(within(d).getByText(/\$25 deposit becomes about\s+\$24\.95/)).toBeTruthy();
  });

  it("explains who the spread protects, not just where it lands", () => {
    const d = openIt();
    expect(within(d).getByText(/stale valuation/)).toBeTruthy();
    expect(within(d).getByText(/collect it when others do/)).toBeTruthy();
  });

  it("says the figures are unsigned, as PEX documents them", () => {
    const d = openIt();
    expect(within(d).getByText(/unsigned/)).toBeTruthy();
  });
});
