// Perps — open interest on the card: one side, named correctly, zero spelled out.
//
// Source-text assertions, as in perpsAudit10 and perpsFundingDisplay: the value
// is a `useMemo` inside a component needing live market data, a wallet and an
// oracle, and the failures these pin are all "a correct value stopped being
// shown" — which no behavioural test in this suite would catch.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const cardSrc = readFileSync("src/components/strategy/perps/PerpsCard.tsx", "utf8");
const block = cardSrc.slice(
  cardSrc.indexOf("{view.openInterest && ("),
  cardSrc.indexOf("{view.funding && !view.funding.charged && ("),
);

describe("it is open interest, not pool utilisation", () => {
  // The bar measures `max_open_interest_*` — the `oi_headroom` constraint. The
  // POOL's limit is a different check entirely (checkReservesAfterTrade, reason
  // `*_reserves_exceeded`), and the card already calls that one "this market's
  // available liquidity" a few lines above. Naming this bar after that
  // constraint would have the card contradict itself twice on one screen.
  it("reads the open-interest cap, not a pool field", () => {
    expect(cardSrc).toContain("data.state.risk.max_open_interest_long");
    expect(cardSrc).toContain("data.state.risk.max_open_interest_short");
  });

  it("does not call itself pool utilisation", () => {
    expect(block.toLowerCase()).not.toMatch(/pool utilisation|pool utilization/);
    // "OI headroom" names the constraint PEX enforces. The pool's limit is a
    // different check and keeps its own words.
    expect(block).toContain("OI headroom");
  });

  it("keeps the two constraints separately labelled", () => {
    // If these ever read the same, one of them is lying about which check it
    // describes.
    expect(cardSrc).toContain('oi_headroom: "how much room this side of the market has left"');
    expect(cardSrc).toContain('reserves: "this market\'s available liquidity"');
  });

  it("gives them separate explanations, not one merged paragraph", () => {
    // They had distinct LABELS and one shared paragraph that called both of
    // them "this side of the market is nearly full" — which is not what
    // `reserves` is at all. This test passed throughout, ten lines above the
    // paragraph that collapsed them. Audit 11 ship blocker.
    expect(cardSrc).toContain('view.binding === "oi_headroom" && (');
    expect(cardSrc).toContain('view.binding === "reserves" && (');
    expect(cardSrc).not.toContain(
      '(view.binding === "oi_headroom" || view.binding === "reserves")');
  });

  it("explains a cap only when the size is AT it", () => {
    // `binding` describes the bar's maximum, not the chosen size, so these
    // rendered at every slider position — "$100 · limited by how much room this
    // side has left" against a $780 cap. Audit 11 MEDIUM 6.
    expect(cardSrc).toContain("const atCeiling = view.ceilingUsd > 0 && view.notional >= view.ceilingUsd * 0.995;");
    expect(cardSrc).toContain('{view.tradable && atCeiling && view.binding === "oi_headroom" && (');
    expect(cardSrc).toContain('{view.tradable && atCeiling && view.binding === "reserves" && (');
    expect(cardSrc).toContain("{atCeiling && view.binding && (");
  });

  it("never claims the book is full without saying how full it is", () => {
    // `oi_headroom` is OUR policy — OI_HEADROOM_SHARE of the room left — and it
    // binds on an EMPTY book: market 2 was measured at $0 of a $1,560 cap while
    // the card said the side was "nearly full", directly under a bar reading
    // "0% used".
    expect(cardSrc).not.toContain("side of this market is nearly full right");
    const note = cardSrc.slice(
      cardSrc.indexOf('view.binding === "oi_headroom" && ('),
      cardSrc.indexOf('view.binding === "reserves" && ('));
    // It states the share it enforces and the measured utilisation, so the
    // sentence is true at 0% and at 94% without inventing a threshold.
    expect(note).toContain("OI_HEADROOM_SHARE");
    expect(note).toContain("view.openInterest");
    expect(note).not.toMatch(/nearly full/);
  });
});

describe("one side — the one being traded", () => {
  it("selects the cap by side", () => {
    expect(cardSrc).toContain(`    const cap = side === "long"
      ? data.state.risk.max_open_interest_long
      : data.state.risk.max_open_interest_short;`);
  });

  it("recomputes when the side changes", () => {
    // Keyed on `data` alone, the bar would keep showing the previous side's
    // book after the toggle — the exact number the reader is checking, stale.
    expect(cardSrc).toContain("  }, [data, side]);");
  });
});

describe("zero is a state, not an absence", () => {
  // Third instance on this card: open interest showed nothing, funding showed
  // nothing, and both were reported missing when both were truly zero. A cap with
  // nothing against it must still draw.
  it("returns a value when the side is empty, and null only without a cap", () => {
    expect(cardSrc).toContain("if (cap <= BigInt(0)) return null;");
    expect(cardSrc).not.toContain("if (used <= BigInt(0)) return null;");
  });

  it("says so in words rather than drawing an empty bar and stopping", () => {
    expect(block).toContain("0% used");
    expect(block).toContain("nothing open on this side yet");
    expect(block).toContain("cap is free on this side");
  });

  it("still draws the track at zero", () => {
    // The empty track IS the picture of available room; removing it at zero
    // would reintroduce the bug this fixes.
    expect(block).toContain('className="h-1.5 w-full overflow-hidden rounded-full bg-white/10"');
  });
});
