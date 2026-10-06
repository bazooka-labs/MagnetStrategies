// The collapsible exits on the order card.
//
// Folding is a presentation change that can become a safety change, so these
// pin the three rules that keep it one: a set value stays visible, a broken
// value forces itself open, and neither starts open just because it exists.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const cardSrc = readFileSync("src/components/strategy/perps/PerpsCard.tsx", "utf8");

describe("folding hides controls, never commitments", () => {
  it("shows the set price in the collapsed header", () => {
    // The whole licence for folding a take-profit away. Without this the card
    // would hide the fact that an exit order rides along with the open.
    expect(cardSrc).toContain('summary={view.tpEmpty ? "None" : `$${view.tpPrice}`}');
    expect(cardSrc).toContain('summary={view.slEmpty ? "None" : `$${view.slPrice}`}');
  });

  it("reads the summary from the frozen snapshot, not live state", () => {
    // Mid-signature the live values keep moving; the header must say what the
    // user is actually signing, like every other figure on the card.
    expect(cardSrc).not.toContain('summary={tpEmpty ?');
    expect(cardSrc).not.toContain('summary={slEmpty ?');
  });
});

describe("a problem forces the body open", () => {
  it("ors the problem into the shown state", () => {
    // Otherwise a disabled submit button has its explanation folded out of
    // sight, which is worse than the busy card this replaces.
    expect(cardSrc).toContain("const shown = open || !!problem;");
    expect(cardSrc).toContain("{shown && children}");
  });

  it("treats an out-of-bounds target and a stop past liquidation as problems", () => {
    expect(cardSrc).toContain("problem={!view.tpEmpty && !view.tpValid}");
    expect(cardSrc).toContain("problem={!view.slEmpty && (!view.slValid || view.slPastLiquidation)}");
  });

  it("colours the summary amber when there is one", () => {
    expect(cardSrc).toContain('problem ? "text-amber-300/90" : "text-white/45"');
  });
});

describe("both start folded", () => {
  it("defaults to closed", () => {
    expect(cardSrc).toContain("const [tpOpen, setTpOpen] = useState(false);");
    expect(cardSrc).toContain("const [slOpen, setSlOpen] = useState(false);");
  });

  it("keeps the toggle accessible", () => {
    expect(cardSrc).toContain("aria-expanded={shown}");
  });
});
