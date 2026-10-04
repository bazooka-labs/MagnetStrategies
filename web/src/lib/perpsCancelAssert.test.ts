// Perps — `assertCancelGroup`, and the three other guards added for audit 8
// that shipped with no test.
//
// The audit-8 remediation spec said the SB1 fix was "not complete without a real
// fixture-based test for `assertOpenLimitGroup` AND `assertCancelGroup`". Only
// the first got written. Review of that remediation caught the omission, along
// with three more new guards nothing in CI exercised: `SHAPE_CLOSE.orderOps: 0`,
// `recall_asset_unpinned`, and `MAX_CANCEL_GROUP_FEE_MICRO_ALGO`. All four were
// verified by hand against MainNet; none of that runs again on the next change.
//
// That is the whole lesson of SB1 restated: a guard verified once by a human is
// not a guard that stays verified.

import { describe, expect, it } from "vitest";
import algosdk from "algosdk";
import {
  assertCancelGroup, assertCloseGroup,
  MAX_CANCEL_GROUP_FEE_MICRO_ALGO, PEX_SELECTORS,
  type DisplayedCancel, type DisplayedClose,
} from "./perpsGroup";
import {
  ALGORAND_MAINNET_GENESIS_HASH_HEX, COLLATERAL_ASSET_ID, PEX_APPS, PEX_ASSETS,
} from "./perps";

const SENDER = "5YCWR662A5HIOFYYS2CTIHHYBCIXESVLAOVLZ7CL27PK5SKBROCSRFIJMA";
const OTHER = "KNML6OW2XVXYSSGQX7EBLBMSLAPY6QFNBZUJMNEFIEXIIVJLMW4VINYU6A";
const hexBytes = (h: string) => Uint8Array.from((h.match(/../g) ?? []).map((b) => parseInt(b, 16)));
const u64 = (v: bigint | number) => algosdk.encodeUint64(BigInt(v));
const sp = { fee: 1000, firstValid: 1, lastValid: 1001, genesisID: "mainnet-v1.0",
  genesisHash: hexBytes(ALGORAND_MAINNET_GENESIS_HASH_HEX), minFee: 1000, flatFee: true } as never;

const ORDER_ID = BigInt(1790922890761371);
const orderBox = (owner: string, id: bigint) => ({
  appIndex: BigInt(PEX_APPS.orderOps),
  name: new Uint8Array([
    ...new TextEncoder().encode("o2:"),
    ...algosdk.decodeAddress(owner).publicKey, ...u64(id),
  ]),
});

function cancelGroup(opts: { ids?: bigint[]; owner?: string; fee?: number } = {}) {
  const ids = opts.ids ?? [ORDER_ID];
  const call = algosdk.makeApplicationNoOpTxnFromObject({
    sender: SENDER, appIndex: PEX_APPS.orderOps,
    appArgs: [hexBytes(PEX_SELECTORS.cancelOrder), u64(ORDER_ID)],
    boxes: ids.map((id) => orderBox(opts.owner ?? SENDER, id)),
    foreignAssets: [COLLATERAL_ASSET_ID],
    suggestedParams: { ...(sp as object), fee: opts.fee ?? 14_000 } as never,
  });
  const txns = [call];
  algosdk.assignGroupID(txns);
  return txns;
}
const shownCancel = (attached: bigint[] = []): DisplayedCancel => ({
  sender: SENDER, ownerOrderId: ORDER_ID,
  attachedOrderIds: attached, collateralAssetId: COLLATERAL_ASSET_ID,
});

describe("assertCancelGroup", () => {
  it("accepts a standalone cancel", () => {
    const a = assertCancelGroup(cancelGroup(), shownCancel());
    expect(a.findings.map((f) => f.code)).toEqual([]);
  });

  it("accepts a bracket cancel naming its child", () => {
    const child = ORDER_ID + BigInt(1);
    const g = cancelGroup({ ids: [ORDER_ID, child] });
    // A bracket cancel carries a budget carrier, which the shape expects.
    g.length = 0;
    const call = algosdk.makeApplicationNoOpTxnFromObject({
      sender: SENDER, appIndex: PEX_APPS.orderOps,
      appArgs: [hexBytes(PEX_SELECTORS.cancelOrder), u64(ORDER_ID)],
      boxes: [orderBox(SENDER, ORDER_ID), orderBox(SENDER, child)],
      foreignAssets: [COLLATERAL_ASSET_ID],
      suggestedParams: { ...(sp as object), fee: 14_000 } as never,
    });
    const carrier = algosdk.makeApplicationNoOpTxnFromObject({
      sender: SENDER, appIndex: PEX_APPS.math,
      appArgs: [hexBytes(PEX_SELECTORS.mathNoop)],
      suggestedParams: { ...(sp as object), fee: 1_000 } as never,
    });
    const txns = [call, carrier];
    algosdk.assignGroupID(txns);
    expect(assertCancelGroup(txns, shownCancel([child])).findings.map((f) => f.code)).toEqual([]);
  });

  it("refuses a group that cancels a different order than the screen named", () => {
    const g = cancelGroup();
    (g[0].applicationCall!.appArgs as Uint8Array[])[1] = u64(ORDER_ID + BigInt(5));
    expect(assertCancelGroup(g, shownCancel()).findings.map((f) => f.code)).toContain("cancel_order_id");
  });

  it("refuses a box belonging to another account", () => {
    const g = cancelGroup({ owner: OTHER });
    expect(assertCancelGroup(g, shownCancel()).findings.map((f) => f.code)).toContain("cancel_box_owner");
  });

  it("refuses a box the screen never mentioned", () => {
    const g = cancelGroup({ ids: [ORDER_ID, ORDER_ID + BigInt(9)] });
    // Only ORDER_ID was shown, so the second box is an order the user did not
    // agree to touch — plausibly the take-profit on a live position.
    expect(assertCancelGroup(g, shownCancel()).findings.map((f) => f.code)).toContain("cancel_box_id");
  });

  it("refuses an asset transfer smuggled into a cancel", () => {
    const g = cancelGroup();
    g.push(algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: SENDER, receiver: OTHER, amount: 5_000_000,
      assetIndex: COLLATERAL_ASSET_ID, suggestedParams: sp,
    }));
    algosdk.assignGroupID(g);
    expect(assertCancelGroup(g, shownCancel()).findings.map((f) => f.code)).toContain("axfer_count");
  });

  it("refuses a second cancel_order call", () => {
    const g = cancelGroup();
    g.push(algosdk.makeApplicationNoOpTxnFromObject({
      sender: SENDER, appIndex: PEX_APPS.orderOps,
      appArgs: [hexBytes(PEX_SELECTORS.cancelOrder), u64(ORDER_ID + BigInt(1))],
      boxes: [orderBox(SENDER, ORDER_ID + BigInt(1))], suggestedParams: sp,
    }));
    algosdk.assignGroupID(g);
    const codes = assertCancelGroup(g, shownCancel()).findings.map((f) => f.code);
    expect(codes.some((c) => c === "cancel_call_count" || c === "call_budget")).toBe(true);
  });

  it("bounds the total fee — the cap that did not exist", () => {
    // Audit 8 HIGH 3: this path discarded checkEveryTransaction's return value,
    // and MainNet accepted a 5 ALGO cancel on all three live orders.
    const g = cancelGroup({ fee: 5_000_000 });
    expect(assertCancelGroup(g, shownCancel()).findings.map((f) => f.code)).toContain("fee_cap");
  });

  it("does not fire on a real cancel's measured fee", () => {
    // 14,000 standalone / 15,000 bracket, both measured. A cap that refuses a
    // correct group is the failure mode this project keeps hitting.
    for (const fee of [14_000, 15_000, MAX_CANCEL_GROUP_FEE_MICRO_ALGO]) {
      const a = assertCancelGroup(cancelGroup({ fee }), shownCancel());
      expect(a.findings.map((f) => f.code), `fee ${fee}`).not.toContain("fee_cap");
    }
  });
});

// ── The close-path guards that also shipped untested ────────────────────────

const CLOSE_RECALL = {
  accounts: [algosdk.getApplicationAddress(PEX_APPS.markets).toString()],
  assets: [PEX_ASSETS.xAlgo, PEX_ASSETS.fUsdc],
  apps: [PEX_APPS.markets],
};
const shownClose = (recall = CLOSE_RECALL): DisplayedClose => ({
  sender: SENDER, marketId: 1, side: 1, collateralAssetId: COLLATERAL_ASSET_ID,
  sizeUsdDeltaMicro: BigInt(60_000_000), positionSizeUsdMicro: BigInt(60_000_000),
  fullClose: true, acceptablePrice12: BigInt(130_000_000_000),
  executionPrice12: BigInt(131_000_000_000), indexPrice12: BigInt(131_000_000_000),
  slippageBps: 50, expectedPositionId: BigInt(84),
  oracleMessage: new Uint8Array(133).fill(7), oracleSignature: new Uint8Array(64).fill(6),
  yieldRecallMode: BigInt(1),
  maxLongReceiptAmount: BigInt(1), maxShortReceiptAmount: BigInt(0),
  recall,
} as DisplayedClose);

describe("the close guards added for audit 8", () => {
  it("refuses a recall asset that is not the pinned xALGO or fUSDC", () => {
    // LOW 11. `perpsCloseReal.test.ts` passes an empty recall set, so this loop
    // was vacuous in the only close test that existed.
    const g = [algosdk.makeApplicationNoOpTxnFromObject({
      sender: SENDER, appIndex: PEX_APPS.trading, appArgs: [hexBytes("deadbeef")],
      suggestedParams: sp,
    })];
    algosdk.assignGroupID(g);
    // Cast because `recall.assets` is typed to the two pinned ids — which is
    // the guard working at the type level. The runtime check still has to exist:
    // the registry is built from third-party boxes at runtime, so the type
    // cannot be what enforces it.
    const a = assertCloseGroup(g, shownClose({
      ...CLOSE_RECALL, assets: [COLLATERAL_ASSET_ID] as unknown as typeof CLOSE_RECALL.assets,
    }));
    expect(a.findings.map((f) => f.code)).toContain("recall_asset_unpinned");
  });

  it("refuses an OrderOps call inside a close", () => {
    // HIGH 4. A real close group plus an injected cancel_order — which cancels
    // the user's own take-profit — passed before `orderOps: 0`.
    const trading = algosdk.makeApplicationNoOpTxnFromObject({
      sender: SENDER, appIndex: PEX_APPS.trading, appArgs: [hexBytes("deadbeef")],
      suggestedParams: sp,
    });
    const sneak = algosdk.makeApplicationNoOpTxnFromObject({
      sender: SENDER, appIndex: PEX_APPS.orderOps,
      appArgs: [hexBytes(PEX_SELECTORS.cancelOrder), u64(2)], suggestedParams: sp,
    });
    const g = [trading, sneak];
    algosdk.assignGroupID(g);
    expect(assertCloseGroup(g, shownClose()).findings.map((f) => f.code)).toContain("call_budget");
  });
});
