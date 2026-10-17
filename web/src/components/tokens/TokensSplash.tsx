"use client";

// /tokens' arrival: the Magnet mark and the promise, nothing else.
//
// ── Why the $U mark ────────────────────────────────────────────────────────
// This previously used the Magnet Strategies "m", on the reasoning that the
// page holds two assets — $U and mUSD — so leading with either one's icon
// would announce the wrong half.
//
// Overruled deliberately: $U is the page's default tab and the asset the
// subtext is about, and the parent mark had the opposite problem — it said
// "Magnet Strategies" on a page about tokens, which is the one thing a visitor
// arriving from the landing page has just been shown. The subtext still carries
// the promise; the mark now names what the page is for.
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
          // The $U ASA mark, not the Magnet Strategies "m".
          //
          // This page is about the token, so it leads with the token's own
          // artwork. The "m" is the organisation's mark and still opens
          // /magnetfi and the navbar.
          //
          // Cropped to its opaque pixels (307x365 out of a 521x479 canvas with
          // asymmetric padding) for the same reason the "m" was: scaling a
          // padded canvas scales the padding, and the gap to the rule below
          // would come from the asset rather than the layout.
          src="/tokens/u-mark.png"
          alt=""
          width={307}
          height={365}
          priority
          // Sized by AREA, not by width or height.
          //
          // The "m" is landscape (316x222) and the magnet is portrait
          // (307x365), so the two rules disagree badly: matching height makes
          // the magnet read as a minor element, matching width makes it clearly
          // larger than the mark it replaces. Equal area at 5.23rem puts its
          // visual mass where the "m" was, which is what "about the same size"
          // means for shapes this different. Compared side by side before
          // choosing.
          className="magnet-glow-soft h-auto w-[5.2rem] sm:w-[5.88rem]"
        />
      }
    />
  );
}
