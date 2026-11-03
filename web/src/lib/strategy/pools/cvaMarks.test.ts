/**
 * Which markets get MARKED, and which get a BOX REFERENCE.
 *
 * These are two different lists and conflating them took every C-Vault deposit
 * and withdrawal down on 2026-11-03.
 *
 * The vault counts marks in `label145`: for each `active_market_N` it reads
 * that market's `gm2:` box and SKIPS the market when `lp_share_amount`
 * (offset 16) is zero. PEX rebalanced to 100% market 1, leaving market 2
 * active with 0 LP, so the contract expected ONE mark while the SDK built two
 * — and the index arithmetic then checked the wrong transaction:
 *
 *     [0] mark(1) [1] mark(2) [2] long [3] short [4] storage [5] deposit
 *     base = GroupIndex - count - 3 = 5 - 1 - 3 = 1
 *     index 1 is mark(2), asserted against market 1  ->  pc 8526
 *
 * The box list must stay wide: `label145` does `box_get; assert` on every
 * active market including the unfunded one, so narrowing both together trades
 * this failure for a missing-box failure.
 */
import { describe, expect, it } from "vitest";
import { markMarketsFor, refs } from "./cvaGroup";
import type { CvaSnapshot } from "./cvaSnapshot";

/** The live shape on 2026-11-03: market 1 funded, market 2 active at 0 LP. */
const snap = (alloc: { market_id: number; lp_share_amount: string }[]) => ({
  state: { activeMarkets: alloc.map((a) => a.market_id) },
  allocations: alloc,
  activeMarketOracles: {},
  oracle: { message: new Uint8Array(), signature: new Uint8Array() },
  registries: {},
} as unknown as CvaSnapshot);

const LIVE = snap([
  { market_id: 1, lp_share_amount: "1785948809" },
  { market_id: 2, lp_share_amount: "0" },
]);

describe("markMarketsFor", () => {
  it("marks only the funded market, matching what label145 counts", () => {
    expect(markMarketsFor(LIVE)).toEqual([1]);
  });

  it("marks every market while all are funded", () => {
    const both = snap([
      { market_id: 1, lp_share_amount: "985920000" },
      { market_id: 2, lp_share_amount: "473950000" },
    ]);
    expect(markMarketsFor(both)).toEqual([1, 2]);
  });
});

describe("the two lists the SDK is given", () => {
  it("narrows the MARK list to funded markets", () => {
    // `activeMarketIds` drives buildV2CvaActiveMarkCalls.
    expect(refs(LIVE).activeMarketIds).toEqual([1]);
  });

  it("keeps the BOX list wide, including the unfunded market", () => {
    // `activeAllocationMarketIds` drives v2CvaActiveAllocationBoxes. label145
    // box_gets market 2's allocation and asserts it exists, funded or not.
    expect(refs(LIVE).activeAllocationMarketIds).toEqual([1, 2]);
  });

  it("does not pass the same list for both — that was the bug", () => {
    const r = refs(LIVE);
    expect(r.activeMarketIds).not.toEqual(r.activeAllocationMarketIds);
  });
});
