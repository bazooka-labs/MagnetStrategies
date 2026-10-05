// Perps — market capacity binds an immediate open, not a resting limit order.
//
// Reported from production: a $7 limit long offered 0.8x where another front end
// offered 6x on the same market in the same minute. The number was arithmetically
// right and answering the wrong question — ALGO/USD long OI was $1,498.37 against
// a $1,500 cap, so the headroom term solved to $1.63.
//
// PEX settles it: `checkOiAfter` and `checkReservesAfterTrade` are called from
// `quoteV2OpenPosition` and from nowhere else in the SDK. Submitting a limit
// order consults neither, because a limit order opens no position until a keeper
// fills it — and the capacity that matters then is the capacity at that time.

import { describe, expect, it } from "vitest";
import { oiHeadroomUsd, sideOiUsd } from "./perpsReads";
import type { MarketRisk, OpenInterest } from "./perpsReads";

const usd = (n: number) => BigInt(Math.round(n * 1e6));

const oi = (longUsd: number, shortUsd: number) => ({
  long_oi_usd_with_long_collateral: BigInt(0),
  long_oi_usd_with_short_collateral: usd(longUsd),
  short_oi_usd_with_long_collateral: BigInt(0),
  short_oi_usd_with_short_collateral: usd(shortUsd),
} as unknown as OpenInterest);

const risk = (capUsd: number) => ({
  max_open_interest_long: usd(capUsd),
  max_open_interest_short: usd(capUsd),
} as unknown as MarketRisk);

describe("OI headroom — the arithmetic behind the report", () => {
  it("reproduces the reported state", () => {
    // The live numbers at the time of the report.
    const h = oiHeadroomUsd(risk(1500), oi(1498.37, 1197.65), "long");
    expect(Number(h) / 1e6).toBeCloseTo(1.63, 2);
  });

  it("sums BOTH collateral buckets on a side", () => {
    // A side's OI is split across the collateral it was opened with. Reading one
    // bucket would understate usage and overstate headroom — the dangerous
    // direction, since it would offer size the chain then refuses.
    expect(Number(sideOiUsd(oi(1000, 0), "long")) / 1e6).toBe(1000);
    expect(Number(sideOiUsd(oi(0, 700), "short")) / 1e6).toBe(700);
  });

  it("never goes negative when OI is over the cap", () => {
    // A cap can be lowered below live OI. Negative headroom would flow into the
    // bar as a negative ceiling and solve to a nonsense leverage.
    expect(oiHeadroomUsd(risk(1000), oi(1200, 0), "long")).toBe(BigInt(0));
  });

  it("is a per-side question", () => {
    // The reported market was full on the long side and had room on the short.
    // A shared headroom would have blocked both.
    const r = risk(1500);
    const o = oi(1498.37, 1197.65);
    expect(Number(oiHeadroomUsd(r, o, "long")) / 1e6).toBeCloseTo(1.63, 2);
    expect(Number(oiHeadroomUsd(r, o, "short")) / 1e6).toBeCloseTo(302.35, 2);
  });
});
