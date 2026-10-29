/**
 * `.glow-teal` is neon, and neon needs an EDGE.
 *
 * The first version of this class was three blurs and nothing else. It
 * rendered as a soft cloud rather than the lit edge the card's own
 * `ring-1 ring-magnet-400/60` produces, and no test noticed, because a blur
 * and a ring are both just `box-shadow` entries. The difference is a term
 * with a 1px SPREAD and no blur — which is exactly what Tailwind's `ring-1`
 * compiles to.
 *
 * This parses the declaration rather than grepping the file: the block is cut
 * out, comments stripped, and only the real `box-shadow` value is examined.
 * The class carries a long comment that mentions rings, blurs and pixel
 * measurements, so a grep over the raw file would pass on the prose alone —
 * the exact failure this repo has already shipped once.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** The declared value of one property in one rule, comments removed. */
function declaration(selector: string, prop: string): string {
  // readFileSync paths are invisible to tsc and have broken twice during
  // renames, so this resolves from the test's own location.
  const css = readFileSync(join(__dirname, "globals.css"), "utf8");
  const at = css.indexOf(`${selector} {`);
  expect(at, `${selector} must exist in globals.css`).toBeGreaterThan(-1);
  const body = css.slice(at + selector.length + 2, css.indexOf("}", at));
  const stripped = body.replace(/\/\*[\s\S]*?\*\//g, "");
  const m = stripped.match(new RegExp(`${prop}\\s*:([^;]+);`));
  expect(m, `${selector} must declare ${prop}`).toBeTruthy();
  return m![1].replace(/\s+/g, " ").trim();
}

describe(".glow-teal", () => {
  const shadow = declaration(".glow-teal", "box-shadow");

  it("carries a 1px ring, not only blurs", () => {
    // `0 0 0 1px <colour>` — no blur, 1px spread. Without this the class is
    // haze: measured, the ringed version peaks well above the card
    // background, the ringless one barely at all.
    expect(shadow).toMatch(/^0\s+0\s+0\s+1px\s+rgba\(/);
  });

  it("never lets the spread cancel the blur", () => {
    /**
     * A shadow reaches `blur/2 + spread` beyond the box. When the spread eats
     * the blur the halo collapses inside the border and the class renders as
     * nothing — which is what `0 0 34px -6px` was blamed for in an earlier
     * revision.
     *
     * Note what this test does NOT claim. "Negative spread" is not itself the
     * bug: the card's own MAGNET_GLOW uses `-2px`, and so does the outer term
     * here, measured at luminance 70.0 against a 38.7 background 8px outside
     * the edge. A first version of this test asserted spread >= 0 and would
     * have failed the shipped, working value. Only rendering can tell a weak
     * glow from an absent one; this catches the geometric case where there
     * cannot be one at all.
     */
    const outer = shadow.split(/,(?![^(]*\))/).filter((t) => !t.includes("inset"));
    expect(outer.length).toBeGreaterThan(1);
    for (const term of outer) {
      const m = term.trim().match(/^(?:-?\d+(?:px)?\s+){2}(\d+)px\s+(-?\d+)px/);
      if (!m) continue; // the ring term has no blur, and is checked above
      const [blur, spread] = [Number(m[1]), Number(m[2])];
      expect(blur / 2 + spread, `${term} reaches nothing outside the box`)
        .toBeGreaterThan(4);
    }
  });

  it("is teal — not the purple frame, and not the figure's own green", () => {
    /**
     * Two colours are wrong here for different reasons.
     *
     * PURPLE: a purple glow on a purple-framed card reads as more frame
     * rather than as a highlight, which is what the box is for.
     *
     * GREEN: the figure inside is conditionally toned — `text-green-400`
     * while the return is positive, `text-red-300` when negative, and the
     * 30-day window has already read −26% on this vault. A glow matching the
     * figure would ring a loss in red; a glow fixed to green would ring one
     * in celebration. Teal belongs to neither state.
     *
     * rgb(45, 212, 191) is `text-teal-400`, read from the rendered page —
     * STAT_TONES.teal, already in use on the token pages' metric boxes.
     */
    for (const term of shadow.split(/,(?![^(]*\))/)) {
      expect(term, term).toMatch(/rgba\(45,\s*212,\s*191/);
      expect(term, term).not.toMatch(/rgba\(74,\s*222,\s*128/);  // green-400
      expect(term, term).not.toMatch(/rgba\(252,\s*165,\s*165/); // red-300
    }
  });
});
