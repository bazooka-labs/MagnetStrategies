"use client";

// /magnetfi's arrival. The wordmark, because MagnetFi is a Magnet protocol and
// has earned its own mark.
//
// Timing, the blur, the reduced-motion rule and the backdrop-root constraint
// all live in ArrivalSplash — see the note there before moving this.

import Image from "next/image";
import { ArrivalSplash } from "@/components/ArrivalSplash";

export function MagnetFiSplash() {
  return (
    <ArrivalSplash
      subtext="Digital Asset Lending and Borrowing on Algorand"
      mark={
        <Image
          src="/magnetfi-logo.png"
          alt=""
          width={1011}
          height={247}
          priority
          className="w-[17rem] max-w-[72vw] sm:w-[23rem] lg:w-[28rem] h-auto drop-shadow-[0_0_28px_rgba(168,85,247,0.45)]"
        />
      }
    />
  );
}
