/**
 * The harvest log's arithmetic.
 *
 * Small surface, one trap: $U carries 5 decimals and ALGO 6, so the realised
 * conversion rate is the one figure in this module that can silently be 10x
 * wrong — the same trap `accruedReward` carries, in a different place. The
 * fixture below is the first three real harvests, so the expected rate is a
 * measured number rather than one derived from the code under test.
 */

import { describe, expect, it } from "vitest";
import {
  assertHarvestsFromPinnedApp, harvestTotals, realisedRewardPerAlgo,
} from "./events";
import { DUALSTAKE_APP_ID } from "./config";
import type { Harvest } from "./yield";

/** Measured 2026-11-05 to 2026-11-06, rounds 66654225 / 66666169 / 66694896. */
const REAL: Harvest[] = [
  { round: 66_694_896, timestamp: 1_793_965_320, algoMicro: BigInt(7_659_112), rewardBase: BigInt(517_363) },
  { round: 66_666_169, timestamp: 1_793_886_180, algoMicro: BigInt(7_650_229), rewardBase: BigInt(516_308) },
  { round: 66_654_225, timestamp: 1_793_853_240, algoMicro: BigInt(7_555_326), rewardBase: BigInt(512_043) },
];

describe("harvestTotals", () => {
  it("sums the real log", () => {
    const t = harvestTotals(REAL)!;
    expect(t.count).toBe(3);
    expect(t.algoMicro).toBe(BigInt(22_864_667));   // 22.864667 ALGO
    expect(t.rewardBase).toBe(BigInt(1_545_714));   // 15.45714 $U
  });

  it("returns null for an empty log rather than a row of zeroes", () => {
    // "No harvests yet" and "0 ALGO harvested" read the same and are not.
    expect(harvestTotals([])).toBeNull();
  });

  it("gives no span for a single harvest", () => {
    // One point is not a window, and a zero-day window would divide by zero
    // in anything that tried to rate it.
    expect(harvestTotals([REAL[0]])!.days).toBeNull();
  });

  it("spans first to last regardless of the order it is given", () => {
    const forward = harvestTotals([...REAL].reverse())!;
    const backward = harvestTotals(REAL)!;
    expect(forward.days).toBeCloseTo(backward.days!, 9);
    expect(forward.days!).toBeGreaterThan(0);
  });

  it("ignores missing timestamps when computing the span", () => {
    const partial: Harvest[] = [
      { ...REAL[0], timestamp: 0 }, REAL[1], REAL[2],
    ];
    const t = harvestTotals(partial)!;
    // Still a real span from the two it could read, not a 1970 epoch span.
    expect(t.days).toBeCloseTo((1_793_886_180 - 1_793_853_240) / 86_400, 6);
  });
});

describe("realisedRewardPerAlgo — the 6dp/5dp trap", () => {
  it("matches the rate the contract actually achieved", () => {
    // 15.45714 $U for 22.864667 ALGO. Both scales applied, in the right
    // direction: a version that assumed matching decimals returns 0.0676.
    expect(realisedRewardPerAlgo(REAL)).toBeCloseTo(0.67603, 5);
  });

  it("is not out by a factor of ten", () => {
    // The specific failure this guards. 10x and 0.1x are both excluded, so
    // the assertion cannot be satisfied by the wrong scaling in either
    // direction.
    const r = realisedRewardPerAlgo(REAL)!;
    expect(r).toBeGreaterThan(0.1);
    expect(r).toBeLessThan(1);
  });

  it("agrees with each individual harvest, so the total is not hiding a drift", () => {
    for (const h of REAL) {
      expect(realisedRewardPerAlgo([h])!).toBeCloseTo(0.676, 2);
    }
  });

  it("returns null rather than dividing by zero ALGO", () => {
    expect(realisedRewardPerAlgo([])).toBeNull();
    expect(realisedRewardPerAlgo([{ ...REAL[0], algoMicro: BigInt(0) }])).toBeNull();
  });
});

describe("assertHarvestsFromPinnedApp", () => {
  it("accepts transactions against the app we pinned", () => {
    expect(assertHarvestsFromPinnedApp([
      { applicationTransaction: { applicationId: BigInt(DUALSTAKE_APP_ID) } },
      { applicationTransaction: { applicationId: DUALSTAKE_APP_ID } },
    ])).toBe(true);
  });

  it("rejects a log borrowed from a DIFFERENT dualSTAKE contract", () => {
    // Myth run several. Another one's harvests are a plausible-looking set of
    // numbers describing someone else's product, which is worse than none.
    expect(assertHarvestsFromPinnedApp([
      { applicationTransaction: { applicationId: BigInt(DUALSTAKE_APP_ID) } },
      { applicationTransaction: { applicationId: BigInt(2_933_534_328) } },
    ])).toBe(false);
  });

  it("tolerates a non-app transaction, which carries no app id to check", () => {
    expect(assertHarvestsFromPinnedApp([{}])).toBe(true);
  });
});
