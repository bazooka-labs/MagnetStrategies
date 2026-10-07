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
    expect(cardSrc).toContain("problem={!view.tpEmpty && (!view.tpValid || view.bothLegs)}");
    expect(cardSrc).toContain(
      "problem={!view.slEmpty && (!view.slValid || view.slPastLiquidation || view.bothLegs)}");
  });

  it("covers EVERY state that disables submit", () => {
    // This is the property the describe above claims, and the old version of
    // this test did not check it — it matched two expressions and passed while
    // `bothLegs` disabled the button with its reason nowhere on the card.
    //
    // `canSubmit` requires `tpOk && slOk`. Enumerate what can falsify them:
    //   tpOk  = tpEmpty || tpValid              -> !tpEmpty && !tpValid
    //   slOk  = (slEmpty || slValid) && !bothLegs -> !slEmpty && !slValid
    //                                            -> bothLegs
    // Each must appear in a `problem` expression, or be explained some other
    // way on the card. The first two are in the two sections; the third is
    // both — and carries its own sentence, asserted below.
    expect(cardSrc).toContain("const slOk = (slEmpty || slValid) && !bothLegs;");
    expect(cardSrc).toContain("const tpOk = tpEmpty || tpValid;");
    const tp = cardSrc.slice(cardSrc.indexOf("problem={!view.tpEmpty"));
    const sl = cardSrc.slice(cardSrc.indexOf("problem={!view.slEmpty"));
    expect(tp.slice(0, 120)).toContain("view.bothLegs");
    expect(sl.slice(0, 160)).toContain("view.bothLegs");
  });

  it("says why, in words, when both exits are set", () => {
    // The state had two references in the whole file, both in logic and none
    // in JSX: both sections folded, white summaries, every input accepted, and
    // a grey button. Audit 11 HIGH 4.
    expect(cardSrc).toContain("{view.bothLegs && (");
    expect(cardSrc).toContain("A take-profit and a stop-loss cannot be set on the same order yet");
  });

  it("freezes it, like every other displayed value", () => {
    expect(cardSrc).toContain("  bothLegs: boolean;");
    expect(cardSrc).toMatch(/const live: CardSnapshot = \{[\s\S]*?bothLegs,/);
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
