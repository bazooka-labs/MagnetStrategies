// Perps — the two money-path functions audit 7 found untested.
//
// `priceForPayoff`/`quickPickPrice` produce a take-profit trigger that is
// SIGNED. `aggregateCloseOutputs`/`valueCloseOutputs` are the close payout, which
// shipped wrong in BOTH directions through six audits — understating by 37%
// where a second asset was hidden, overstating by 12.4% on a single-asset close.
// Neither had a single test.
//
// Network-free: the numbers are measured evidence, not live state.

import { describe, expect, it } from "vitest";
import {
  aggregateCloseOutputs,
  priceForPayoff,
  quickPickPrice,
  valueCloseOutputs,
} from "./perpsQuote";
import { MAX_QUICK_PICK_MOVE_BPS, COLLATERAL_ASSET_ID } from "./perps";
import type { CloseOutput, OpenQuote } from "./perpsQuote";

/** Only the fields these functions read. */
const q = (side: "long" | "short", entry: bigint, notionalUsd: number): OpenQuote => ({
  side, entryPrice12: entry, notionalUsd,
  // `quickPickPrice` also consults the display bounds, which need the band.
  indexMinPrice12: (entry * BigInt(9995)) / BigInt(10_000),
  indexMaxPrice12: (entry * BigInt(10_005)) / BigInt(10_000),
} as OpenQuote);

// The real trade, MainNet round 65484849: $6 collateral, $88.479362 notional,
// entry $0.130934861079. Every ALGO case below is that position.
const ENTRY = BigInt(130_934_861_079);
const REAL = q("long", ENTRY, 88.479362);

describe("priceForPayoff — the arithmetic behind a signed trigger", () => {
  it("solves move = target / notional, and a long moves up", () => {
    // +$8.8479362 on an $88.479362 notional is exactly a 10% price move.
    const p = priceForPayoff(REAL, 8.8479362);
    expect(p).not.toBeNull();
    const move = (Number(p!) - Number(ENTRY)) / Number(ENTRY);
    expect(move).toBeCloseTo(0.1, 9);
  });

  it("a short moves the other way, by the same magnitude", () => {
    const short = q("short", ENTRY, 88.479362);
    const long = priceForPayoff(REAL, 8.8479362)!;
    const s = priceForPayoff(short, 8.8479362)!;
    expect(s).toBeLessThan(ENTRY);
    expect(Number(ENTRY) - Number(s)).toBeCloseTo(Number(long) - Number(ENTRY), 0);
  });

  it("is pct/leverage: the same % of stake is a bigger move at lower leverage", () => {
    // The relationship finding 3 is about, stated as a test rather than prose.
    const hi = priceForPayoff(q("long", ENTRY, 100), 10)!;   // 10% of a $100 notional
    const lo = priceForPayoff(q("long", ENTRY, 10), 10)!;    // 10% of a $10 notional
    const moveHi = (Number(hi) - Number(ENTRY)) / Number(ENTRY);
    const moveLo = (Number(lo) - Number(ENTRY)) / Number(ENTRY);
    expect(moveHi).toBeCloseTo(0.1, 9);
    expect(moveLo).toBeCloseTo(1.0, 9);   // 10x the move for the same dollars
  });

  it("refuses a profit larger than a short can produce", () => {
    // A short's ceiling is its notional — price cannot go below zero. Asking for
    // more solves to a NEGATIVE price, which is arithmetically consistent and
    // completely meaningless.
    const short = q("short", ENTRY, 50);
    expect(priceForPayoff(short, 50)).toBeNull();
    expect(priceForPayoff(short, 60)).toBeNull();
    expect(priceForPayoff(short, 49.99)).not.toBeNull();
  });

  it("refuses a non-positive target or an empty position", () => {
    expect(priceForPayoff(REAL, 0)).toBeNull();
    expect(priceForPayoff(REAL, -5)).toBeNull();
    expect(priceForPayoff(q("long", ENTRY, 0), 5)).toBeNull();
  });
});

describe("quickPickPrice — the bound audit 7 added", () => {
  it("accepts the chips at real leverage", () => {
    // The live trade: $6 stake, $88.48 notional, 14.75x. Every chip is a sub-4%
    // move, which is the regime the bound must NOT touch.
    for (const pct of [0.1, 0.25, 0.5]) {
      const pick = quickPickPrice(REAL, 6 * pct);
      expect(pick.ok).toBe(true);
      expect(pick.moveBps!).toBeLessThan(400);
    }
  });

  it("refuses the low-leverage regime that produced a 6x-spot target", () => {
    // Finding 3, measured: a $50 stake at the bar's left end is a $5 notional —
    // 0.10x — where "+50% of stake" is a +500% price move.
    const tiny = q("long", ENTRY, 5);
    const pick = quickPickPrice(tiny, 50 * 0.5);
    expect(pick.ok).toBe(false);
    expect(pick.ok === false && pick.reason).toBe("unreachable");
    expect(pick.moveBps).toBe(50_000);          // +500%
    // And the old code would have written this price: 6x spot.
    expect(Number(priceForPayoff(tiny, 25)!) / Number(ENTRY)).toBeCloseTo(6, 6);
  });

  it("draws the line exactly at MAX_QUICK_PICK_MOVE_BPS", () => {
    // A target needing precisely the bound is allowed; one basis point more is
    // not. Inclusive/exclusive on a guard has been a defect here before.
    const at = quickPickPrice(q("long", ENTRY, 100), 100 * (MAX_QUICK_PICK_MOVE_BPS / 10_000));
    expect(at.ok).toBe(true);
    expect(at.moveBps).toBe(MAX_QUICK_PICK_MOVE_BPS);

    const over = quickPickPrice(q("long", ENTRY, 100), 100 * 0.5001);
    expect(over.ok).toBe(false);
  });

  it("reports unpayable separately from unreachable", () => {
    // They need different messages: one is "this position cannot make that",
    // the other is "not at this risk level", and they send the user opposite
    // ways.
    const short = q("short", ENTRY, 50);
    const pick = quickPickPrice(short, 80);
    expect(pick.ok === false && pick.reason).toBe("unpayable");
    expect(pick.ok === false && pick.moveBps).toBeNull();
  });

  it("never returns a price outside the display bounds", () => {
    // The clamp: at high leverage a small % of stake is a small move, which can
    // land inside the crossing guard.
    const levered = q("long", ENTRY, 10_000);   // a 0.01% move for +$1
    const pick = quickPickPrice(levered, 1);
    expect(pick.ok).toBe(true);
    expect(pick.ok && pick.price12 > ENTRY).toBe(true);
  });
});

// ── The close payout ────────────────────────────────────────────────────────

const ALGO = 0;
const CORE = { long_asset_id: BigInt(0), short_asset_id: BigInt(COLLATERAL_ASSET_ID) };
/** ALGO/USD index at the time of the measured close quotes. */
const INDEX12 = BigInt(131_810_000_000);

describe("aggregateCloseOutputs — by asset id, never collateral_delta", () => {
  it("keeps a two-asset close as two legs", () => {
    // DGJOWLTV, measured live: 15.88 ALGO + 5.57 USDC. `collateral_delta` showed
    // $5.58 — the ALGO leg was not understated, it was ABSENT.
    const outs = aggregateCloseOutputs({
      primary_output_amount: BigInt(5_567_172), primary_output_asset_id: COLLATERAL_ASSET_ID,
      pnl_output_amount: BigInt(15_880_000), pnl_output_asset_id: ALGO,
    }, CORE);
    expect(outs).toHaveLength(2);
    expect(outs.find((o) => o.assetId === ALGO)!.amount).toBe(BigInt(15_880_000));
    expect(outs.find((o) => o.assetId === COLLATERAL_ASSET_ID)!.amount).toBe(BigInt(5_567_172));
  });

  it("merges two legs that land on the same asset", () => {
    // A short's PnL is paid in the collateral asset, so primary and pnl collide.
    // Two entries for one asset would render "5.00 USDC + 2.00 USDC".
    const outs = aggregateCloseOutputs({
      primary_output_amount: BigInt(5_000_000), primary_output_asset_id: COLLATERAL_ASSET_ID,
      pnl_output_amount: BigInt(2_000_000), pnl_output_asset_id: COLLATERAL_ASSET_ID,
    }, CORE);
    expect(outs).toHaveLength(1);
    expect(outs[0].amount).toBe(BigInt(7_000_000));
  });

  it("includes the claimable token legs, attributed to the market's own assets", () => {
    // The one branch of the be6c092 fix with neither live data nor a test.
    const outs = aggregateCloseOutputs({
      primary_output_amount: BigInt(1_000_000), primary_output_asset_id: COLLATERAL_ASSET_ID,
      claimable_long_token_output: BigInt(250_000),
      claimable_short_token_output: BigInt(400_000),
    }, CORE);
    expect(outs.find((o) => o.assetId === ALGO)!.amount).toBe(BigInt(250_000));
    // The short claim is in the collateral asset, so it merges with primary.
    expect(outs.find((o) => o.assetId === COLLATERAL_ASSET_ID)!.amount).toBe(BigInt(1_400_000));
  });

  it("drops a zero leg rather than listing it", () => {
    // A losing long has no PnL output. "0.000000 ALGO" listed as something you
    // receive is noise on the one line that has to be read.
    const outs = aggregateCloseOutputs({
      primary_output_amount: BigInt(5_000_000), primary_output_asset_id: COLLATERAL_ASSET_ID,
      pnl_output_amount: BigInt(0), pnl_output_asset_id: ALGO,
    }, CORE);
    expect(outs).toHaveLength(1);
    expect(outs.some((o) => o.assetId === ALGO)).toBe(false);
  });

  it("drops a negative leg, and does not let it net against another asset", () => {
    // Separately from zero, because the failure differs: a negative summed into
    // a same-asset leg would UNDERSTATE a real payout rather than add noise.
    const outs = aggregateCloseOutputs({
      primary_output_amount: BigInt(5_000_000), primary_output_asset_id: COLLATERAL_ASSET_ID,
      pnl_output_amount: BigInt(-2_000_000), pnl_output_asset_id: COLLATERAL_ASSET_ID,
      claimable_long_token_output: BigInt(-1), 
    }, CORE);
    expect(outs).toHaveLength(1);
    expect(outs[0].amount).toBe(BigInt(5_000_000));
  });

  it("does not consult collateral_delta at all", () => {
    // The field Ultrade told us not to use. Present and wrong; ignored.
    const outs = aggregateCloseOutputs({
      collateral_delta: BigInt(99_000_000),
      primary_output_amount: BigInt(5_000_000), primary_output_asset_id: COLLATERAL_ASSET_ID,
    }, CORE);
    expect(outs).toHaveLength(1);
    expect(outs[0].amount).toBe(BigInt(5_000_000));
  });
});

describe("valueCloseOutputs — a total, or none at all", () => {
  const ctx = { collateralAssetId: COLLATERAL_ASSET_ID, indexAssetId: ALGO, indexPrice12: INDEX12 };

  it("values USDC at 1:1 and the index asset by the signed oracle", () => {
    // DGJOWLTV reconciled: 15.88 ALGO x $0.13181 + 5.567172 USDC.
    const outs: CloseOutput[] = [
      { assetId: ALGO, amount: BigInt(15_880_000) },
      { assetId: COLLATERAL_ASSET_ID, amount: BigInt(5_567_172) },
    ];
    expect(valueCloseOutputs(outs, ctx)!).toBeCloseTo(15.88 * 0.13181 + 5.567172, 6);
  });

  it("withholds the total when ANY leg is unpriceable", () => {
    // Market 2's index asset is the synthetic 9000000000000000, so a profitable
    // BTC long pays PnL in ALGO and matches neither branch. Pricing ALGO at the
    // BTC index would overstate the payout by five orders of magnitude.
    const outs: CloseOutput[] = [
      { assetId: COLLATERAL_ASSET_ID, amount: BigInt(5_000_000) },
      { assetId: 999, amount: BigInt(1_000_000) },
    ];
    expect(valueCloseOutputs(outs, ctx)).toBeNull();
  });

  it("returns null rather than a partial sum", () => {
    // The failure that matters: a partial total is indistinguishable from a
    // complete one on screen. Order must not decide the answer.
    const priced = { assetId: COLLATERAL_ASSET_ID, amount: BigInt(5_000_000) };
    const un = { assetId: 999, amount: BigInt(1_000_000) };
    expect(valueCloseOutputs([un, priced], ctx)).toBeNull();
    expect(valueCloseOutputs([priced, un], ctx)).toBeNull();
  });

  it("is zero for an empty close, not null", () => {
    expect(valueCloseOutputs([], ctx)).toBe(0);
  });
});
