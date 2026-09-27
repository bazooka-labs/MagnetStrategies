// Perps — take-profit bounds.
//
// These encode the two defects audit 3 found in `takeProfitBounds`, using the
// real Price12 values measured on MainNet when each was reproduced. They are
// network-free on purpose: the numbers are fixed evidence, not live state.

import { describe, expect, it } from "vitest";
import {
  displayTakeProfitBounds,
  roundPrice12,
  formatPriceUsd,
  takeProfitBounds,
} from "./perpsQuote";
import { usdToPrice12 } from "./perpsOracle";
import { CROSS_MARGIN_BPS, MAX_TAKE_PROFIT_MULTIPLE } from "./perps";
import type { OpenQuote } from "./perpsQuote";

/** Only the four fields `takeProfitBounds` reads. */
const q = (
  side: "long" | "short", entry: bigint, idxMin: bigint, idxMax: bigint,
): OpenQuote => ({
  side, entryPrice12: entry, indexMinPrice12: idxMin, indexMaxPrice12: idxMax,
} as OpenQuote);

// Measured live on ALGO/USD, the case that reproduced the crossing bug: entry
// sits BELOW indexMin because impact was favourable, so "just above entry" —
// the old bound — is inside the band and quotes `crossed: true`.
const ALGO_LONG = q("long", BigInt(115_649_238_181), BigInt(115_861_449_825), BigInt(115_923_550_175));
const ALGO_SHORT = q("short", BigInt(115_227_699_818), BigInt(115_861_449_825), BigInt(115_923_550_175));
const BTC_LONG = q("long", BigInt("84466377840500000"), BigInt("84285854231700000"), BigInt("84297445768300000"));
const BTC_SHORT = q("short", BigInt("84237368370700000"), BigInt("84285854231700000"), BigInt("84297445768300000"));

describe("takeProfitBounds — the crossing guard (H-1)", () => {
  it("excludes the window that quoted crossed:true on MainNet", () => {
    // The old bound. Confirmed live: `quoteV2DecreaseOrder(...).crossed === true`
    // at this exact trigger, on a $463.52 position.
    const oldEdge = ALGO_LONG.entryPrice12 + BigInt(1);
    const b = takeProfitBounds(ALGO_LONG);
    expect(oldEdge).toBeLessThan(b.minPrice12);
    // And the whole gap between entry and the band is excluded, not just its lip.
    expect(ALGO_LONG.indexMaxPrice12).toBeLessThan(b.minPrice12);
  });

  it("puts a long's floor above the index band, plus the margin", () => {
    const b = takeProfitBounds(ALGO_LONG);
    const expected = (ALGO_LONG.indexMaxPrice12 * BigInt(10_000 + CROSS_MARGIN_BPS)) / BigInt(10_000);
    expect(b.minPrice12).toBe(expected);
    expect(b.minPrice12).toBeGreaterThan(ALGO_LONG.indexMaxPrice12);
  });

  it("puts a short's ceiling below the index band, minus the margin", () => {
    const b = takeProfitBounds(ALGO_SHORT);
    const expected = (ALGO_SHORT.indexMinPrice12 * BigInt(10_000 - CROSS_MARGIN_BPS)) / BigInt(10_000);
    expect(b.maxPrice12).toBe(expected);
    expect(b.maxPrice12).toBeLessThan(ALGO_SHORT.indexMinPrice12);
  });

  it("holds at BTC magnitudes, where Price12 exceeds MAX_SAFE_INTEGER", () => {
    expect(Number(BTC_LONG.entryPrice12)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    const bl = takeProfitBounds(BTC_LONG);
    const bs = takeProfitBounds(BTC_SHORT);
    expect(bl.minPrice12).toBeGreaterThan(BTC_LONG.indexMaxPrice12);
    expect(bs.maxPrice12).toBeLessThan(BTC_SHORT.indexMinPrice12);
    // bigint arithmetic throughout — no Number round-trip anywhere in the bound.
    expect(bl.minPrice12 % BigInt(1)).toBe(BigInt(0));
  });

  it("orders the bounds correctly on every market and side", () => {
    for (const quote of [ALGO_LONG, ALGO_SHORT, BTC_LONG, BTC_SHORT]) {
      const b = takeProfitBounds(quote);
      expect(b.minPrice12).toBeLessThan(b.maxPrice12);
      expect(b.minPrice12).toBeGreaterThan(BigInt(0));
    }
  });
});

describe("takeProfitBounds — the typo guard (M-2)", () => {
  it("gives a short a floor, which it did not have", () => {
    const b = takeProfitBounds(ALGO_SHORT);
    // The old floor was 1n — $0.000000000001. On a live $134.86 short the card
    // accepted it and printed "Closes for $134.86 profit before costs".
    expect(b.minPrice12).toBeGreaterThan(BigInt(1));
    // Exclusive: exactly entry/10 is the common typo, so it must be rejected.
    expect(b.minPrice12).toBe(ALGO_SHORT.entryPrice12 / BigInt(MAX_TAKE_PROFIT_MULTIPLE) + BigInt(1));
  });

  it("rejects the one-decimal typo that printed a $121.38 profit", () => {
    // $0.0116 typed for $0.116.
    const typo = ALGO_SHORT.entryPrice12 / BigInt(10);
    const b = takeProfitBounds(ALGO_SHORT);
    expect(typo).toBeLessThan(b.minPrice12);
  });

  it("rejects the BTC typo that printed a $695.02 profit", () => {
    // $8,429 typed for $84,290.
    const typo = BTC_SHORT.entryPrice12 / BigInt(10);
    const b = takeProfitBounds(BTC_SHORT);
    expect(typo).toBeLessThan(b.minPrice12);
  });

  it("rejects a long target at exactly 10x entry, the mirrored typo", () => {
    const b = takeProfitBounds(ALGO_LONG);
    expect(ALGO_LONG.entryPrice12 * BigInt(10)).toBeGreaterThan(b.maxPrice12);
  });

  it("keeps the long ceiling at the stated multiple", () => {
    const b = takeProfitBounds(ALGO_LONG);
    expect(b.maxPrice12).toBe(ALGO_LONG.entryPrice12 * BigInt(MAX_TAKE_PROFIT_MULTIPLE) - BigInt(1));
  });
});


// ── H2 (audit 4): the bound the card PRINTS must be a bound the card ACCEPTS ──
//
// `takeProfitBounds` was correct and its rendering was not: `fmtPrice` rounds to
// whole dollars above $1,000, validation compared against the unrounded value,
// and 5 of 8 measured edges printed a number the card then refused. On a BTC
// long the crossing floor is never an integer, so it was refused essentially
// always — with take-profit mandatory, that is a dead end, not an inconvenience.
//
// This is the round trip the user actually performs, through the real formatter.
describe("displayTakeProfitBounds — printed bounds are typeable", () => {
  const all = [
    ["ALGO long", ALGO_LONG], ["ALGO short", ALGO_SHORT],
    ["BTC long", BTC_LONG], ["BTC short", BTC_SHORT],
  ] as const;

  /** What the user gets if they read the screen and type it back in. */
  const retype = (p12: bigint) => usdToPrice12(formatPriceUsd(Number(p12) / 1e12).replace(/[$,]/g, ""));

  for (const [name, quote] of all) {
    it(`${name}: the printed floor is accepted`, () => {
      const b = displayTakeProfitBounds(quote);
      const typed = retype(b.minPrice12);
      expect(typed).not.toBeNull();
      expect(typed! >= b.minPrice12 && typed! <= b.maxPrice12).toBe(true);
    });

    it(`${name}: the printed ceiling is accepted`, () => {
      const b = displayTakeProfitBounds(quote);
      const typed = retype(b.maxPrice12);
      expect(typed).not.toBeNull();
      expect(typed! >= b.minPrice12 && typed! <= b.maxPrice12).toBe(true);
    });

    it(`${name}: display bounds are no looser than the true bounds`, () => {
      // The card may be stricter than the write path, never the reverse —
      // otherwise it would accept something openPosition then refuses.
      const t = takeProfitBounds(quote);
      const d = displayTakeProfitBounds(quote);
      expect(d.minPrice12).toBeGreaterThanOrEqual(t.minPrice12);
      expect(d.maxPrice12).toBeLessThanOrEqual(t.maxPrice12);
      expect(d.minPrice12).toBeLessThan(d.maxPrice12);
    });
  }

  it("reproduces the exact BTC edge that was refused", () => {
    // Measured live: bound.min 84868144575000000 printed "$84,868", which
    // reparsed to 84868000000000000 — below the bound, so refused.
    const raw = BigInt("84868144575000000");
    expect(usdToPrice12(formatPriceUsd(Number(raw) / 1e12).replace(/[$,]/g, ""))!).toBeLessThan(raw);
    // Rounded outward for display, the same round trip now lands inside.
    const rounded = roundPrice12(raw, "up");
    expect(usdToPrice12(formatPriceUsd(Number(rounded) / 1e12).replace(/[$,]/g, ""))!)
      .toBeGreaterThanOrEqual(rounded);
  });
});
