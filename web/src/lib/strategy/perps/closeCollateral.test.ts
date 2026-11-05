// The close and cancel WRITE paths must follow the position's own collateral.
//
// ── Why this file exists ────────────────────────────────────────────────────
// `closeAssembly`, `closeReal` and `cancelAssert` all call the ASSERT functions
// directly, each passing `COLLATERAL_ASSET_ID` as a fixture value. None of them
// exercises `client.ts`, so when the client hardcoded USDC into every close and
// cancel it build, all 913 tests passed. The untested seam was the wiring, not
// the assertion.
//
// ── What was actually wrong ─────────────────────────────────────────────────
// `collateralAssetId` is part of the `p2:` key, so it does not merely describe
// the close — it SELECTS THE BOX. Passing USDC for an ALGO-collateral position
// reads a different position, and then every subsequent check passes honestly
// against the wrong one.
//
// Making ALGO positions visible in the panel is what put a live "Close
// position" button on them; before that the hardcoding was unreachable.

import { describe, expect, it, vi, beforeEach } from "vitest";

const readPosition = vi.fn();
const readMarketState = vi.fn();
const readYieldRegistry = vi.fn();
const preflight = vi.fn();

vi.mock("@/lib/strategy/pex/reads", () => ({
  readPosition: (...a: unknown[]) => readPosition(...a),
  readMarketState: (...a: unknown[]) => readMarketState(...a),
  readYieldRegistry: (...a: unknown[]) => readYieldRegistry(...a),
  readOrders: vi.fn(), readTraderState: vi.fn(), allocateBaseOrderId: vi.fn(),
  orderLinkBaseOrderId: vi.fn(), assertBaseOrderIdFree: vi.fn(),
  storagePaymentNeeded: vi.fn(),
}));
vi.mock("@/lib/strategy/pex/manifest", () => ({ installProtocolManifest: vi.fn() }));
vi.mock("@/lib/strategy/perps/preflight", () => ({
  preflight: (...a: unknown[]) => preflight(...a),
  exitBlocked: () => false,
}));

import { closePosition } from "@/lib/strategy/perps/client";
import { PEX_ASSETS } from "@/lib/strategy/pex/config";

const SENDER = "MAGNETTESTADDRESSMAGNETTESTADDRESSMAGNETTESTADDRESSMAG";

/** A position box as `readPosition` returns one. */
const box = (collateralAssetId: number, positionId: bigint) => ({
  size_usd: BigInt(15_000_000),
  collateral_amount: BigInt(5_000_000),
  collateral_asset_id: BigInt(collateralAssetId),
  position_id: positionId,
  side: BigInt(1),
  entry_price: BigInt(95_000_000_000),
});

/**
 * An account that can RECEIVE the payout, and afford the fees.
 *
 * `{}` was enough until the close gained a receive-capability preflight: it
 * reads the sender's holdings so a wallet that is not opted in to a payout
 * asset is told so, instead of hitting an atomic group failure with a raw
 * `logic eval error`. These tests are about which BOX the close reads, so the
 * account is set up to pass and get out of the way — `optInTo` is the knob for
 * the tests that care.
 */
const algodWithAccount = (optInTo: number[] = [31566704], microAlgo = 5_000_000) => ({
  accountInformation: () => ({
    do: async () => ({
      amount: microAlgo,
      assets: optInTo.map((assetId) => ({ assetId, amount: 0 })),
    }),
  }),
}) as never;

const call = (collateralAssetId: number, position: ReturnType<typeof box>) =>
  closePosition({
    algod: algodWithAccount(),
    signTransactions: async () => [],
    sender: SENDER,
    marketId: 1,
    side: "long",
    collateralAssetId,
    sizeUsdMicro: BigInt(15_000_000),
    position: position as never,
    quote: { ok: true, executionPrice12: BigInt(95_000_000_000) } as never,
  });

beforeEach(() => {
  readPosition.mockReset();
  readMarketState.mockReset();
  readYieldRegistry.mockReset();
  preflight.mockReset();
  readMarketState.mockResolvedValue({ core: { index_asset_id: BigInt(0), long_asset_id: BigInt(0), short_asset_id: BigInt(31566704) } });
  preflight.mockResolvedValue({ canOpen: true, kind: "ok" });
});

describe("the close reads the box the user clicked on", () => {
  it("reads with ALGO when the position is ALGO-backed, not with USDC", async () => {
    const pos = box(PEX_ASSETS.algo, BigInt(52));
    readPosition.mockResolvedValue(pos);
    await call(PEX_ASSETS.algo, pos).catch(() => {});
    expect(readPosition).toHaveBeenCalled();
    // readPosition(algod, owner, marketId, collateralAssetId, side)
    expect(readPosition.mock.calls[0][3]).toBe(PEX_ASSETS.algo);
  });

  it("reads with USDC when the position is USDC-backed", async () => {
    const pos = box(PEX_ASSETS.usdc, BigInt(48));
    readPosition.mockResolvedValue(pos);
    await call(PEX_ASSETS.usdc, pos).catch(() => {});
    expect(readPosition.mock.calls[0][3]).toBe(PEX_ASSETS.usdc);
  });
});

describe("a box backed by a different asset is refused", () => {
  it("refuses when the caller's two arguments disagree", async () => {
    /**
     * The mismatch that can actually occur: the `position` object from one row
     * passed with another row's `collateralAssetId`. `readPosition` is NOT
     * stubbed inconsistently here — it returns the box that really would be
     * found under the asked-for key, which is a DIFFERENT position.
     *
     * An earlier version of this test stubbed the box to report an asset it
     * could not have been stored under, which made the guard look effective
     * when it was a tautology. Review caught that; this is the replacement.
     */
    readPosition.mockResolvedValue(box(PEX_ASSETS.algo, BigInt(52)));
    await expect(call(PEX_ASSETS.algo, box(PEX_ASSETS.usdc, BigInt(48))))
      .rejects.toThrow(/not backed by the asset/i);
  });

  it("catches the pre-cutover case the position_id check cannot", async () => {
    /**
     * Before the identity cutover every position carries `position_id = 0`
     * (SPEC.md:785). So for a wallet holding one position per collateral in
     * the same market and side, `live.position_id !== position.position_id`
     * is `0 !== 0` — false — and that guard passes the mismatch straight
     * through to the builder, clamped to the WRONG position's size.
     *
     * This is the only combination where a wrong collateral reaches the
     * group, which is why the asset check is load-bearing rather than
     * defensive.
     */
    readPosition.mockResolvedValue(box(PEX_ASSETS.algo, BigInt(0)));
    await expect(call(PEX_ASSETS.algo, box(PEX_ASSETS.usdc, BigInt(0))))
      .rejects.toThrow(/not backed by the asset/i);
  });

  it("still refuses a replaced position when the collateral DOES match", async () => {
    // The original guard must survive: same asset, different id.
    readPosition.mockResolvedValue(box(PEX_ASSETS.usdc, BigInt(99)));
    await expect(call(PEX_ASSETS.usdc, box(PEX_ASSETS.usdc, BigInt(48))))
      .rejects.toThrow(/has been replaced/i);
  });
});
