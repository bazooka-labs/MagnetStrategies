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

const call = (collateralAssetId: number, position: ReturnType<typeof box>) =>
  closePosition({
    algod: {} as never,
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
  it("refuses rather than closing the position it happened to find", async () => {
    // The box that came back is USDC-backed though ALGO was asked for. With a
    // correct key this cannot happen; the check is the belt, and it is the
    // only place the two can be compared because the box states its backing.
    readPosition.mockResolvedValue(box(PEX_ASSETS.usdc, BigInt(48)));
    await expect(call(PEX_ASSETS.algo, box(PEX_ASSETS.algo, BigInt(48))))
      .rejects.toThrow(/not backed by the asset/i);
  });

  it("catches the pre-cutover case the position_id check cannot", async () => {
    /**
     * Both boxes carry `position_id = 0` before the identity cutover
     * (SPEC.md:785), so `live.position_id !== position.position_id` is
     * `0 !== 0` — false — and that guard waves the mismatch through. This is
     * the one combination where a wrong collateral would have reached the
     * builder, and it is why the check is not merely defensive.
     */
    readPosition.mockResolvedValue(box(PEX_ASSETS.usdc, BigInt(0)));
    await expect(call(PEX_ASSETS.algo, box(PEX_ASSETS.algo, BigInt(0))))
      .rejects.toThrow(/not backed by the asset/i);
  });

  it("still refuses a replaced position when the collateral DOES match", async () => {
    // The original guard must survive: same asset, different id.
    readPosition.mockResolvedValue(box(PEX_ASSETS.usdc, BigInt(99)));
    await expect(call(PEX_ASSETS.usdc, box(PEX_ASSETS.usdc, BigInt(48))))
      .rejects.toThrow(/has been replaced/i);
  });
});
