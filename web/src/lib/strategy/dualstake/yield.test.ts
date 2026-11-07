/**
 * The APR arithmetic, and every guard that refuses to produce one.
 *
 * The figure this module computes is the most consequential number on the
 * card: it is the reason someone deposits. So the tests are weighted towards
 * the cases where it must come back `null` rather than the cases where it
 * comes back right — a wrong APR is worse than no APR, and an APR derived
 * from two usable samples IS a wrong APR.
 *
 * The reference case is MainNet, 2026-11-07:
 *   online stake    1,970,550,180.769 ALGO
 *   payout/block    8.186062 ALGO (median of 14 non-zero in 16)
 *   block time      2.7143 s
 *   -> gross        4.827%     net of 650bps  4.513%
 */

import { describe, expect, it } from "vitest";
import {
  PINNED_FEE_BPS, computeConsensusYield, netAprPct, proposalsPerDay,
  type BlockSample,
} from "./yield";

const ONLINE = BigInt("1970550180769000");      // µALGO, as read
const PAYOUT = 8_186_062;                        // µALGO per block
const ROUND = BigInt(66_735_046);

/**
 * The default fixture spans 15 strides of 7 rounds at 19 seconds a stride.
 *
 * Block timestamps on chain are whole seconds, so a fixture that rounds them
 * does not produce the block time it claims: at stride 5 the measured 2.7143s
 * rounds to 2.725s a round, which moves the APR by 0.4% and made this file's
 * first run look like an arithmetic error in `computeConsensusYield`. It was
 * not — it was the fixture.
 *
 * 19 / 7 = 2.714285714…, which is the real measurement to five places and
 * divides exactly, so every timestamp is a whole number and the derived block
 * time is the one the test asked for.
 */
const STRIDE = 7;
const SECONDS_PER_STRIDE = 19;

/** A sample with a given block time and payout pattern. */
const sample = (
  { n, stride = STRIDE, secondsPerStride = SECONDS_PER_STRIDE, payouts }: {
    n?: number; stride?: number; secondsPerStride?: number; payouts?: number[];
  } = {},
): BlockSample[] => {
  const count = n ?? payouts?.length ?? 16;
  return Array.from({ length: count }, (_, i) => ({
    round: 66_735_000 + i * stride,
    timestamp: Math.round(1_794_075_000 + i * secondsPerStride),
    payoutMicroAlgo: payouts ? payouts[i] ?? 0 : PAYOUT,
  }));
};

describe("the reference figure", () => {
  it("reproduces the APR measured against MainNet", () => {
    const y = computeConsensusYield(sample(), ONLINE, ROUND);
    expect(y).not.toBeNull();
    // 31,536,000 / 2.7143 blocks a year, 8.186062 ALGO each, over 1.9705B.
    expect(y!.grossAprPct).toBeCloseTo(4.827, 2);
    expect(y!.payoutPerBlockMicroAlgo).toBe(BigInt(PAYOUT));
    expect(y!.blockSeconds).toBeCloseTo(2.714286, 5);
    expect(y!.round).toBe(ROUND);
  });

  it("nets Myth's fees off it, from the fees passed in", () => {
    const y = computeConsensusYield(sample(), ONLINE, ROUND)!;
    expect(netAprPct(y.grossAprPct, 250, 400)).toBeCloseTo(4.513, 2);
    // The pinned pair must agree with what the card read live on the day.
    expect(PINNED_FEE_BPS).toBe(650);
  });

  it("nets a RAISED fee correctly, because Myth may raise it", () => {
    // 250bps a week is the cap; one such rise takes 650 -> 900.
    expect(netAprPct(4.827, 250, 650)).toBeCloseTo(4.392, 2);
    // And the function must not treat its own pins as the only possibility.
    expect(netAprPct(4.827, 0, 0)).toBeCloseTo(4.827, 3);
  });

  it("is independent of the staker's size, which is the whole derivation", () => {
    // grossApr = blocksPerYear * payout / onlineStake has no stake term in
    // it. If a future edit introduces one, this is where it shows up.
    const y = computeConsensusYield(sample(), ONLINE, ROUND)!;
    for (const stake of [BigInt(1_000_000), BigInt("49853603266"), ONLINE]) {
      const perDay = proposalsPerDay(stake, ONLINE, y.blockSeconds)!;
      const annual = perDay * 365 * PAYOUT;
      expect((annual * 100) / Number(stake)).toBeCloseTo(y.grossAprPct, 6);
    }
  });
});

describe("the sampling rules", () => {
  it("drops zero payouts rather than averaging them in", () => {
    // `pp` is 0 when the proposer was not incentive eligible. Averaging
    // those in understates the payout by the network's ineligible share,
    // which is not something that happens to OUR staker.
    const withZeros = sample({
      payouts: [PAYOUT, 0, PAYOUT, 0, PAYOUT, PAYOUT, 0, PAYOUT, PAYOUT],
    });
    const y = computeConsensusYield(withZeros, ONLINE, ROUND);
    expect(y).not.toBeNull();
    expect(y!.paidSamples).toBe(6);
    expect(y!.payoutPerBlockMicroAlgo).toBe(BigInt(PAYOUT));
    // The mean-with-zeros answer would have been a third lower.
    expect(y!.grossAprPct).toBeCloseTo(4.827, 2);
  });

  it("refuses a figure when too few blocks carried a payout", () => {
    // Three paid samples is below MIN_PAID_SAMPLES. A median over three
    // blocks is not a payout estimate.
    const thin = sample({ payouts: [PAYOUT, 0, 0, PAYOUT, 0, 0, PAYOUT, 0, 0] });
    expect(computeConsensusYield(thin, ONLINE, ROUND)).toBeNull();
  });

  it("takes the median, so one busy block cannot move it", () => {
    // The payout is a protocol bonus PLUS the block's own fees, so a block
    // stuffed with fees is a real observation and a misleading mean.
    const spiked = sample({
      payouts: [PAYOUT, PAYOUT, PAYOUT, 900_000_000, PAYOUT, PAYOUT, PAYOUT, PAYOUT, PAYOUT],
    });
    const y = computeConsensusYield(spiked, ONLINE, ROUND)!;
    expect(y.payoutPerBlockMicroAlgo).toBe(BigInt(PAYOUT));
    expect(y.grossAprPct).toBeCloseTo(4.827, 2);
  });

  it("sorts by round, so an out-of-order response still times correctly", () => {
    /*
      ── The fixture has to be NON-LINEAR for this test to mean anything ──
      The first version shuffled the default fixture, whose timestamps are a
      straight line — so ANY two of its entries give the same seconds-per-
      round, and the assertion passed with the sort removed. It proved
      nothing. Real round times vary, so these do: a long gap at the front
      and a short one at the back, which read in the wrong order give a
      different block time rather than the same one.
    */
    const gaps = [0, 40, 60, 74, 88, 100, 112, 123, 133];
    const ordered: BlockSample[] = gaps.map((g, i) => ({
      round: 66_735_000 + i * 7,
      timestamp: 1_794_075_000 + g,
      payoutMicroAlgo: PAYOUT,
    }));
    // Mid-sample entries first and last, so an unsorted read spans a
    // narrower slice at a different rate.
    const shuffled = [ordered[3], ordered[8], ordered[0], ordered[5],
      ordered[1], ordered[7], ordered[2], ordered[6], ordered[4]];

    const want = 133 / (8 * 7);              // 2.375 s a round, end to end
    expect(computeConsensusYield(ordered, ONLINE, ROUND)!.blockSeconds)
      .toBeCloseTo(want, 9);
    expect(computeConsensusYield(shuffled, ONLINE, ROUND)!.blockSeconds)
      .toBeCloseTo(want, 9);
    // And the slice an unsorted read would have used is genuinely different,
    // so the assertion above is not satisfiable by accident.
    expect((ordered[8].timestamp - ordered[3].timestamp) / (5 * 7))
      .not.toBeCloseTo(want, 3);
  });
});

describe("what must never produce a number", () => {
  it("returns null, not zero, for an unreadable online stake", () => {
    // A zero denominator would be an infinite APR; a zero APR would be a
    // claim we never measured. Neither may be rendered.
    expect(computeConsensusYield(sample(), BigInt(0), ROUND)).toBeNull();
    expect(computeConsensusYield(sample(), BigInt(-1), ROUND)).toBeNull();
  });

  it("refuses an implausible block time in either direction", () => {
    // blocksPerYear is inversely proportional to block time, so a 10x
    // misread is a 10x APR error — in the flattering direction when the
    // time comes back too small.
    expect(computeConsensusYield(
      sample({ secondsPerStride: 1 }), ONLINE, ROUND)).toBeNull();     // 0.14 s/round
    expect(computeConsensusYield(
      sample({ secondsPerStride: 700 }), ONLINE, ROUND)).toBeNull();   // 100 s/round
    // And accepts the real one, so the bound is not simply refusing all.
    expect(computeConsensusYield(
      sample(), ONLINE, ROUND)).not.toBeNull();
  });

  it("refuses a sample that cannot give a block time at all", () => {
    expect(computeConsensusYield([], ONLINE, ROUND)).toBeNull();
    expect(computeConsensusYield(sample({ n: 1 }), ONLINE, ROUND)).toBeNull();
    // Every block the same round: zero elapsed rounds, no division possible.
    const flat = sample().map((s) => ({ ...s, round: 66_735_000 }));
    expect(computeConsensusYield(flat, ONLINE, ROUND)).toBeNull();
  });

  it("refuses a NaN timestamp instead of propagating it to the card", () => {
    const bad = sample();
    bad[bad.length - 1] = { ...bad[bad.length - 1], timestamp: NaN };
    expect(computeConsensusYield(bad, ONLINE, ROUND)).toBeNull();
  });

  it("refuses when every payout is zero", () => {
    const none = sample({ payouts: new Array(9).fill(0) });
    expect(computeConsensusYield(none, ONLINE, ROUND)).toBeNull();
  });
});

describe("proposalsPerDay — the modal's explanation of why history is thin", () => {
  it("matches the rate the contract actually proposes at", () => {
    // ~49.85K ALGO against 1.97B online: 0.8 proposals a day, which is why
    // three harvests in three days is not a series.
    const perDay = proposalsPerDay(BigInt("49853603266"), ONLINE, 19 / 7);
    expect(perDay).toBeCloseTo(0.8, 1);
  });

  it("returns null rather than dividing by a zero network", () => {
    expect(proposalsPerDay(BigInt(1), BigInt(0), 2.7)).toBeNull();
    expect(proposalsPerDay(BigInt(1), ONLINE, 0)).toBeNull();
  });
});
