// Perps — funding on the card: zero is a state, and the direction is read.
//
// Both rules below were broken or at risk in the same block of JSX, and neither
// is reachable from a unit test: the value is a `useMemo` inside a component
// that needs live market data, a wallet and an oracle. So these assert the
// source, in the style of perpsAudit10.test.ts and for the same reason — the
// house failure mode here is a guard quietly disappearing while every other
// test stays green.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const cardSrc = readFileSync("src/components/strategy/perps/PerpsCard.tsx", "utf8");

describe("a market charging no funding says so", () => {
  // BTC published saved_factor_milli_bps=0 and saved_factor_side=0 — adaptive
  // funding on, controller unramped, nobody paying. The memo returned null on
  // that, so the whole funding line vanished and the absence was reported as a
  // missing feature while ALGO showed a rate on the same screen.
  it("returns a not-charged state rather than null on a zero factor", () => {
    expect(cardSrc).toContain("if (factor <= 0) return { charged: false as const, ceilingPct };");
  });

  it("renders that state instead of nothing", () => {
    expect(cardSrc).toContain("{view.funding && !view.funding.charged && (");
    expect(cardSrc).toContain("No funding is being charged here right now");
  });

  it("still hides a zero INTERVAL, which is unreadable rather than free", () => {
    // A zero interval cannot be annualised: that is missing data, and the two
    // must not collapse into the same branch.
    expect(cardSrc).toContain("if (interval <= 0) return null;");
  });
});

describe("the paying side is read, never inferred", () => {
  // AUDIT.md item 16: "Check that the direction is read from `saved_factor_side`
  // and never inferred from the imbalance." A one-sided book makes guessing
  // tempting and the zero branch is exactly where it would creep in, so this
  // pins both halves.
  it("derives youPay from saved_factor_side", () => {
    expect(cardSrc).toContain("payingSide === (side === \"long\" ? 1 : 2)");
  });

  it("names no side when no paying side is recorded", () => {
    // The not-charged copy must not say who will pay next. The only sides it
    // may mention are "neither" and the generic "paying side".
    const zero = cardSrc.slice(
      cardSrc.indexOf("No funding is being charged here right now"),
      cardSrc.indexOf("{view.funding?.charged && ("),
    );
    expect(zero).toContain("neither side is paying the other");
    expect(zero).not.toMatch(/you (will|would) pay|your side|longs? pay|shorts? pay/i);
  });

  it("stays silent when a positive factor has no readable side", () => {
    expect(cardSrc).toContain("if (payingSide !== 1 && payingSide !== 2) return null;");
  });
});

describe("the ceiling is the on-chain clamp", () => {
  // Quotable because it is the field saved_factor is clamped to — ALGO sits at
  // exactly max_factor_milli_bps. The RAMP is undocumented on our side, so the
  // copy must not claim when the rate moves or in whose favour.
  it("annualises max_factor_milli_bps, not a constant", () => {
    expect(cardSrc).toContain("annual(Number(data.state.adaptive.max_factor_milli_bps))");
  });
});
