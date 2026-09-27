// Perps — the assertion the write path actually calls, against real SDK groups.
//
// ── Why this file exists ─────────────────────────────────────────────────────
// `perpsGroup.test.ts` covers `assertOpenGroup` and `assertCloseGroup`, and
// production calls NEITHER. The only assertion `openPosition` runs is
// `assertOpenWithTakeProfit` (perpsClient.ts), and it had no coverage at all —
// so every Phase 3 take-profit fix (escrow receiver and asset, MBR receiver,
// `tp_size`, the `acceptableWithin` replacement on the TP leg, the child
// builder fee) shipped untested.
//
// That is the B1 lesson wearing a different mask. B1 escaped because the
// harness computed a price itself while production called a helper; this
// escaped because the harness asserted a function production never calls.
//
// The groups here are REAL `@pdex/sdk` 0.6.3 output captured from MainNet and
// committed as a fixture, decoded back into genuine algosdk Transactions — not
// object literals shaped the way I imagined the SDK shapes them. Regenerate
// with `CAPTURE=1 npx vitest run src/lib/__fixtures__/capture.test.ts`.

import { describe, expect, it } from "vitest";
import algosdk from "algosdk";
import fixture from "./__fixtures__/perpsGroups.json";
import {
  assertOpenWithTakeProfit,
  type DisplayedOpen,
  type DisplayedTakeProfit,
} from "./perpsGroup";
import { COLLATERAL_ASSET_ID, PEX_APPS } from "./perps";

type Captured = {
  marketId: number; side: "long" | "short"; sender: string;
  collateralAmountMicro: string; sizeUsdDeltaMicro: string;
  acceptablePrice12: string; executionPrice12: string; indexPrice12: string;
  slippageBps: number; oracleMessage: string; oracleSignature: string;
  tpTriggerPrice12: string; tpAcceptablePrice12: string;
  tpKeeperFeeMicro: string; baseOrderId: string; txns: string[];
};

const groups = fixture.groups as unknown as Record<string, Captured>;
const names = Object.keys(groups);
const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));

/** Fresh Transaction objects each time, so a mutation cannot leak between tests. */
function decode(c: Captured): algosdk.Transaction[] {
  return c.txns.map((t) => algosdk.decodeUnsignedTransaction(bytes(t)));
}
const shownOpen = (c: Captured): DisplayedOpen => ({
  sender: c.sender, marketId: c.marketId, side: c.side === "long" ? 1 : 2,
  collateralAssetId: COLLATERAL_ASSET_ID,
  collateralAmountMicro: BigInt(c.collateralAmountMicro),
  sizeUsdDeltaMicro: BigInt(c.sizeUsdDeltaMicro),
  acceptablePrice12: BigInt(c.acceptablePrice12),
  executionPrice12: BigInt(c.executionPrice12),
  indexPrice12: BigInt(c.indexPrice12),
  slippageBps: c.slippageBps,
  oracleMessage: bytes(c.oracleMessage), oracleSignature: bytes(c.oracleSignature),
});
const shownTp = (c: Captured): DisplayedTakeProfit => ({
  triggerPrice12: BigInt(c.tpTriggerPrice12),
  acceptablePrice12: BigInt(c.tpAcceptablePrice12),
  sizeUsdDeltaMicro: BigInt(c.sizeUsdDeltaMicro),
  keeperFeeMicro: BigInt(c.tpKeeperFeeMicro),
  baseOrderId: BigInt(c.baseOrderId),
  slippageBps: c.slippageBps,
});

describe("assertOpenWithTakeProfit — the assertion production calls", () => {
  it("has fixtures for both markets and both sides", () => {
    expect(names.sort()).toEqual(["m1_long", "m1_short", "m2_long", "m2_short"]);
  });

  for (const name of names) {
    const c = groups[name];

    it(`${name}: accepts the real group unmodified`, () => {
      const r = assertOpenWithTakeProfit(decode(c), shownOpen(c), shownTp(c));
      expect(r.findings).toEqual([]);
      expect(r.ok).toBe(true);
    });

    it(`${name}: the real group is the shape we assert`, () => {
      const types = decode(c).map((t) => t.type);
      // If the SDK ever changes shape, this fails here rather than silently
      // widening what the assertion accepts.
      expect(types).toEqual(["axfer", "appl", "appl", "appl", "appl", "axfer", "pay", "appl", "appl"]);
      expect(decode(c).reduce((a, t) => a + Number(t.fee), 0)).toBe(51_000);
    });
  }

  // ── Injected foreign transaction types (H-2, audit 3) ──────────────────────
  //
  // Every other check finds its leg by looking for a sub-object, so a
  // transaction carrying none of them used to be invisible to all of them.
  const c = groups[names[0]];
  const sp = () => {
    const t = decode(c)[0];
    return {
      fee: t.fee, minFee: BigInt(1000),
      firstValid: t.firstValid, lastValid: t.lastValid,
      genesisHash: t.genesisHash, genesisID: t.genesisID,
    };
  };

  it("catches an injected asset-config transaction (clawback takeover)", () => {
    // The money case: one extra transaction, sender the user, handing an
    // attacker manager/clawback on an ASA that user administers.
    const attacker = "7777777777777777777777777777777777777777777777777774MSJUVU";
    const acfg = algosdk.makeAssetConfigTxnWithSuggestedParamsFromObject({
      sender: c.sender, assetIndex: 12345678,
      manager: attacker, reserve: attacker, freeze: attacker, clawback: attacker,
      strictEmptyAddressChecking: false, suggestedParams: sp() as algosdk.SuggestedParams,
    });
    const r = assertOpenWithTakeProfit([...decode(c), acfg], shownOpen(c), shownTp(c));
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("txn_type");
  });

  it("catches an injected key-registration transaction", () => {
    const keyreg = algosdk.makeKeyRegistrationTxnWithSuggestedParamsFromObject({
      sender: c.sender, nonParticipation: true,
      suggestedParams: sp() as algosdk.SuggestedParams,
    });
    const r = assertOpenWithTakeProfit([...decode(c), keyreg], shownOpen(c), shownTp(c));
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("txn_type");
  });

  it("catches an extra payment leg beyond the one MBR payment", () => {
    const pay = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: c.sender, receiver: c.sender, amount: 1_000_000,
      suggestedParams: sp() as algosdk.SuggestedParams,
    });
    const r = assertOpenWithTakeProfit([...decode(c), pay], shownOpen(c), shownTp(c));
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("pay_count");
  });

  it("catches an extra asset transfer beyond collateral and escrow", () => {
    const axfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: c.sender, receiver: c.sender, amount: 1_000_000,
      assetIndex: COLLATERAL_ASSET_ID, suggestedParams: sp() as algosdk.SuggestedParams,
    });
    const r = assertOpenWithTakeProfit([...decode(c), axfer], shownOpen(c), shownTp(c));
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("axfer_count");
  });

  // ── The Phase 3 take-profit fixes, now actually exercised ──────────────────

  const tamper = (
    name: string,
    mutate: (txns: algosdk.Transaction[]) => void,
    code: string,
    alsoShownTp?: (t: DisplayedTakeProfit) => void,
  ) => it(`catches: ${name}`, () => {
    const txns = decode(c);
    mutate(txns);
    const tp = shownTp(c);
    alsoShownTp?.(tp);
    const r = assertOpenWithTakeProfit(txns, shownOpen(c), tp);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain(code);
  });

  const escrowOf = (txns: algosdk.Transaction[]) =>
    txns.filter((t) => t.assetTransfer)
      .find((t) => t.assetTransfer!.amount !== BigInt(c.collateralAmountMicro))!;

  tamper("keeper escrow redirected to an attacker",
    (txns) => {
      const e = escrowOf(txns);
      (e.assetTransfer as unknown as { receiver: algosdk.Address }).receiver =
        algosdk.decodeAddress("7777777777777777777777777777777777777777777777777774MSJUVU");
    }, "keeper_escrow_receiver");

  tamper("keeper escrow swapped to another asset",
    (txns) => {
      const e = escrowOf(txns);
      (e.assetTransfer as unknown as { assetIndex: bigint }).assetIndex = BigInt(1_284_444_444);
    }, "keeper_escrow_asset");

  tamper("MBR payment redirected to an attacker",
    (txns) => {
      const p = txns.find((t) => t.payment)!;
      (p.payment as unknown as { receiver: algosdk.Address }).receiver =
        algosdk.decodeAddress("7777777777777777777777777777777777777777777777777774MSJUVU");
    }, "mbr_receiver");

  tamper("MBR payment inflated",
    (txns) => {
      const p = txns.find((t) => t.payment)!;
      (p.payment as unknown as { amount: bigint }).amount = BigInt(5_000_000);
    }, "order_box_mbr");

  tamper("collateral transfer redirected to an attacker",
    (txns) => {
      (txns[0].assetTransfer as unknown as { receiver: algosdk.Address }).receiver =
        algosdk.decodeAddress("7777777777777777777777777777777777777777777777777774MSJUVU");
    }, "transfer_receiver");

  tamper("a leg sent by someone other than the user",
    (txns) => {
      (txns[0] as unknown as { sender: algosdk.Address }).sender =
        algosdk.decodeAddress("7777777777777777777777777777777777777777777777777774MSJUVU");
    }, "foreign_sender");

  tamper("rekeyTo set on a leg",
    (txns) => {
      (txns[0] as unknown as { rekeyTo: algosdk.Address }).rekeyTo =
        algosdk.decodeAddress("7777777777777777777777777777777777777777777777777774MSJUVU");
    }, "rekey");

  // M-4: the TP's acceptable price was bounded against its trigger but never
  // equality-checked against what was displayed. Mutating BOTH the arg and the
  // shown value keeps it inside the slippage band, so only the equality check
  // can catch it — which is the whole point.
  tamper("take-profit acceptable price moved within the slippage band",
    (txns) => {
      // By app id, not by position: the OrderOps leg is index 7 of 9, and the
      // LAST transaction is a Math carrier.
      const tp = txns.find((t) => Number(t.applicationCall?.appIndex) === PEX_APPS.orderOps)!;
      const args = tp.applicationCall!.appArgs as Uint8Array[];
      const cur = algosdk.decodeUint64(args[10], "bigint");
      args[10] = algosdk.encodeUint64((cur * BigInt(9_999)) / BigInt(10_000));
    }, "tp_acceptable_price");

  tamper("fees inflated across the group",
    (txns) => { txns.forEach((t) => { (t as unknown as { fee: bigint }).fee = BigInt(30_000); }); },
    "fee_cap");
});
