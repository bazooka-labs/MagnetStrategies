// The OPEN write path against ALGO collateral.
//
// Two separate things are pinned here, and they fail in different directions:
//
//   1. What is REFUSED. Protection on an ALGO position and ALGO limit orders
//      both depend on a keeper acting on an ALGO-denominated fee, which has
//      never been observed. These must throw rather than build something that
//      asserts clean and is never executed — SPEC.md:248's failure mode.
//   2. What is CARRIED. The collateral amount reaching the quote must be the
//      asset's own micro-units. Passing µALGO as though it were µUSD is the
//      ~10.7x error, and it would produce a plausible-looking leverage.

import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";

const quoteOpen = vi.fn();
const readPosition = vi.fn();

vi.mock("@/lib/strategy/pex/quote", async (orig) => ({
  ...(await orig() as object),
  quoteOpen: (...a: unknown[]) => quoteOpen(...a),
}));
vi.mock("@/lib/strategy/pex/reads", async (orig) => ({
  ...(await orig() as object),
  readPosition: (...a: unknown[]) => readPosition(...a),
  readTraderState: vi.fn(async () => null),
  readMarketState: vi.fn(async () => ({
    core: { index_asset_id: BigInt(0), long_asset_id: BigInt(0), short_asset_id: BigInt(31566704) },
  })),
  allocateBaseOrderId: vi.fn(async () => ({ baseOrderId: BigInt(1) })),
  assertBaseOrderIdFree: vi.fn(async () => true),
  storagePaymentNeeded: vi.fn(() => BigInt(0)),
}));
vi.mock("@/lib/strategy/pex/manifest", () => ({ installProtocolManifest: vi.fn() }));
vi.mock("@/lib/strategy/perps/preflight", () => ({
  preflight: vi.fn(async () => ({ canOpen: true, kind: "ok" })),
  exitBlocked: () => false,
}));

import { openPosition, openLimitOrder } from "@/lib/strategy/perps/client";
import { PEX_ASSETS } from "@/lib/strategy/pex/config";

const SENDER = "MAGNETTESTADDRESSMAGNETTESTADDRESSMAGNETTESTADDRESSMAG";
/** ALGO/USD at the price the live position was opened at. */
const ALGO_PRICE12 = BigInt(95_822_000_000);
/** 100 ALGO. As µUSD this would read as $100; it is about $9.58. */
const HUNDRED_ALGO = BigInt(100_000_000);

const balance = { amount: BigInt(500_000_000), minBalance: BigInt(100_000) };
const algod = {
  accountInformation: () => ({ do: async () => ({ ...balance, assets: [] }) }),
  getTransactionParams: () => ({ do: async () => ({ fee: BigInt(1000), minFee: BigInt(1000) }) }),
} as never;

const open = (over: Record<string, unknown> = {}) => openPosition({
  algod,
  signTransactions: async () => [],
  sender: SENDER,
  marketId: 1,
  side: "long",
  collateralAssetId: PEX_ASSETS.algo,
  collateralAmountMicro: HUNDRED_ALGO,
  algoPrice12: ALGO_PRICE12,
  notionalUsd: 25,
  takeProfitPrice12: BigInt(0),
  displayed: {
    asRenderedIndexPrice12: ALGO_PRICE12,
    asRenderedEntryPrice12: ALGO_PRICE12,
    asRenderedLiquidationPrice12: BigInt(1),
    asRenderedNetCollateralMicro: BigInt(0),
    // $25 notional against ~$9.58 of ALGO.
    asRenderedLeverage: 2.6,
  },
  ...over,
} as never);

beforeEach(() => {
  quoteOpen.mockReset();
  readPosition.mockReset();
  readPosition.mockResolvedValue(null);
  quoteOpen.mockReturnValue({ ok: false, reasons: ["stop here"] });
});

describe("protection on ALGO collateral is refused, not silently built", () => {
  it("refuses a take-profit and says why", async () => {
    await expect(open({ takeProfitPrice12: BigInt(120_000_000_000) }))
      .rejects.toThrow(/keeper fee would have to be paid in ALGO/);
  });

  it("refuses a stop-loss for the same reason", async () => {
    await expect(open({ stopLossPrice12: BigInt(80_000_000_000) }))
      .rejects.toThrow(/keeper fee would have to be paid in ALGO/);
  });

  it("refuses a LIMIT order outright, since it always escrows a keeper fee", async () => {
    await expect(openLimitOrder({
      algod, signTransactions: async () => [], sender: SENDER, marketId: 1, side: "long",
      collateralAssetId: PEX_ASSETS.algo, collateralUsd: 10, notionalUsd: 25,
      triggerPrice12: ALGO_PRICE12,
    } as never)).rejects.toThrow(/Limit orders are USDC-only/);
  });

  it("does NOT refuse the same protection on USDC", async () => {
    // The refusal must be about the asset, not about protection existing.
    await expect(open({
      collateralAssetId: PEX_ASSETS.usdc,
      collateralAmountMicro: BigInt(10_000_000),
      takeProfitPrice12: BigInt(120_000_000_000),
    })).rejects.not.toThrow(/keeper fee would have to be paid in ALGO/);
  });

  it("allows a BARE ALGO open to get past the refusal", async () => {
    // It still fails further down on the stubbed quote, which is the point:
    // it reached the quote instead of being turned away at the door.
    await expect(open()).rejects.toThrow(/will not accept this position/);
  });
});

describe("the collateral reaches the quote in ASSET units", () => {
  it("passes µALGO through untouched, not a dollar figure", async () => {
    await open().catch(() => {});
    expect(quoteOpen).toHaveBeenCalled();
    const arg = quoteOpen.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.collateralAmountMicro).toBe(HUNDRED_ALGO);
    expect(arg.collateralAssetId).toBe(PEX_ASSETS.algo);
    expect(arg.algoPrice12).toBe(ALGO_PRICE12);
  });

  it("reads the ALGO position box, not the USDC one", async () => {
    await open().catch(() => {});
    // readPosition(algod, owner, marketId, collateralAssetId, side)
    expect(readPosition.mock.calls[0][3]).toBe(PEX_ASSETS.algo);
  });
});

describe("an unpriceable ALGO collateral is refused before anything is built", () => {
  it("throws rather than valuing it at zero", async () => {
    await expect(open({ algoPrice12: null })).rejects.toThrow(/No price available/);
  });
});

/**
 * ── What the BUILDER and the ASSERTION actually receive ─────────────────────
 *
 * The tests above stop at the quote, which review showed is not far enough:
 * five separate mutations to the open path survived the whole 937-test suite
 * because nothing executed past the probe. In particular,
 * `collateralAmount: micro(collateralUsd)` in `openInput` — the ~10.4x unit
 * bug, in the number that actually gets SIGNED — went undetected.
 *
 * These reach the builder by letting the quote succeed, then capture its
 * arguments. The SDK builder and the group assertion are stubbed because the
 * subject here is the WIRING, not their internals: what matters is which
 * numbers arrive.
 */
describe("the signed group carries the collateral the user chose", () => {
  const sdk = vi.hoisted(() => ({ bare: vi.fn(), withOrders: vi.fn() }));
  const grp = vi.hoisted(() => ({ assertOpen: vi.fn(), simulate: vi.fn() }));

  beforeEach(() => {
    sdk.bare.mockReset(); sdk.withOrders.mockReset();
    grp.assertOpen.mockReset(); grp.simulate.mockReset();
    sdk.bare.mockReturnValue([]);
    grp.assertOpen.mockReturnValue({ ok: true, checks: [], findings: [] });
    grp.simulate.mockResolvedValue({ ok: false, message: "stop after assert" });
    quoteOpen.mockReturnValue({
      ok: true, reasons: [],
      executionPrice12: ALGO_PRICE12,
      entryPrice12: ALGO_PRICE12,
      indexPrice12: ALGO_PRICE12,
      liquidationPrice12: BigInt(1),
      netCollateralUsd: 9.58,
      acceptablePrice12: ALGO_PRICE12,
    });
  });

  it("passes µALGO as collateralAmount, not a dollar figure", async () => {
    vi.doMock("@pdex/sdk/transactions", async (o) => ({
      ...(await o() as object),
      buildV2OpenOrIncreaseWithStorageTransactions: sdk.bare,
      buildV2MarketOpenWithAttachedOrdersTransactions: sdk.withOrders,
    }));
    vi.doMock("@/lib/strategy/pex/oracle", () => ({
      getOraclePayload: vi.fn(async () => ({
        signatureVerified: true, ageSeconds: 1,
        indexPrice12: ALGO_PRICE12,
        message: new Uint8Array(8), signature: new Uint8Array(8),
        decoded: {
          indexMinPrice: ALGO_PRICE12, indexMaxPrice: ALGO_PRICE12,
          longMinPrice: ALGO_PRICE12, longMaxPrice: ALGO_PRICE12,
          shortMinPrice: BigInt(1_000_000_000_000), shortMaxPrice: BigInt(1_000_000_000_000),
        },
      })),
    }));
    vi.doMock("@/lib/strategy/pex/group", async (o) => ({
      ...(await o() as object),
      assertOpenGroup: grp.assertOpen,
      simulateGroup: grp.simulate,
    }));
    vi.resetModules();
    const { openPosition: fresh } = await import("@/lib/strategy/perps/client");

    await fresh({
      algod, signTransactions: async () => [], sender: SENDER, marketId: 1, side: "long",
      collateralAssetId: PEX_ASSETS.algo, collateralAmountMicro: HUNDRED_ALGO,
      algoPrice12: ALGO_PRICE12, notionalUsd: 25, takeProfitPrice12: BigInt(0),
      displayed: {
        asRenderedIndexPrice12: ALGO_PRICE12,
        asRenderedEntryPrice12: ALGO_PRICE12,
        asRenderedLiquidationPrice12: BigInt(1),
        asRenderedNetCollateralMicro: BigInt(9_580_000),
        asRenderedLeverage: 2.6,
      },
    } as never).catch(() => {});

    expect(sdk.bare, "the bare-open builder was never reached").toHaveBeenCalled();
    const built = sdk.bare.mock.calls[0][0] as Record<string, unknown>;
    // THE assertion: 100 ALGO must be 100_000_000 µALGO, not $9.58 of µUSD.
    expect(built.collateralAmount).toBe(HUNDRED_ALGO);
    expect(built.collateralAssetId).toBe(PEX_ASSETS.algo);

    // And the group assertion must be shown the same numbers as the builder,
    // or it is checking a different transaction than the one being signed.
    expect(grp.assertOpen).toHaveBeenCalled();
    const shown = grp.assertOpen.mock.calls[0][1] as Record<string, unknown>;
    expect(shown.collateralAmountMicro).toBe(built.collateralAmount);
    expect(shown.collateralAssetId).toBe(built.collateralAssetId);
  });
});


describe("ALGO is held back so the position can be closed", () => {
  /**
   * With ALGO collateral the stake, the fees and the storage escrow all leave
   * the same spendable balance. Before this reserve a user could commit the
   * rest and have nothing left to pay the EXIT with — a position that cannot
   * be closed from the wallet that owns it, reachable by entering a sensible
   * number. Found by review.
   *
   * 250,000 µALGO, against 93,000-123,000 observed on real closes.
   */
  const spendable = (micro: bigint) => {
    balance.amount = micro + balance.minBalance;
  };
  afterEach(() => { balance.amount = BigInt(500_000_000); });

  it("refuses an amount that leaves nothing for the exit", async () => {
    // Enough for 100 ALGO of collateral and the group's own fees, and NOT
    // enough for the reserve on top.
    spendable(BigInt(100_000_000) + BigInt(80_000));
    await expect(open()).rejects.toThrow(/close this position later/i);
  });

  it("names the reserve in the message, rather than just a bigger number", async () => {
    spendable(BigInt(100_000_000) + BigInt(80_000));
    await expect(open()).rejects.toThrow(/0\.25/);
  });

  it("allows the same amount once the reserve fits", async () => {
    spendable(BigInt(100_000_000) + BigInt(80_000) + BigInt(250_000));
    // Gets past the balance check and on to the stubbed quote.
    await expect(open()).rejects.toThrow(/will not accept this position/);
  });

  it("does NOT hold a reserve against USDC collateral", async () => {
    // The stake does not come out of ALGO there, so the only ALGO needed is
    // fees — reserving a quarter of an ALGO would refuse honest trades.
    spendable(BigInt(80_000));
    await expect(open({
      collateralAssetId: PEX_ASSETS.usdc,
      collateralAmountMicro: BigInt(10_000_000),
    })).rejects.not.toThrow(/close this position later/i);
  });
});
