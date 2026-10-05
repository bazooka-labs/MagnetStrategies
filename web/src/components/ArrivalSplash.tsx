"use client";

// A 2-second arrival for a product page.
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
 * Total duration, in ms. Per page, because the two are not the same read.
 *
 * MagnetFi's is a wordmark — one object, taken in at a glance. The Trading
 * Terminal's is a mark, a line of type, a rule and a subtitle: four things to
 * read, so the same 2s felt hurried there while being right for MagnetFi.
 *
 * The keyframes are written against `--splash-dur` rather than a literal, so
 * this value drives the CSS instead of being mirrored by it. Mirroring is what
 * put the fee table out of step with the group it described, twice.
 */
const DEFAULT_MS = 2000;

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

  return (
    <div
      aria-hidden="true"
      // `top-16` is the navbar's height: the blur starts under it, so the nav
      // stays legible and usable throughout.
      className="animate-splash pointer-events-none fixed inset-x-0 bottom-0 top-16 z-40 flex items-center justify-center overflow-hidden bg-black/55 backdrop-blur-md"
      // Drives every `splash-*` keyframe. Set here so the timeout above and the
      // animations cannot disagree about how long this lasts.
      style={{ ["--splash-dur" as string]: `${durationMs}ms` }}
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
        <div className="animate-splash-mark">{mark}</div>
        <div className="animate-splash-rule mt-5 h-px w-32 bg-gradient-to-r from-transparent via-white/50 to-transparent" />
        <p className="animate-splash-sub font-display mt-4 max-w-md text-sm font-semibold leading-relaxed text-white/80 sm:text-base">
          {subtext}
        </p>
      </div>
    </div>
  );
}
