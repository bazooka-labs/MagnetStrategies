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

import { describe, expect, it, vi, beforeEach } from "vitest";

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

const algod = {
  accountInformation: () => ({ do: async () => ({ amount: BigInt(500_000_000), minBalance: BigInt(100_000), assets: [] }) }),
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
