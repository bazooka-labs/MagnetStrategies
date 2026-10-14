/**
 * The posted-price cross-check.
 *
 * Only the pure classification is tested here — the reads themselves hit chain
 * and a third-party API, and a test that fetched would be testing Tinyman's
 * uptime. The live path was verified against mainnet on 2026-10-14: all four
 * registered pools returned an independent price, diverging by 0.26%-4.20% from
 * a posted price frozen for 23-109 hours. Those are upper bounds from a dead
 * feed, not a calibration sample — see magnetfiPriceCheck.ts.
 */
import { describe, expect, it } from "vitest";
import {
  DIVERGE_CRITICAL_PCT,
  DIVERGE_WARN_PCT,
  classifyDivergence,
  divergencePct,
} from "./magnetfiPriceCheck";

const FRESH = 60;
const STALE = 1_800;

describe("divergence arithmetic", () => {
  it("measures against the independent price, not the posted one", () => {
    // The independent read is the reference; dividing by the posted price would
    // make the number depend on the thing being judged.
    expect(divergencePct(0.55, 1.0)).toBeCloseTo(45, 6);
    expect(divergencePct(1.0, 1.0)).toBeCloseTo(0, 6);
  });

  it("is direction-agnostic", () => {
    expect(divergencePct(1.1, 1.0)).toBeCloseTo(10, 6);
    expect(divergencePct(0.9, 1.0)).toBeCloseTo(10, 6);
  });

  it("has no opinion when either side is missing or nonsensical", () => {
    expect(divergencePct(null, 1.0)).toBeNull();
    expect(divergencePct(1.0, null)).toBeNull();
    expect(divergencePct(1.0, 0)).toBeNull();
    expect(divergencePct(1.0, -1)).toBeNull();
  });
});

describe("classifying a divergence", () => {
  it("flags the decimals-slip signature as critical", () => {
    // $U has 5 decimals; a one-sided slip lands the LP price near 0.55x truth
    // with every asset-price bound satisfied. This is the case the check exists
    // for, and it must not read as a market move.
    const d = divergencePct(0.55, 1.0);
    const { level, note } = classifyDivergence(d, FRESH, true);
    expect(level).toBe("critical");
    expect(note).toMatch(/decimals or route/);
  });

  it("accepts TWAP lag quietly", () => {
    // The posted price is smoothed, so it trails spot. A couple of percent is
    // normal and must not cry wolf — measured 0.86%-2.91% live.
    expect(classifyDivergence(2.91, FRESH, true).level).toBe("ok");
    expect(classifyDivergence(2.91, FRESH, true).note).toBeNull();
  });

  it("says nothing new when the feed is stale", () => {
    // Staleness already has its own alarm. Reporting the resulting divergence
    // as "wrong" would be two alarms for one fault — and an old price diverging
    // is expected, not evidence of anything.
    const { level, note } = classifyDivergence(40, STALE, true);
    expect(level).toBe("unknown");
    expect(note).toMatch(/stale/);
  });

  it("does not judge a pool that has never posted", () => {
    // add_pool seeds a price without the bot ever running; that is not a fault.
    expect(classifyDivergence(99, FRESH, false).level).toBe("unknown");
    expect(classifyDivergence(99, FRESH, false).note).toBe("never posted");
  });

  it("degrades to unknown when the independent read is unavailable", () => {
    // A third party being down must never present as a bad price.
    const { level, note } = classifyDivergence(null, FRESH, true);
    expect(level).toBe("unknown");
    expect(note).toMatch(/no independent price/);
  });

  it("puts the boundaries where the constants say", () => {
    expect(classifyDivergence(DIVERGE_WARN_PCT - 0.01, FRESH, true).level).toBe("ok");
    expect(classifyDivergence(DIVERGE_WARN_PCT, FRESH, true).level).toBe("warn");
    expect(classifyDivergence(DIVERGE_CRITICAL_PCT - 0.01, FRESH, true).level).toBe("warn");
    expect(classifyDivergence(DIVERGE_CRITICAL_PCT, FRESH, true).level).toBe("critical");
  });

  it("keeps the critical threshold clear of the bug it must catch", () => {
    // Guards the one property that is actually established: the decimals-slip
    // signature (~45%) must sit well above the critical line, or the band is
    // decoration.
    //
    // Deliberately NOT asserted: that ordinary lag stays below the warn line.
    // That premise is unvalidated — the only live readings available came from a
    // feed frozen for 23-109 hours and reached 4.20%, within 0.8pp of WARN.
    // Pinning it here would promote a guess to a requirement.
    expect(DIVERGE_CRITICAL_PCT).toBeLessThan(45);
    expect(DIVERGE_WARN_PCT).toBeLessThan(DIVERGE_CRITICAL_PCT);
    expect(DIVERGE_WARN_PCT).toBeGreaterThan(0);
  });
});
