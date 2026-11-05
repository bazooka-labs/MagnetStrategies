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
// ── Why it is rounded, unlike the marks it replaces ───────────────────────
// The "m" and the $U magnet are transparent artwork that composites onto the
// scrim. This file is a full-bleed opaque purple square — the app-icon crop,
// the same asset the mUSD hero tiles at 56px — so square and unrounded it
// reads as a block of colour rather than a mark. The radius is what makes it
// read as the icon it is, and it is on the image itself; the note on the
// className says why there is no wrapper.
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
          src="/musd-icon.png"
          alt=""
          width={1024}
          height={1024}
          priority
          // ── Sized by AREA, the rule the two previous marks were sized by ──
          // The "m" is landscape (316x222), the $U magnet portrait (307x365)
          // and this one square, so matching a width or a height across the
          // three gives wildly different visual mass. The magnet occupied
          // 5.2 x 6.18rem (32.2rem^2), and 5.88 x 6.99 (41.1rem^2) at the
          // larger breakpoint; the equal-area square sides are 5.67rem and
          // 6.41rem, which is what these are.
          //
          // ── Rounded, unlike the marks it replaces ──
          // Those are transparent artwork that composites onto the scrim. This
          // is the app-icon crop: a full-bleed opaque purple square, the same
          // asset the mUSD hero tiles at 56px. Square and unrounded it reads as
          // a block of colour rather than a mark.
          //
          // The radius is on the IMAGE and there is no wrapper, deliberately.
          // ArrivalSplash promotes the mark with `[&_img]:transform-gpu`
          // because the filter that forces a compositing layer lives on the
          // <img> — see the long note there about the cold-load rectangle. A
          // wrapper carrying `magnet-glow-soft` would move the filter off the
          // element that selector reaches, and `overflow-hidden` on it would
          // clip the glow anyway.
          className="magnet-glow-soft h-[5.67rem] w-[5.67rem] rounded-[1.25rem] object-cover sm:h-[6.41rem] sm:w-[6.41rem]"
        />
      }
    />
  );
}
