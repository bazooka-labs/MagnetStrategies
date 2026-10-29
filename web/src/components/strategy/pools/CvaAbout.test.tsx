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
import { afterEach, describe, expect, it } from "vitest";
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
      benchmarkKind: "geometric_mean_50_50", points: 43, days: 55, hasGaps: true, ...anchor, series: series(15.27, 6.03) },
  },
  reasons: { total: "insufficient_history" },
};

afterEach(cleanup);

const openIt = (stats: PoolStats | null = STATS, stale = false) => {
  render(<CvaAbout stats={stats} stale={stale} />);
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
    // The LADDER is never annualized, even though the card's headline is.
    // That split is the whole design: one derived figure, calibrated by the
    // realised spread beneath it.
    expect(within(d).getByText(/never annualized/)).toBeTruthy();
    // And the modal states the spread explicitly, so the headline cannot be
    // read as the only possible answer.
    expect(within(d).getByText(/\+812%, −26% and \+183%/)).toBeTruthy();
  });

  /**
   * The headline runs the longest window on to the LIVE share price, so its
   * day count is a day or two beyond the ladder's. A reader checking the
   * arithmetic — 90d shows +17.01%, the headline says 57 days — would
   * otherwise find a discrepancy the modal never accounts for.
   */
  /**
   * US spelling throughout the UI, per the correction on "annualised" ->
   * "annualized". The modal is the longest body of copy on the site, so it is
   * where a British form survives unnoticed.
   */
  it("uses US spelling in its copy", () => {
    const d = openIt();
    expect(d.textContent).not.toMatch(/realis(ed|e|ing)\b/i);
    expect(d.textContent).not.toMatch(/annualis/i);
    expect(d.textContent).toMatch(/realized/);
  });

  it("explains why the headline's window is longer than the ladder's", () => {
    const d = openIt();
    expect(within(d).getByText(/run on to the live share price/)).toBeTruthy();
    expect(within(d).getByText(/refreshes between PEX.s daily updates/)).toBeTruthy();
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
