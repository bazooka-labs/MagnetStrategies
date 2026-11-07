/**
 * The decimals trap, pinned against a real redemption.
 *
 * magnetALGO carries 6 decimals and $U carries 5, and the contract's `rate` is
 * defined base-unit to base-unit. Any conversion that assumes matching
 * decimals is out by exactly 10x — on the one figure a depositor is here for.
 *
 * This codebase has shipped that class of bug before: a collateral figure read
 * $210.87 against a real $20.21, and an ALGO fee rendered as "$2.07" against a
 * true $0.19. So the arithmetic is checked against chain, not reasoned about.
 */

import { describe, expect, it } from "vitest";
import { accruedReward, toMagnetAlgo, toReward } from "./reads";
import { MAGNET_ALGO_DECIMALS, RATE_PRECISION, REWARD_DECIMALS } from "./config";

/**
 * Ground truth, decoded from mainnet round 66705349.
 * 353,286,105 base magnetALGO redeemed and paid 11,020 base $U.
 */
const REDEEMED_LST = BigInt(353_286_105);
const PAID_REWARD = BigInt(11_020);
/** The contract's `rate` read at round 66711752, shortly after. */
const RATE = BigInt(311_947);

describe("accrued reward against a real redemption", () => {
  it("predicts the $U the chain actually paid", () => {
    const predicted = accruedReward(REDEEMED_LST, RATE);
    // Within 0.1%: the rate moved slightly between the redemption and the read.
    const drift = Number(predicted - PAID_REWARD) / Number(PAID_REWARD);
    expect(Math.abs(drift)).toBeLessThan(0.001);
  });

  it("is NOT what a same-decimals assumption would give", () => {
    // The bug this file exists to prevent. Scaling $U as if it had magnetALGO's
    // 6 decimals understates it 10x — and the mirrored mistake overstates it.
    const correct = toReward(accruedReward(REDEEMED_LST, RATE));
    const naive = Number(accruedReward(REDEEMED_LST, RATE)) / 10 ** MAGNET_ALGO_DECIMALS;
    expect(correct / naive).toBeCloseTo(10, 6);
    expect(REWARD_DECIMALS).toBe(5);
    expect(MAGNET_ALGO_DECIMALS).toBe(6);
  });

  it("stays exact in bigint rather than drifting through float", () => {
    // A whole-ALGO-scale position: float arithmetic on these magnitudes is
    // where rounding silently appears.
    const big = BigInt(49_319_479_854);
    expect(accruedReward(big, RATE)).toBe((big * RATE) / BigInt(RATE_PRECISION));
  });

  it("returns zero for an empty holding rather than throwing", () => {
    expect(accruedReward(BigInt(0), RATE)).toBe(BigInt(0));
  });
});

describe("display conversions", () => {
  it("renders the redemption in the units a holder recognises", () => {
    expect(toMagnetAlgo(REDEEMED_LST)).toBeCloseTo(353.286105, 6);
    expect(toReward(PAID_REWARD)).toBeCloseTo(0.1102, 5);
  });
});
