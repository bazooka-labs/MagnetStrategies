"use client";

// A 1.5-second arrival for /magnetfi.
//
// ── What it is for ─────────────────────────────────────────────────────────
// The page used to appear the way any page appears. This marks entering a
// product rather than loading a route: the wordmark over the real page, blurred
// and dimmed behind it, then gone.
//
// ── What it must never do ──────────────────────────────────────────────────
// Gate the content. The page renders underneath on first paint and this is an
// overlay that removes itself — if it blocked rendering it would be a 1.5s tax
// on every visit, which is the opposite of feeling fast. It also carries
// `pointer-events-none` throughout, so anyone who wants to start clicking can,
// immediately, without waiting it out.
//
// ── Why it starts below the nav ────────────────────────────────────────────
// Covering the navbar would read as a page load. Leaving it live, with the
// blur starting underneath it, reads as moving INTO something — which is the
// feeling being bought here.
//
// ── The backdrop-filter trap ───────────────────────────────────────────────
// This blurs the live page behind it, so it must not sit inside any element
// with a running opacity animation: such an element becomes a BACKDROP ROOT and
// a descendant's `backdrop-filter` then samples only the transparent subtree,
// silently doing nothing. That is not hypothetical — it is exactly how the pool
// cards lost their blur when an entrance animation was added to their section
// wrapper. So this mounts at the top level of the page, as a sibling of the
// animated hero, never as its child.

import { useEffect, useState } from "react";
import Image from "next/image";

/**
 * Fade in, hold, fade out. Sums to 2s.
 *
 * Was 1.5s and read as hurried — the mark arrived and left before it had been
 * taken in. The extra 500ms all goes to the HOLD: lengthening the fades instead
 * would make it feel slow rather than deliberate, which is a different and worse
 * problem.
 */
const IN_MS = 260;
const HOLD_MS = 1380;
const OUT_MS = 360;
const TOTAL_MS = IN_MS + HOLD_MS + OUT_MS;

export function MagnetFiSplash() {
  /**
   * Starts true so the splash is present in the FIRST paint.
   *
   * Mounting it in an effect instead would show the bare page for a frame and
   * then cover it, which reads as a glitch rather than an arrival.
   */
  const [show, setShow] = useState(true);

  useEffect(() => {
    /**
     * Honour reduced motion by removing it immediately rather than shortening
     * it. A brief flash is still motion, and the setting is a request not to
     * animate, not a request to animate faster.
     *
     * Read in an effect, never during render: `matchMedia` does not exist on
     * the server, and branching on it during render would make the server and
     * client disagree about what to paint.
     */
    const reduced = typeof window !== "undefined"
      && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) { setShow(false); return; }

    const t = setTimeout(() => setShow(false), TOTAL_MS);
    return () => clearTimeout(t);
  }, []);

  if (!show) return null;

  return (
    <div
      aria-hidden="true"
      // `top-16` is the navbar's height: the blur starts under it, so the nav
      // stays legible and usable the whole time.
      className="animate-splash pointer-events-none fixed inset-x-0 bottom-0 top-16 z-40 flex items-center justify-center overflow-hidden bg-black/55 backdrop-blur-md"
    >
      {/* The glow sits behind the wordmark and is its own element so it can
          breathe on a different curve — a single animated group would make the
          light and the mark move as one flat sticker. */}
      <div className="animate-splash-glow absolute h-[36rem] w-[36rem] rounded-full bg-magnet-500/25 blur-[120px]" />
      {/* Mark, rule, subtext — the landing page's own arrangement, so arriving
          here reads as the same brand rather than a second one. */}
      <div className="relative flex flex-col items-center px-6 text-center">
        <Image
          src="/magnetfi-logo.png"
          alt=""
          width={1011}
          height={247}
          priority
          className="animate-splash-mark w-[17rem] max-w-[72vw] sm:w-[23rem] lg:w-[28rem] h-auto drop-shadow-[0_0_28px_rgba(168,85,247,0.45)]"
        />
        {/* Same hairline the landing page uses under its headline. */}
        <div className="animate-splash-rule mt-5 h-px w-32 bg-gradient-to-r from-transparent via-white/50 to-transparent" />
        <p className="animate-splash-sub font-display mt-4 max-w-md text-sm font-semibold leading-relaxed text-white/80 sm:text-base">
          Digital Asset Lending and Borrowing on Algorand
        </p>
      </div>
    </div>
  );
}
