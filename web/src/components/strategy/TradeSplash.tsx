"use client";

// /trade's arrival.
//
// ── Why this is typographic and MagnetFi's is a wordmark ───────────────────
// MagnetFi is a Magnet protocol — our contracts, our vaults, our risk — so it
// has earned its own mark. The Trading Terminal is an INTERFACE onto PEX, a
// third-party protocol by Ultrade: we write no exchange contracts, custody no
// funds and hold no protocol role, and the About modal says exactly that.
//
// A "MagnetTrade" wordmark would quietly claim the opposite — that there is a
// Magnet exchange. A logo asserts that louder than any sentence can withdraw it,
// so this uses the parent mark and sets the product name in type: Magnet's
// surface onto someone else's venue, which is what it is. If we ever run our own
// matching engine, it gets a brand then, when the claim is true.

import Image from "next/image";
import { ArrivalSplash } from "@/components/ArrivalSplash";
import { PEX_MARKETS } from "@/lib/perps";

/** Derived, not written out, so it stays true as markets are added. */
const markets = Object.values(PEX_MARKETS).map((m) => m.label.split("/")[0]).join(" and ");

export function TradeSplash() {
  return (
    <ArrivalSplash
      // 2.5s rather than the 2s default: this mark is four things to read -
      // icon, product name, rule, subtitle - where MagnetFi is a single wordmark
      // taken in at a glance. The same duration read as hurried here.
      durationMs={2500}
      subtext={`Go long or short on ${markets} with leverage`}
      mark={
        <div className="flex flex-col items-center gap-4">
          <Image
            src="/magnet-icon.png"
            alt=""
            width={320}
            height={320}
            priority
            className="magnet-glow-soft h-auto w-20 sm:w-24"
          />
          <span className="glow-text font-display text-4xl font-extrabold tracking-tight text-white sm:text-5xl lg:text-6xl">
            Trading Terminal
          </span>
        </div>
      }
    />
  );
}
