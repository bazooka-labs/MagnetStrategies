"use client";

// /strategy's arrival.
//
// ── Why the house banner rather than a product mark ───────────────────────
// /tokens leads with the $U mark and /magnetfi with the MagnetFi wordmark,
// because each stands for one asset or one protocol we wrote. Strategy is
// neither: it is a shelf. Today it holds the PEX pools; the tab bar beside it
// exists because more will sit next to them. There is no single product to put
// a mark on, so the arrival uses the organisation's own banner — the same
// wordmark the landing page opens with, which is what a shelf of Magnet
// strategies is actually branded as.
//
// The duration, the reduced-motion handling and the backdrop-root constraint
// all live in ArrivalSplash — read the note there before moving this.

import Image from "next/image";
import { ArrivalSplash } from "@/components/ArrivalSplash";

export function StrategySplash() {
  return (
    <ArrivalSplash
      subtext="Explore the Opportunities in DeFi"
      mark={
        <Image
          // The TIGHT crop, as the landing page uses. /magnet-wordmark.png is
          // an 877x284 canvas holding an 815x226 mark, padded unevenly — at
          // splash scale that padding becomes a visible gap between the mark
          // and the rule below it. The navbar keeps the padded original.
          src="/magnet-wordmark-tight.png"
          alt=""
          width={815}
          height={226}
          priority
          /**
           * ── Sizing: MagnetFi's classes, exactly ──
           * These are the two wordmark arrivals, so equal width reads as equal
           * prominence. This was w-[16rem]/24/30 with max-w-[76vw], which was
           * both wider than MagnetFi's and — because the wordmark is 815x226
           * (3.61:1) against the logo's 1011x247 (4.09:1) — 21% taller at lg.
           * Matched on width; the residual height difference from the aspect
           * ratio is ~13% and reads as the same size.
           *
           * ── Glow: the shared class, not an inline one-off ──
           * `magnet-glow-soft` is what the landing page puts on THIS asset and
           * what TokensSplash uses. MagnetFi's inline
           * drop-shadow-[0_0_28px_...] is the outlier, so this follows the two
           * that agree rather than the one that does not.
           *
           * The radial bloom BEHIND the mark is not here at all — it is
           * `animate-splash-glow` in ArrivalSplash, an absolute sibling painted
           * before the mark, shared by all four arrivals.
           */
          className="magnet-glow-soft w-[17rem] max-w-[72vw] sm:w-[23rem] lg:w-[28rem] h-auto"
        />
      }
    />
  );
}
