"use client";

// A 2.5-second arrival for a product page.
//
// ── Why this is shared ─────────────────────────────────────────────────────
// /magnetfi had the only one, and /trade needed the same thing with a different
// mark. Copying it would have put the timing, the reduced-motion handling and
// the backdrop-root constraint in two places, and this session has already
// watched two such pairs drift apart — a disclosure that fell out of step with
// the group it described, and a fee table that was measured in one place and
// guessed in the other. One implementation, two marks.
//
// ── What it must never do ──────────────────────────────────────────────────
// Gate the content. The page renders underneath on first paint and this removes
// itself — blocking render would make it a 2s tax on every visit, which is the
// opposite of feeling fast. It carries `pointer-events-none` throughout, so
// anyone who wants to start clicking can, immediately, without waiting it out.
//
// ── Why it starts below the nav ────────────────────────────────────────────
// Covering the navbar reads as a page load. Leaving it live, with the blur
// starting underneath, reads as moving INTO something — which is the feeling
// being bought.
//
// ── The backdrop-filter trap ───────────────────────────────────────────────
// This blurs the live page behind it, so it must not be rendered inside any
// element with a running opacity animation: such an element becomes a BACKDROP
// ROOT and a descendant's `backdrop-filter` then samples only the transparent
// subtree, silently doing nothing. That is not hypothetical — it is how the pool
// cards lost their blur when an entrance animation was added to their section
// wrapper. Mount this as a sibling of the page content, never as its child.

import { useEffect, useState, type ReactNode } from "react";

/**
 * Total duration, in ms, for all three arrivals.
 *
 * This was once per-page — MagnetFi's wordmark is one object taken in at a
 * glance, while the Trading Terminal's was a mark, a rule and a subtitle, so
 * 2000 there read as hurried against 2500. The terminal has since lost its
 * icon and the three arrivals are now the same shape, so they run the same
 * length: "how long is the splash" has a single answer, and no page overrides
 * it.
 *
 * The keyframes are written against `--splash-dur` rather than a literal, so
 * this value drives the CSS instead of being mirrored by it. Mirroring is what
 * put the fee table out of step with the group it described, twice.
 */
export const DEFAULT_MS = 2500;

export function ArrivalSplash({
  mark,
  subtext,
  durationMs = DEFAULT_MS,
}: {
  mark: ReactNode;
  subtext: string;
  durationMs?: number;
}) {
  /**
   * Starts true so the splash is present in the FIRST paint.
   *
   * Mounting it in an effect instead would show the bare page for a frame and
   * then cover it, which reads as a glitch rather than an arrival.
   */
  const [show, setShow] = useState(true);

  useEffect(() => {
    /**
     * Honour reduced motion by removing it outright rather than shortening it.
     * A brief flash is still motion, and the setting asks not to animate, not to
     * animate faster.
     *
     * Read in an effect, never during render: `matchMedia` does not exist on the
     * server, and branching on it during render would make the server and the
     * client disagree about what to paint.
     */
    const reduced = typeof window !== "undefined"
      && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) { setShow(false); return; }

    const t = setTimeout(() => setShow(false), durationMs);
    return () => clearTimeout(t);
  }, [durationMs]);

  if (!show) return null;

  // `top-16` is the navbar's height: the blur starts under it, so the nav
  // stays legible and usable throughout. `--splash-dur` drives every `splash-*`
  // keyframe, set on both layers so the timeout and the animations cannot
  // disagree about how long this lasts.
  const frame = "pointer-events-none fixed inset-x-0 bottom-0 top-16 z-40";
  const dur = { ["--splash-dur" as string]: `${durationMs}ms` };

  return (
    <>
      {/* ── Scrim and content are SIBLINGS, and that is load-bearing twice ──
          The scrim carries the blur and holds nothing, because every mark has a
          filter of its own (`magnet-glow-soft`, or a drop-shadow utility) plus a
          scale animation. A filtered element is promoted to its own compositing
          layer, the backdrop is sampled per layer, and the sampling changes at
          that layer's edge — painting a faint rectangle exactly the size of the
          image. Phones show it, desktops usually do not: mobile GPUs composite
          at lower precision, so the seam survives rounding there.

          But the scrim also must not be a CHILD of anything running an opacity
          animation, which is the trap described at the top of this file: such an
          element is a backdrop root, and a descendant's `backdrop-filter` then
          samples only the transparent subtree and silently does nothing. Nesting
          the scrim inside the animated wrapper is precisely how the desktop blur
          was lost while fixing the mobile box.

          Two fixed siblings, each animating its own opacity, satisfies both: the
          scrim has no filtered descendants, and no animated ancestor.

          ── Why both layers are promoted with `transform-gpu` ──
          The rectangle survived the sibling split on COLD loads only: a brand
          new browser instance showed it, and a reload or an in-app navigation
          did not. The difference between those two is not markup, it is whether
          the mark's PNG is already in cache.

          Every mark carries a filter, so it composites on its own layer — but
          on a cold load that layer materialises when the image DECODES, which is
          after the scrim has already rasterised its backdrop. A layer appearing
          over an existing backdrop-filter region does not reliably make mobile
          WebKit re-sample the backdrop beneath its bounds, and what shows
          through is a rectangle exactly the size of the image.

          `transform-gpu` makes both layers exist from the first frame instead:
          the scrim's backdrop sampling is established before any content paints,
          and the mark's box is reserved by next/image's width/height, so its
          layer has stable bounds before the pixels arrive. Nothing appears
          late, so nothing composites over a stale backdrop. */}
      <div
        aria-hidden="true"
        className={`animate-splash transform-gpu ${frame} bg-black/55 backdrop-blur-md`}
        style={dur}
      />

      <div
        aria-hidden="true"
        className={`animate-splash ${frame} flex items-center justify-center overflow-hidden`}
        style={dur}
      >
      {/* The glow is its own element so it can breathe on a different curve — a
          single animated group makes the light and the mark move together like
          a flat sticker. */}
      <div className="animate-splash-glow absolute h-[36rem] w-[36rem] rounded-full bg-magnet-500/25 blur-[120px]" />

      {/* Mark, rule, subtext — the landing page's own arrangement, so every
          arrival reads as the same brand rather than a new one each time. The
          rule and subtext land AFTER the mark: together reads as one image
          appearing, staggered reads as a thing being introduced. */}
      <div className="relative flex flex-col items-center px-6 text-center">
        <div className="animate-splash-mark transform-gpu">{mark}</div>
        <div className="animate-splash-rule mt-5 h-px w-32 bg-gradient-to-r from-transparent via-white/50 to-transparent" />
        <p className="animate-splash-sub font-display mt-4 max-w-md text-sm font-semibold leading-relaxed text-white/80 sm:text-base">
          {subtext}
        </p>
      </div>
      </div>
    </>
  );
}
