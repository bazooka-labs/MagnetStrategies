"use client";

// /tokens' arrival: the mUSD mark and the promise, nothing else.
//
// ── Why the mUSD mark ──────────────────────────────────────────────────────
// Two marks preceded it. The Magnet Strategies "m" came first, on the
// reasoning that the page held two assets — $U and mUSD — so leading with
// either one would announce the wrong half. That was overruled for the $U
// mark, because $U was the page's default tab.
//
// Both premises died on 2026-11-04, when $U moved to /strategy. One asset is
// left, so the mark is simply its own, and the question the earlier notes were
// arguing about no longer exists.
//
// ── Which mUSD file, and why not the one the hero uses ────────────────────
// `/musd-icon.png` is the app-icon crop: a full-bleed opaque purple square. It
// is right for the 56px hero tile and wrong here, because every other arrival
// is transparent artwork composited onto the scrim, and a square of flat
// colour beside the rule reads as a block rather than a mark. This is the
// brand file instead — a white glyph on transparency, the same shape of asset
// as the "m" and the $U magnet.
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
          // Cropped to its opaque pixels (383x392 out of a 500x500 canvas with
          // asymmetric padding) for the same reason the "m" and the $U magnet
          // were: scaling a padded canvas scales the padding, and the gap to
          // the rule below would come from the asset rather than the layout.
          src="/tokens/musd-mark.png"
          alt=""
          width={383}
          height={392}
          priority
          // Sized by AREA, then deliberately 15% over it.
          //
          // The area rule comes first: the "m" is landscape (316x222), the $U
          // magnet portrait (307x365) and this one near-square, so matching a
          // width or a height across them gives wildly different visual mass.
          // The magnet occupied 5.2 x 6.18rem (32.2rem^2), and 5.88 x 6.99
          // (41.1rem^2) at the larger breakpoint, which puts the equal-area
          // widths here at 5.61rem and 6.34rem.
          //
          // These are those widths x1.15, by eye and on purpose. Equal area is
          // the right STARTING point across different shapes, not the right
          // answer: this mark is a thin outline where the magnet is a solid
          // silhouette, so the same area reads smaller. Area still scales with
          // the square of the width, so +15% width is ~32% more area — the
          // number to adjust is the multiplier here, not the base widths,
          // which stay as the record of what equal area actually was.
          className="magnet-glow-soft h-auto w-[6.45rem] sm:w-[7.29rem]"
        />
      }
    />
  );
}
