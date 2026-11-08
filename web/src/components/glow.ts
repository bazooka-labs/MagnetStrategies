/**
 * Neon glow class strings, in a module with NO `"use client"`.
 *
 * ── Why these cannot live in `components/magnetfi/v2/shared.tsx` ─────────
 * That file is `"use client"`. When a SERVER component imports from a client
 * module, Next does not hand it the value — it hands it a client *reference
 * object*, resolved to the real export only once it crosses the boundary.
 *
 * That works when the import is passed as a PROP:
 *
 *     <Panel glowClass={MAGNET_GLOW} />      // serialized, resolves client-side
 *
 * and it silently fails when it is interpolated into a string on the server:
 *
 *     <div className={`rounded-2xl ${MAGNET_GLOW}`} />   // "[object Object]"
 *
 * Which is exactly what shipped into the YTD box mockup on 2026-11-07: the
 * element rendered with `class="… px-7 py-5 [object Object]"`, no ring, no
 * shadow. Tailwind had generated the rule correctly — the class name never
 * reached the element.
 *
 * ── It will not be caught by the component tests ─────────────────────────
 * jsdom has no server/client boundary, so `tokenHeroCards.test.tsx` renders
 * the real string and passes. The only thing that sees this is the rendered
 * page. Checked by reading `getComputedStyle(...).boxShadow` in a browser,
 * after two rounds of guessing at the geometry got it wrong.
 *
 * ── And why it sits in `components/`, not `lib/` ─────────────────────────
 * Fixing the boundary problem by moving these to `src/lib/glow.ts` broke them
 * a second way: Tailwind's `content` globs are `src/pages`, `src/components`
 * and `src/app` — `src/lib` is NOT scanned, so the classes were never
 * generated. The element then carried the right class name against no CSS
 * rule, and the computed `box-shadow` fell back to Tailwind's default blue
 * ring. Fixing one problem caused the other.
 *
 * So the file has two constraints at once: not a client module, so a server
 * component reads the value; and inside a scanned directory, so the classes
 * exist. `components/glow.ts` is the only place satisfying both without
 * widening the build config. (`src/lib` carries no Tailwind classes today —
 * checked — so the glob gap bites nothing else.)
 *
 * `shared.tsx` re-exports these for the client components that already import
 * from it, which keeps one definition of each string.
 */

/** The house neon: a ring plus a coloured halo, magnet-400. */
export const MAGNET_GLOW =
  "ring-1 ring-magnet-400/60 shadow-[0_0_30px_-2px_rgba(168,85,247,0.8),inset_0_0_14px_-8px_rgba(192,132,252,0.9)]";

/**
 * The same neon one step lighter, for a glowing element INSIDE a glowing card.
 *
 * Stepping the ring to magnet-300 (#d8b4fe) keeps the family while giving the
 * inner element its own boundary: `MAGNET_GLOW` nested in itself is the same
 * hue at the same intensity, with no edge between the two.
 *
 * The geometry is `MAGNET_GLOW`'s exactly, and that matters. A first pass used
 * `0_0_24px_-4px`; a negative spread shrinks the shadow on every side before
 * it blurs, so 4px against a 24px blur left almost nothing outside the ring
 * and read as a plain border rather than a glow.
 */
export const MAGNET_GLOW_300 =
  "ring-1 ring-magnet-300/70 shadow-[0_0_30px_-2px_rgba(216,180,254,0.8),inset_0_0_14px_-8px_rgba(233,213,255,0.9)]";

/** Gold, for the ALGO-family outsider. */
export const ALGO_GLOW =
  "ring-1 ring-amber-300/60 shadow-[0_0_30px_-2px_rgba(251,191,36,0.75),inset_0_0_14px_-8px_rgba(253,224,71,0.9)]";
