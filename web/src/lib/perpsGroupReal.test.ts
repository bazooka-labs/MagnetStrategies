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
  POSITION_BOX_MBR_MICRO_ALGO,
  assertOpenWithAttachedOrders,
  ORDER_KIND_STOP_LOSS,
  ORDER_KIND_TAKE_PROFIT,
  type DisplayedOpen,
  type DisplayedTakeProfit,
} from "./perpsGroup";
import { COLLATERAL_ASSET_ID, PEX_APPS } from "./perps";

/**
 * The old single-leg call shape, for the fixtures captured under it.
 *
 * `assertOpenWithTakeProfit` is gone — it located the keeper-fee escrow by
 * elimination ("the transfer that is not the collateral"), which breaks the
 * moment a group carries two legs, so keeping a PRODUCTION wrapper would have
 * kept the defect reachable. This adapter lives in the test only: it adapts the
 * captured one-leg fixtures to the new signature, so every tamper below still
 * exercises exactly what it did before.
 */
const assertTp = (txns: unknown[], open: DisplayedOpen, tp: DisplayedTakeProfit) =>
  assertOpenWithAttachedOrders(txns, open, [{
    ...tp,
    orderKind: ORDER_KIND_TAKE_PROFIT,
    childOrderId: tp.baseOrderId + BigInt(1),
  }]);

type Captured = {
  marketId: number; side: "long" | "short"; sender: string;
  collateralAmountMicro: string; sizeUsdDeltaMicro: string;
  acceptablePrice12: string; executionPrice12: string; indexPrice12: string;
  slippageBps: number; oracleMessage: string; oracleSignature: string;
  tpTriggerPrice12: string; tpAcceptablePrice12: string;
  tpKeeperFeeMicro: string; baseOrderId: string;
  tpOracleMessage: string; tpOracleSignature: string; txns: string[];
  storagePaymentMicro: string; storageTxns: string[];
};

const groups = fixture.groups as unknown as Record<string, Captured>;
const names = Object.keys(groups);
const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));

/** First index at which `needle` occurs in `hay`, or -1. */
function indexOfSub(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Fresh Transaction objects each time, so a mutation cannot leak between tests. */
function decode(c: Captured): algosdk.Transaction[] {
  return c.txns.map((t) => algosdk.decodeUnsignedTransaction(bytes(t)));
}
/** The same open for a trader whose storage escrow needs funding. */
function decodeStorage(c: Captured): algosdk.Transaction[] {
  return c.storageTxns.map((t) => algosdk.decodeUnsignedTransaction(bytes(t)));
}
const shownOpenStorage = (c: Captured): DisplayedOpen => ({
  ...shownOpen(c), storagePaymentMicro: BigInt(c.storagePaymentMicro),
});
const shownOpen = (c: Captured): DisplayedOpen => ({
  storagePaymentMicro: BigInt(0),
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
  oracleMessage: bytes(c.tpOracleMessage),
  oracleSignature: bytes(c.tpOracleSignature),
});

describe("assertOpenWithTakeProfit — the assertion production calls", () => {
  it("has fixtures for both markets and both sides", () => {
    expect(names.sort()).toEqual(["m1_long", "m1_short", "m2_long", "m2_short"]);
  });

  for (const name of names) {
    const c = groups[name];

    it(`${name}: accepts the real group unmodified`, () => {
      const r = assertTp(decode(c), shownOpen(c), shownTp(c));
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
    const r = assertTp([...decode(c), acfg], shownOpen(c), shownTp(c));
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("txn_type");
  });

  it("catches an injected key-registration transaction", () => {
    const keyreg = algosdk.makeKeyRegistrationTxnWithSuggestedParamsFromObject({
      sender: c.sender, nonParticipation: true,
      suggestedParams: sp() as algosdk.SuggestedParams,
    });
    const r = assertTp([...decode(c), keyreg], shownOpen(c), shownTp(c));
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("txn_type");
  });

  it("catches an extra payment leg beyond the one MBR payment", () => {
    const pay = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: c.sender, receiver: c.sender, amount: 1_000_000,
      suggestedParams: sp() as algosdk.SuggestedParams,
    });
    const r = assertTp([...decode(c), pay], shownOpen(c), shownTp(c));
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("pay_count");
  });

  it("catches an extra asset transfer beyond collateral and escrow", () => {
    const axfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: c.sender, receiver: c.sender, amount: 1_000_000,
      assetIndex: COLLATERAL_ASSET_ID, suggestedParams: sp() as algosdk.SuggestedParams,
    });
    const r = assertTp([...decode(c), axfer], shownOpen(c), shownTp(c));
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
    const r = assertTp(txns, shownOpen(c), tp);
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
    }, "tp_escrow_receiver");

  tamper("keeper escrow swapped to another asset",
    (txns) => {
      const e = escrowOf(txns);
      (e.assetTransfer as unknown as { assetIndex: bigint }).assetIndex = BigInt(1_284_444_444);
    }, "tp_escrow_asset");

  tamper("MBR payment redirected to an attacker",
    (txns) => {
      const p = txns.find((t) => t.payment)!;
      (p.payment as unknown as { receiver: algosdk.Address }).receiver =
        algosdk.decodeAddress("7777777777777777777777777777777777777777777777777774MSJUVU");
    }, "tp_mbr_receiver");

  tamper("MBR payment inflated",
    (txns) => {
      const p = txns.find((t) => t.payment)!;
      (p.payment as unknown as { amount: bigint }).amount = BigInt(5_000_000);
    }, "tp_order_box_mbr");

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

  // ── L-1 / L-2: fields that were declared on the transaction and never read ─

  tamper("a note smuggled onto the collateral leg",
    (txns) => {
      (txns[0] as unknown as { note: Uint8Array }).note =
        new TextEncoder().encode("pay attention to nothing");
    }, "note");

  tamper("the escrow note renamed to another bracket's order id",
    (txns) => {
      const e = escrowOf(txns);
      // Well-formed marker, wrong order — passes the shape gate, so only the
      // exact binding to this bracket's child id can catch it.
      (e as unknown as { note: Uint8Array }).note =
        new TextEncoder().encode("pdex-v2-linked-escrow-999");
    }, "tp_escrow_missing");

  tamper("an app call switched off NoOp",
    (txns) => {
      const t = txns.find((x) => x.applicationCall)!;
      (t.applicationCall as unknown as { onComplete: number }).onComplete = 5; // DeleteApplication
    }, "on_complete");

  tamper("one leg given a longer validity window than the rest",
    (txns) => {
      (txns[0] as unknown as { lastValid: bigint }).lastValid = txns[0].lastValid + BigInt(50_000);
    }, "validity_window");

  tamper("a Math carrier given a different selector",
    (txns) => {
      const m = txns.find((t) => Number(t.applicationCall?.appIndex) === PEX_APPS.math)!;
      (m.applicationCall!.appArgs as Uint8Array[])[0] =
        Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
    }, "math_carrier_args");

  tamper("a Math carrier made to name an account",
    (txns) => {
      const m = txns.find((t) => Number(t.applicationCall?.appIndex) === PEX_APPS.math)!;
      (m.applicationCall as unknown as { accounts: unknown[] }).accounts =
        [algosdk.decodeAddress("7777777777777777777777777777777777777777777777777774MSJUVU")];
    }, "math_carrier_accounts");

  // ── The storage-funding shape (audit 5, F1) ──────────────────────────────
  //
  // Trading asserts the caller's `t2:` box exists, and the group only creates
  // it when a storage payment leads. Nineteen accounts on MainNet have that box
  // — so this eleven-transaction shape is what EVERY new user signs, and it had
  // no coverage at all. The nine-transaction shape was the exception being
  // tested as if it were the rule.
  for (const name of names) {
    const cc = groups[name];
    it(`${name}: accepts the real storage-funding group`, () => {
      const r = assertTp(decodeStorage(cc), shownOpenStorage(cc), shownTp(cc));
      expect(r.findings).toEqual([]);
      expect(r.ok).toBe(true);
    });

    it(`${name}: the storage-funding group is the shape we assert`, () => {
      const txns = decodeStorage(cc);
      expect(txns.map((t) => t.type)).toEqual([
        "pay", "appl", "axfer", "appl", "appl", "appl", "appl", "axfer", "pay", "appl", "appl",
      ]);
      expect(txns.reduce((a, t) => a + Number(t.fee), 0)).toBe(53_000);
      // Two Trading calls: fund_storage, then the open.
      expect(txns.filter((t) => Number(t.applicationCall?.appIndex) === PEX_APPS.trading)).toHaveLength(2);
    });
  }

  it("refuses a storage-funding group presented as a plain open", () => {
    // The screen says no storage payment; the group funds storage anyway.
    // Shape, payment count and the Trading call count must all object.
    const r = assertTp(decodeStorage(c), shownOpen(c), shownTp(c));
    expect(r.ok).toBe(false);
    const codes = r.findings.map((f) => f.code);
    expect(codes).toContain("pay_count");
  });

  it("refuses a plain open presented as storage-funding", () => {
    const r = assertTp(decode(c), shownOpenStorage(c), shownTp(c));
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("pay_count");
  });

  it("catches the storage payment redirected to an attacker", () => {
    const txns = decodeStorage(c);
    const tradingAddr = algosdk.getApplicationAddress(PEX_APPS.trading).toString();
    const pay = txns.find((t) => t.payment && String(t.payment.receiver) === tradingAddr)!;
    (pay.payment as unknown as { receiver: algosdk.Address }).receiver =
      algosdk.decodeAddress("7777777777777777777777777777777777777777777777777774MSJUVU");
    const r = assertTp(txns, shownOpenStorage(c), shownTp(c));
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("storage_payment_missing");
  });

  it("catches a storage payment the SCREEN also lies about", () => {
    // The tamper that passed: move the group AND the displayed value together,
    // so the equality check agrees and only an anchor outside the caller can
    // object. Every other value-moving leg had one; this one did not.
    const txns = decodeStorage(c);
    const tradingAddr = algosdk.getApplicationAddress(PEX_APPS.trading).toString();
    const pay = txns.find((t) => t.payment && String(t.payment.receiver) === tradingAddr)!;
    const inflated = BigInt(c.storagePaymentMicro) * BigInt(10);
    (pay.payment as unknown as { amount: bigint }).amount = inflated;
    const shown = shownOpenStorage(c);
    shown.storagePaymentMicro = inflated;
    const r = assertTp(txns, shown, shownTp(c));
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("storage_payment_unpinned");
  });

  it("accepts the 70,900 top-up amount a repeat trader pays", () => {
    // A trader whose box exists but whose escrow is spent pays the position-box
    // MBR, not the full first-trade escrow. Both are legitimate; the assertion
    // must accept exactly these two and nothing else.
    const txns = decodeStorage(c);
    const tradingAddr = algosdk.getApplicationAddress(PEX_APPS.trading).toString();
    const pay = txns.find((t) => t.payment && String(t.payment.receiver) === tradingAddr)!;
    (pay.payment as unknown as { amount: bigint }).amount = POSITION_BOX_MBR_MICRO_ALGO;
    const shown = shownOpenStorage(c);
    shown.storagePaymentMicro = POSITION_BOX_MBR_MICRO_ALGO;
    const r = assertTp(txns, shown, shownTp(c));
    expect(r.findings).toEqual([]);
  });

  it("catches the storage payment inflated beyond what was displayed", () => {
    const txns = decodeStorage(c);
    const tradingAddr = algosdk.getApplicationAddress(PEX_APPS.trading).toString();
    const pay = txns.find((t) => t.payment && String(t.payment.receiver) === tradingAddr)!;
    (pay.payment as unknown as { amount: bigint }).amount = BigInt(5_000_000);
    const r = assertTp(txns, shownOpenStorage(c), shownTp(c));
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("storage_payment_amount");
  });

  // ── B6, second half: the child payload is targeted at OrderOps ───────────
  //
  // A signed oracle message binds the app it may be presented to, at offset 37.
  // The entry presents to Trading, the attached child to OrderOps, and reusing
  // the Trading payload on the child is what failed at pc=6359. The assertion
  // used to compare the child's bytes against the OPEN leg's, so it enforced the
  // bug instead of catching it.
  const targetOf = (b64: string) => {
    const m = bytes(b64);
    return new DataView(m.buffer, m.byteOffset, m.byteLength).getBigUint64(37, false);
  };

  it("the captured entry payload is bound to Trading", () => {
    expect(targetOf(c.oracleMessage)).toBe(BigInt(PEX_APPS.trading));
  });

  it("the captured child payload is bound to OrderOps", () => {
    expect(targetOf(c.tpOracleMessage)).toBe(BigInt(PEX_APPS.orderOps));
    // And they are genuinely different payloads, not the same bytes twice.
    expect(c.tpOracleMessage).not.toBe(c.oracleMessage);
  });

  it("catches the child leg carrying the entry's payload", () => {
    // Exactly the B6 mistake. If the assertion ever goes back to comparing
    // against `shownOpen`, this passes and the test fails.
    const tp = shownTp(c);
    tp.oracleMessage = bytes(c.oracleMessage);
    tp.oracleSignature = bytes(c.oracleSignature);
    const r = assertTp(decode(c), shownOpen(c), tp);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("tp_oracle_message");
  });

  it("catches a displayed child payload bound to the wrong app", () => {
    // The group and the screen agree, and both are wrong — a consistent lie, so
    // only the target check read from the signed bytes can catch it.
    const txns = decode(c);
    const tp = shownTp(c);
    const wrong = bytes(c.oracleMessage); // Trading-targeted
    tp.oracleMessage = wrong;
    tp.oracleSignature = bytes(c.oracleSignature);
    const orderOps = txns.find((t) => Number(t.applicationCall?.appIndex) === PEX_APPS.orderOps)!;
    const args = orderOps.applicationCall!.appArgs as Uint8Array[];
    // Rewrite the packed tail's oracle message to the Trading payload so the
    // equality check passes and the target check is the thing under test.
    const tail = args[15];
    const idx = indexOfSub(tail, bytes(c.tpOracleMessage));
    expect(idx).toBeGreaterThan(-1);
    tail.set(wrong, idx);
    const r = assertTp(txns, shownOpen(c), tp);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("tp_oracle_target");
  });

  // ── Audit 4: fields that were on the transaction and never read ──────────

  tamper("a well-formed linked note on the WRONG leg",
    (txns) => {
      // Passes the regex; belongs on the escrow/MBR legs only. Used to pass.
      (txns[0] as unknown as { note: Uint8Array }).note =
        new TextEncoder().encode("pdex-v2-linked-escrow-999999999999");
    }, "note");

  tamper("a linked note on a Math carrier",
    (txns) => {
      const m = txns.find((t) => Number(t.applicationCall?.appIndex) === PEX_APPS.math)!;
      (m as unknown as { note: Uint8Array }).note =
        new TextEncoder().encode("pdex-v2-linked-storage-1");
    }, "note");

  tamper("an attacker address appended to the Trading call's accounts",
    (txns) => {
      const t = txns.find((x) => Number(x.applicationCall?.appIndex) === PEX_APPS.trading)!;
      const accts = t.applicationCall!.accounts as unknown[];
      accts.push(algosdk.decodeAddress("7777777777777777777777777777777777777777777777777774MSJUVU"));
    }, "foreign_account");

  tamper("an extra foreign asset on the Trading call",
    (txns) => {
      const t = txns.find((x) => Number(x.applicationCall?.appIndex) === PEX_APPS.trading)!;
      (t.applicationCall!.foreignAssets as unknown[]).push(BigInt(1_284_444_444));
    }, "foreign_asset");

  tamper("an unpinned foreign app on the OrderOps call",
    (txns) => {
      const t = txns.find((x) => Number(x.applicationCall?.appIndex) === PEX_APPS.orderOps)!;
      (t.applicationCall!.foreignApps as unknown[]).push(BigInt(123_456_789));
    }, "foreign_app");

  tamper("a lease set on the collateral leg",
    (txns) => {
      (txns[0] as unknown as { lease: Uint8Array }).lease = new Uint8Array(32).fill(7);
    }, "lease");

  tamper("one leg pointed at a different network",
    (txns) => {
      (txns[0] as unknown as { genesisHash: Uint8Array }).genesisHash = new Uint8Array(32).fill(1);
    }, "genesis_hash");

  tamper("fees inflated across the group",
    (txns) => { txns.forEach((t) => { (t as unknown as { fee: bigint }).fee = BigInt(30_000); }); },
    "fee_cap");
});

describe("attached legs are bound by identity, not by elimination", () => {
  // These are the tests the single-leg assertion could not have had. It found
  // the keeper-fee escrow with `transfers.find(t => amount !== collateral)` —
  // "the one that is not the collateral" — which is unambiguous only while
  // there is exactly one child. Each case below passes a leg whose identity
  // does NOT match the captured group, and the assertion has to notice.
  const c = groups[Object.keys(groups)[0]];

  it("refuses a leg that claims the wrong reserved slot", () => {
    // base+2 is the stop-loss slot. A take-profit sitting there is mislabelled,
    // and a mislabelled leg is a stop that behaves like a target.
    const tp = shownTp(c);
    const r = assertOpenWithAttachedOrders(decode(c), shownOpen(c), [{
      ...tp,
      orderKind: ORDER_KIND_TAKE_PROFIT,
      childOrderId: tp.baseOrderId + BigInt(2),
    }]);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("tp_slot");
  });

  it("refuses a leg whose escrow is not in the group", () => {
    // The locate-by-note check doing its job: this leg names a child id the
    // group carries no escrow for, so there is nothing to bind it to. Under
    // locate-by-elimination it would have silently adopted the take-profit's
    // escrow and passed every amount, receiver and asset check on it.
    const tp = shownTp(c);
    const r = assertOpenWithAttachedOrders(decode(c), shownOpen(c), [{
      ...tp,
      orderKind: ORDER_KIND_STOP_LOSS,
      childOrderId: tp.baseOrderId + BigInt(2),
    }]);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("sl_escrow_missing");
  });

  it("refuses two legs claiming the same slot", () => {
    // Both would bind to the same transfer, so each would "check" the other's
    // escrow and the group would look twice-verified while one leg was never
    // examined at all.
    const tp = shownTp(c);
    const leg = {
      ...tp, orderKind: ORDER_KIND_TAKE_PROFIT, childOrderId: tp.baseOrderId + BigInt(1),
    };
    const r = assertOpenWithAttachedOrders(decode(c), shownOpen(c), [leg, { ...leg }]);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("leg_slot_collision");
  });

  it("refuses a second leg the group does not carry", () => {
    // Declaring two legs against a one-leg group: the shape gate and the
    // submit count both have to catch this, or a user could be shown "stop loss
    // set" over a group that contains no stop loss.
    const tp = shownTp(c);
    const r = assertOpenWithAttachedOrders(decode(c), shownOpen(c), [
      { ...tp, orderKind: ORDER_KIND_TAKE_PROFIT, childOrderId: tp.baseOrderId + BigInt(1) },
      { ...tp, orderKind: ORDER_KIND_STOP_LOSS, childOrderId: tp.baseOrderId + BigInt(2) },
    ]);
    expect(r.ok).toBe(false);
  });

  it("still accepts the captured one-leg group", () => {
    // The control. Everything above must fail for its own reason, not because
    // the new code rejects a group that has always been correct.
    const tp = shownTp(c);
    const r = assertOpenWithAttachedOrders(decode(c), shownOpen(c), [{
      ...tp, orderKind: ORDER_KIND_TAKE_PROFIT, childOrderId: tp.baseOrderId + BigInt(1),
    }]);
    expect(r.findings.map((f) => f.code)).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
