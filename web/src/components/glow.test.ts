/**
 * Where the glow constants may live, and who may import them from where.
 *
 * ── Two failures this encodes, both invisible to the component tests ─────
 * The YTD box shipped into a mockup on 2026-11-07 with no glow at all, and
 * it took reading `getComputedStyle(...).boxShadow` in a real browser to see
 * why — twice, because fixing the first cause created the second.
 *
 *   1. `components/magnetfi/v2/shared.tsx` is `"use client"`. A SERVER
 *      component importing from it receives a client-reference object, not
 *      the string. Passed as a prop it resolves after crossing the boundary
 *      (`<Panel glowClass={MAGNET_GLOW} />` works); interpolated into a
 *      className on the server it stringifies, and the element rendered
 *      `class="… [object Object]"`.
 *
 *   2. Moving the constants to `src/lib/glow.ts` fixed that and broke it
 *      again: Tailwind's `content` globs are `src/pages`, `src/components`
 *      and `src/app`. `src/lib` is not scanned, so the classes were never
 *      generated — correct class name, no CSS rule, and the computed shadow
 *      fell back to Tailwind's default blue ring.
 *
 * jsdom has no server/client boundary and runs no Tailwind, so
 * `tokenHeroCards.test.tsx` renders the real string against no stylesheet
 * and passes either way. It cannot catch these. This file asserts the two
 * structural conditions instead, which is the part that CAN be checked
 * without a browser.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");
const glow = read("src/components/glow.ts");
const shared = read("src/components/magnetfi/v2/shared.tsx");
const magnet = read("src/components/tokens/MagnetTokenView.tsx");
const tailwind = read("tailwind.config.ts");

describe("the glow module's location", () => {
  it("is NOT a client module", () => {
    // A `"use client"` here puts every consumer back on the reference-object
    // path, and the symptom is a silent [object Object] in a className.
    expect(glow).not.toMatch(/^\s*["']use client["']/);
  });

  it("sits in a directory Tailwind actually scans", () => {
    // `src/lib` is not in `content`. A glow defined there generates no CSS.
    expect(tailwind).toContain('"./src/components/**/*.{js,ts,jsx,tsx,mdx}"');
    // The file is under src/components/ by virtue of this path resolving.
    expect(glow.length).toBeGreaterThan(0);
  });

  it("defines each glow once, with shared.tsx re-exporting", () => {
    // Two copies drift the first time one is tuned.
    expect(glow).toContain("export const MAGNET_GLOW =");
    expect(glow).toContain("export const MAGNET_GLOW_300 =");
    expect(glow).toContain("export const ALGO_GLOW =");
    expect(shared).toContain('export { ALGO_GLOW, MAGNET_GLOW, MAGNET_GLOW_300 } from "@/components/glow"');
    expect(shared).not.toMatch(/export const (MAGNET_GLOW|ALGO_GLOW)\s*=/);
  });
});

describe("the server component imports from the right place", () => {
  it("MagnetTokenView takes its glows from @/components/glow", () => {
    // It is a server component — no "use client" — so this is the only
    // import that yields the actual strings.
    expect(magnet).not.toMatch(/^\s*["']use client["']/);
    expect(magnet).toContain('from "@/components/glow"');
    expect(magnet).not.toMatch(
      /import \{[^}]*GLOW[^}]*\} from "@\/components\/magnetfi\/v2\/shared"/);
  });
});

describe("the glow geometry", () => {
  it("keeps a -2px spread, not a larger negative one", () => {
    /*
      A first pass used `0_0_24px_-4px`. Negative spread shrinks the shadow
      on every side BEFORE it blurs, so 4px against a 24px blur left almost
      nothing outside the ring — it read as a plain border, which is exactly
      how it was reported.
    */
    for (const name of ["MAGNET_GLOW", "MAGNET_GLOW_300", "ALGO_GLOW"]) {
      const line = glow.split("\n").find((l) => l.includes(`${name} =`));
      const body = glow.slice(glow.indexOf(line!), glow.indexOf(";", glow.indexOf(line!)));
      expect(body, name).toContain("0_0_30px_-2px");
    }
  });

  it("gives the nested glow a lighter ring than the card it sits in", () => {
    // Same hue at the same intensity nested in itself reads as one smeared
    // halo rather than two objects.
    expect(glow).toContain("ring-magnet-400/60");   // the card
    expect(glow).toContain("ring-magnet-300/70");   // the box inside it
  });
});
