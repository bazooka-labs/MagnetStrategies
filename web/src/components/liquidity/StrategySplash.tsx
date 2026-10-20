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
      // Says what the page is FOR, not what it contains. "Liquidity pools"
      // would describe today's single tab and be wrong the moment a second
      // strategy lands beside it.
      subtext="Put capital to work across Magnet's strategies"
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
          // Wider than MagnetFi's because the wordmark is a long horizontal
          // lockup rather than a compact logo; matched to the landing page's
          // own scale so the two arrivals read as the same brand at the same
          // size rather than two sizes of it.
          className="w-[16rem] max-w-[76vw] sm:w-[24rem] lg:w-[30rem] h-auto drop-shadow-[0_0_28px_rgba(168,85,247,0.45)]"
        />
      }
    />
  );
}
