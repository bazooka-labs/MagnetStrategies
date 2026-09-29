// Perps — what `quoteClose` ASSEMBLES from the SDK's raw result.
//
// The aggregation and the USD valuation have their own tests (perpsPayout).
// This covers the layer above them: which raw fields quoteClose reads, and —
// the rule that cost real money to learn — which ones it must NOT apply twice.
//
// Mocked rather than networked, because the point is the mapping, not the
// exchange. A fixture would pin one shape of PEX's output; a mock lets each
// case state exactly the raw field it is about.

import { describe, expect, it, vi } from "vitest";

const raw = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock("@pdex/sdk", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  quoteV2DecreasePosition: () => raw.value,
  quoteV2DecreaseOrder: () => ({ ok: true, failure_reasons: [] }),
}));

const { quoteClose } = await import("./perpsQuote");
const { COLLATERAL_ASSET_ID } = await import("./perps");

const ALGO = 0;
/** Only the fields quoteClose reaches for. */
const INPUT = {
  state: {
    marketId: 1,
    core: { index_asset_id: BigInt(ALGO), long_asset_id: BigInt(ALGO), short_asset_id: BigInt(COLLATERAL_ASSET_ID) },
    pool: {}, risk: {}, oi: {},
  },
  funding: {},
  position: { size_usd: BigInt(88_479_362), collateral_amount: BigInt(5_858_426) },
  // Every field `priceInput` reads. ALGO at ~$0.13181, USDC at ~$1.
  oracle: {
    indexPrice12: BigInt(131_810_000_000),
    decoded: {
      indexMinPrice: BigInt(131_800_000_000), indexMaxPrice: BigInt(131_820_000_000),
      longMinPrice: BigInt(131_800_000_000), longMaxPrice: BigInt(131_820_000_000),
      shortMinPrice: BigInt(999_940_000_000), shortMaxPrice: BigInt(999_980_000_000),
    },
  },
  side: "long" as const,
  owner: "KNML6OW2XVXYSSGQX7EBLBMSLAPY6QFNBZUJMNEFIEXIIVJLMW4VINYU6A",
  sizeUsdMicro: BigInt(88_479_362),
  collateralAssetId: COLLATERAL_ASSET_ID,
  builderAddress: "KNML6OW2XVXYSSGQX7EBLBMSLAPY6QFNBZUJMNEFIEXIIVJLMW4VINYU6A",
};
const close = (r: Record<string, unknown>) => {
  raw.value = { ok: true, failure_reasons: [], execution_price: BigInt(131_810_000_000), ...r };
  return quoteClose(INPUT as never);
};

describe("quoteClose — funding is never applied twice", () => {
  it("does not subtract funding or borrowing from the payout", () => {
    // **The rule, from Ultrade 2026-09-28.** Those costs are already settled
    // into collateral BEFORE the proportional withdrawal is computed, which is
    // also why they do not scale with the close fraction. Subtracting them from
    // the outputs would charge them a second time.
    const q = close({
      primary_output_amount: BigInt(5_000_000), primary_output_asset_id: COLLATERAL_ASSET_ID,
      funding_fee_collateral_amount: BigInt(900_000),
      borrowing_fee_collateral_amount: BigInt(400_000),
      collateral_funding_net_amount: BigInt(-1_300_000),
    });
    // Exactly the output leg. Not 5.0 - 0.9 - 0.4 = 3.7.
    expect(q.payoutUsd).toBeCloseTo(5, 9);
    expect(q.outputs).toHaveLength(1);
    expect(q.outputs[0].amount).toBe(BigInt(5_000_000));
  });

  it("reports funding SIGNED, from the net field and not the gross one", () => {
    // `funding_fee_collateral_amount` is forced non-negative in the SDK's
    // `settledPosition`, so it reports a cost even where the chain credited the
    // trader. Rendering it as the cost was wrong on 5 of 8 live positions.
    const credited = close({
      primary_output_amount: BigInt(5_000_000), primary_output_asset_id: COLLATERAL_ASSET_ID,
      funding_fee_collateral_amount: BigInt(97_121),
      collateral_funding_net_amount: BigInt(78_687),
    });
    expect(credited.fundingFeeUsd).toBeCloseTo(0.097121, 9);   // gross, unsigned
    expect(credited.fundingNetUsd).toBeCloseTo(0.078687, 9);   // signed, POSITIVE = paid to you

    const charged = close({
      primary_output_amount: BigInt(5_000_000), primary_output_asset_id: COLLATERAL_ASSET_ID,
      funding_fee_collateral_amount: BigInt(8_673_814),
      collateral_funding_net_amount: BigInt(-9_326_609),
    });
    expect(charged.fundingNetUsd).toBeCloseTo(-9.326609, 6);
  });
});

describe("quoteClose — which raw fields it reads", () => {
  it("ignores collateral_delta entirely", () => {
    // The field Ultrade told us not to use. Present and wrong; must not appear
    // in the payout at all.
    const q = close({
      collateral_delta: BigInt(51_820_000),
      primary_output_amount: BigInt(5_567_172), primary_output_asset_id: COLLATERAL_ASSET_ID,
      pnl_output_amount: BigInt(15_880_000), pnl_output_asset_id: ALGO,
    });
    expect(q.payoutUsd).toBeCloseTo(15.88 * 0.13181 + 5.567172, 6);
    expect(q.outputs).toHaveLength(2);
  });

  it("pnlUsd is price movement alone, gross of every fee", () => {
    const q = close({
      primary_output_amount: BigInt(5_000_000), primary_output_asset_id: COLLATERAL_ASSET_ID,
      effective_profit_usd: BigInt(2_354_466), loss_usd: BigInt(0),
      close_fee_usd: BigInt(310_000), builder_fee_paid: BigInt(517_000),
    });
    // Not netted against the fees beside it — those are separate fields, and
    // the panel shows the difference rather than folding it in silently.
    expect(q.pnlUsd).toBeCloseTo(2.354466, 9);
    expect(q.closeFeeUsd).toBeCloseTo(0.31, 9);
    expect(q.builderFeeUsd).toBeCloseTo(0.517, 9);
  });

  it("falls back to platform_fee_amount when close_fee_usd is absent", () => {
    const q = close({
      primary_output_amount: BigInt(5_000_000), primary_output_asset_id: COLLATERAL_ASSET_ID,
      platform_fee_amount: BigInt(123_456),
    });
    expect(q.closeFeeUsd).toBeCloseTo(0.123456, 9);
  });

  it("impactUsd is signed, positive meaning it worked in your favour", () => {
    const good = close({
      primary_output_amount: BigInt(5_000_000), primary_output_asset_id: COLLATERAL_ASSET_ID,
      impact_positive_usd: BigInt(44_000), impact_negative_usd: BigInt(0),
    });
    expect(good.impactUsd).toBeCloseTo(0.044, 9);
    const bad = close({
      primary_output_amount: BigInt(5_000_000), primary_output_asset_id: COLLATERAL_ASSET_ID,
      impact_positive_usd: BigInt(0), impact_negative_usd: BigInt(2_845_000),
    });
    expect(bad.impactUsd).toBeCloseTo(-2.845, 9);
  });

  it("withholds payoutUsd when a leg cannot be priced, and still lists the legs", () => {
    // A profitable BTC long pays PnL in ALGO, which is neither the collateral
    // asset nor market 2's synthetic index asset.
    const q = close({
      primary_output_amount: BigInt(5_000_000), primary_output_asset_id: COLLATERAL_ASSET_ID,
      pnl_output_amount: BigInt(1_000_000), pnl_output_asset_id: 999,
    });
    expect(q.payoutUsd).toBeNull();
    expect(q.outputs).toHaveLength(2);
  });
});
