/**
 * The SDK's collateral-denominated fields, valued in dollars.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * Review mutated the conversions and found NO test noticed. Replacing every
 * `colUsd` with `toUsd`, reverting `closeColUsd`, multiplying
 * `netCollateralUsd` by ten, and restoring `valueCloseOutputs`' old
 * collateral-first branch (which valued ALGO at $1 a unit) all left the suite
 * green. Six conversions the commit message claimed were fixed had nothing
 * holding them in place.
 *
 * The SDK returns these as `tokenAmountFromUsd(..., collateralPrice)`
 * (v2Quotes.js:1562, 1987), so they are COLLATERAL TOKEN units. For USDC that
 * is within a few basis points of dollars, which is how the conflation
 * survived; against ALGO it is wrong by the ALGO price.
 *
 * These drive a quoter rather than a transaction, so the failure is a wrong
 * number on screen rather than lost funds — but the fee line, the payout and
 * "backing the position" are exactly the figures a trader sizes against.
 */
import { describe, expect, it } from "vitest";
import { valueCloseOutputs } from "@/lib/strategy/pex/quote";
import { PEX_ASSETS } from "@/lib/strategy/pex/config";

/** Live bands, 2026-11-04. */
const ALGO_PRICE12 = BigInt(99_317_500_000);   // ~$0.0993
const USDC_PRICE12 = BigInt(999_799_062_875);

describe("valueCloseOutputs prices by asset, never by role", () => {
  const ctx = {
    collateralAssetId: PEX_ASSETS.algo,
    indexAssetId: PEX_ASSETS.algo,
    indexPrice12: ALGO_PRICE12,
    algoPrice12: ALGO_PRICE12,
  };

  it("values an ALGO payout at the ALGO price, not at a dollar a unit", () => {
    /**
     * THE regression. The old branch matched `collateralAssetId` FIRST and
     * added `amount / 1e6`, short-circuiting the ALGO branch below it, so an
     * ALGO-collateral close reported its payout about ten times too large.
     */
    const out = valueCloseOutputs(
      [{ assetId: PEX_ASSETS.algo, amount: BigInt(2_135_759_196) }], ctx,
    );
    // 2135.759196 ALGO x 0.0993175 = ~$212.12, NOT $2135.76.
    expect(out).not.toBeNull();
    expect(out!).toBeGreaterThan(200);
    expect(out!).toBeLessThan(225);
  });

  it("is not merely scaling everything down", () => {
    // A USDC payout of the same micro amount must still be ~$2135.
    const usdcCtx = { ...ctx, collateralAssetId: PEX_ASSETS.usdc };
    const out = valueCloseOutputs(
      [{ assetId: PEX_ASSETS.usdc, amount: BigInt(2_135_759_196) }], usdcCtx,
    );
    expect(out!).toBeGreaterThan(2000);
  });

  it("values USDC at par even when USDC is the collateral", () => {
    const usdcCtx = { ...ctx, collateralAssetId: PEX_ASSETS.usdc };
    expect(valueCloseOutputs([{ assetId: PEX_ASSETS.usdc, amount: BigInt(5_000_000) }], usdcCtx))
      .toBeCloseTo(5, 6);
  });

  it("sums a mixed payout in dollars", () => {
    // The real shape of a close: some ALGO, some USDC.
    const out = valueCloseOutputs([
      { assetId: PEX_ASSETS.algo, amount: BigInt(100_000_000) },  // 100 ALGO ~ $9.93
      { assetId: PEX_ASSETS.usdc, amount: BigInt(10_000_000) },   // $10
    ], ctx);
    expect(out!).toBeGreaterThan(19.5);
    expect(out!).toBeLessThan(20.5);
  });

  it("withholds rather than guessing when a leg cannot be priced", () => {
    // Same rule the rest of the file follows: a half-priced total is worse
    // than an absent one.
    const out = valueCloseOutputs(
      [{ assetId: 12_345_678, amount: BigInt(1_000_000) }], ctx,
    );
    expect(out).toBeNull();
  });

  it("withholds an ALGO leg when no ALGO price was supplied", () => {
    const noPrice = { ...ctx, collateralAssetId: PEX_ASSETS.usdc, indexAssetId: PEX_ASSETS.usdc };
    const out = valueCloseOutputs(
      [{ assetId: PEX_ASSETS.algo, amount: BigInt(100_000_000) }],
      { ...noPrice, algoPrice12: undefined },
    );
    expect(out).toBeNull();
  });
});
