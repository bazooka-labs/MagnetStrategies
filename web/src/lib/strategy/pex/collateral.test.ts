// Collateral units, pinned against the live positions they were derived from.

import { describe, expect, it } from "vitest";
import {
  collateralUsd, collateralUsdMicro, collateralAmountMicro,
  isUsdDenominated, UnpricedCollateralError,
} from "@/lib/strategy/pex/collateral";
import { PEX_ASSETS } from "@/lib/strategy/pex/config";

/** The ALGO/USD entry price on the live ALGO-collateral position, Price12. */
const ALGO_PRICE12 = BigInt(95_822_000_000);
const m = (n: number) => BigInt(Math.round(n * 1e6));

describe("the real MainNet positions", () => {
  it("values the live ALGO position's collateral in dollars", () => {
    // market 1, side long, collateral asset 0: collateral_amount 210.873916
    // at entry price 0.095822 — read from the box 2026-11-03.
    const usd = collateralUsd(PEX_ASSETS.algo, BigInt(210_873_916), ALGO_PRICE12);
    expect(usd).toBeCloseTo(20.2064, 3);
  });

  it("leaves the live USDC position's collateral alone", () => {
    // collateral_amount 566.816347 IS $566.816347. No price, no rounding.
    expect(collateralUsdMicro(PEX_ASSETS.usdc, BigInt(566_816_347)))
      .toBe(BigInt(566_816_347));
  });

  it("is the ~10.7x error the spec predicted, stated as a ratio", () => {
    // §4c: treating µALGO as µUSD overstates collateral by the ALGO price.
    const amount = BigInt(100_000_000);          // 100 ALGO
    const wrong = Number(amount) / 1e6;          // what the old code called USD
    const right = collateralUsd(PEX_ASSETS.algo, amount, ALGO_PRICE12);
    expect(wrong / right).toBeCloseTo(10.436, 2);
  });
});

describe("USDC is exact, not merely approximate", () => {
  it("needs no price at all", () => {
    expect(collateralUsdMicro(PEX_ASSETS.usdc, m(5))).toBe(m(5));
    expect(collateralAmountMicro(PEX_ASSETS.usdc, m(5))).toBe(m(5));
  });

  it("round-trips every amount without losing a micro-unit", () => {
    // The ALGO path cannot promise this — see below — but USDC must, because
    // it is the path every existing position takes.
    for (const v of [1, 7, 5_000_001, 999_999_999]) {
      const b = BigInt(v);
      expect(collateralAmountMicro(PEX_ASSETS.usdc, collateralUsdMicro(PEX_ASSETS.usdc, b))).toBe(b);
    }
  });

  it("is reported as USD-denominated", () => {
    expect(isUsdDenominated(PEX_ASSETS.usdc)).toBe(true);
    expect(isUsdDenominated(PEX_ASSETS.algo)).toBe(false);
  });
});

describe("ALGO conversion", () => {
  it("converts both directions consistently", () => {
    const algo = BigInt(100_000_000);
    const usd = collateralUsdMicro(PEX_ASSETS.algo, algo, ALGO_PRICE12);
    const back = collateralAmountMicro(PEX_ASSETS.algo, usd, ALGO_PRICE12);
    // Integer division truncates once per direction, so this is within a
    // micro-unit rather than exact. Stated as a bound, not hidden.
    const drift = back > algo ? back - algo : algo - back;
    expect(drift).toBeLessThanOrEqual(BigInt(11));
  });

  it("truncates rather than rounding up, so a derived amount is never short", () => {
    // Matters for MAX: a figure rounded UP would exceed the balance it came
    // from and fail at signing.
    expect(collateralUsdMicro(PEX_ASSETS.algo, BigInt(1), ALGO_PRICE12)).toBe(BigInt(0));
  });

  it("scales linearly", () => {
    const one = collateralUsdMicro(PEX_ASSETS.algo, m(1), ALGO_PRICE12);
    const hundred = collateralUsdMicro(PEX_ASSETS.algo, m(100), ALGO_PRICE12);
    expect(hundred).toBe(one * BigInt(100));
  });
});

describe("an unpriceable collateral throws instead of guessing", () => {
  it("refuses ALGO with no price", () => {
    expect(() => collateralUsd(PEX_ASSETS.algo, m(10))).toThrow(UnpricedCollateralError);
    expect(() => collateralUsd(PEX_ASSETS.algo, m(10), BigInt(0))).toThrow(UnpricedCollateralError);
    expect(() => collateralUsd(PEX_ASSETS.algo, m(10), null)).toThrow(UnpricedCollateralError);
  });

  it("refuses an asset it does not know, even with a price supplied", () => {
    // xALGO is a real PEX asset and still must not be valued at the ALGO
    // price just because one was passed in.
    expect(() => collateralUsd(PEX_ASSETS.xAlgo, m(10), ALGO_PRICE12))
      .toThrow(UnpricedCollateralError);
  });
});
