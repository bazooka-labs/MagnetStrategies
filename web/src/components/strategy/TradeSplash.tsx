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
// so the product name is set in type. If we ever run our own matching engine,
// it gets a brand then, when the claim is true.
//
// ── Why the parent mark left ───────────────────────────────────────────────
// It carried the Magnet icon until /tokens took that mark for its own arrival,
// where it stands for the organisation behind two assets rather than for one
// product. Type alone here, so the two arrivals are not the same image with
// different captions. The no-wordmark rule above is unchanged: what moved is a
// mark, not the policy.

import { ArrivalSplash } from "@/components/ArrivalSplash";
import { PEX_MARKETS } from "@/lib/perps";

/** Derived, not written out, so it stays true as markets are added. */
const markets = Object.values(PEX_MARKETS).map((m) => m.label.split("/")[0]).join(" and ");

export function TradeSplash() {
  return (
    <ArrivalSplash
      // 2.5s rather than the 2s default. It was set when this splash carried an
      // icon too, and it stays: the product name is the longest line of type in
      // any of the three arrivals, and 2s read as hurried against it.
      durationMs={2500}
      subtext={`Go long or short on ${markets} with leverage`}
      mark={
        <span className="glow-text font-display text-4xl font-extrabold tracking-tight text-white sm:text-5xl lg:text-6xl">
          Trading Terminal
        </span>
      }
    />
  );
}
