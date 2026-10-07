"use client";

// /tokens' arrival: the Magnet mark and the promise, nothing else.
//
// ── Why the parent mark and not a token icon ───────────────────────────────
// This page holds two assets — $U and mUSD — so leading with either one's icon
// would announce the wrong half. The parent mark covers both, and the subtext
// is the line the landing page already uses to say what Magnet is for, so a
// visitor arriving here from there sees a promise they have just been made
// rather than a new claim.
//
// ── Why the Magnet Strategies banner is NOT used ───────────────────────────
// It is reserved for the Strategy page. Spending the organisation's full
// lockup on a token page would leave that arrival with nothing of its own to
// say, and a mark means less each time it is used for something smaller than
// itself.
//
// Timing, the blur, the reduced-motion rule and the backdrop-root constraint
// all live in ArrivalSplash — read the note there before moving this.

import Image from "next/image";
import { ArrivalSplash } from "@/components/ArrivalSplash";

export function TokensSplash() {
  return (
    <ArrivalSplash
      // The 2s default: a mark, a rule and one line is the same weight as
      // MagnetFi's wordmark, and the longer hold the Trading Terminal needed
      // was for a fourth element this does not have.
      subtext="Attract Yield, Attract Liquidity"
      mark={
        <Image
          // The TIGHT crop, not /magnet-icon.png.
          //
          // That file is a 500-square canvas holding a 316x222 glyph — 139px of
          // transparent padding above and below, 56% of its height invisible.
          // Scaling it to 14rem scaled the padding too, leaving ~62px of nothing
          // between the mark and the rule where MagnetFi's wordmark, which is
          // 91% glyph, leaves none. The gap was in the asset, not the layout.
          //
          // A separate file rather than a recrop of the original: the navbar and
          // the footer use the square one, where the padding is what keeps the
          // mark off its own edges.
          src="/magnet-mark.png"
          alt=""
          width={316}
          height={222}
          priority
          // Sized so the GLYPH lands where it did before — the previous w-48 /
          // sm:w-56 square rendered it 121px and 142px wide. Only the dead space
          // is gone.
          className="magnet-glow-soft h-auto w-32 sm:w-36"
        />
      }
    />
  );
}
