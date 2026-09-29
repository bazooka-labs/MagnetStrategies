// Perps — the close assertion, against real SDK groups.
//
// `assertCloseGroup` had no real-bytes coverage: it was exercised only by
// hand-built object literals in perpsGroup.test.ts. That is the weakness the
// open path had before __fixtures__ existed, and it is the same shape as the B1
// escape — a harness asserting against what I believed the SDK produces rather
// than what it produces.
//
// Groups here are real `buildV2DecreaseOrCloseTransactions` output from MainNet:
// 3 transactions, all `appl` (Trading with 16 args plus two Math carriers),
// 40,000 microALGO. Regenerate with
// `CAPTURE=1 npx vitest run src/lib/__fixtures__/capture.test.ts`.
//
// Note the fixture's own caveats (see capture.test.ts): `yieldRecallMode` is
// supplied rather than obtained from Ultrade's recall-plan API, and the
// execution price is stood in by the index because a real close quote needs a
// live position. Neither affects what these tests check, which is field binding.

import { describe, expect, it } from "vitest";
import algosdk from "algosdk";
import fixture from "./__fixtures__/perpsGroups.json";
import { assertCloseGroup, POSITION_ID_WILDCARD, type DisplayedClose } from "./perpsGroup";
import { COLLATERAL_ASSET_ID, PEX_APPS } from "./perps";

type Captured = {
  marketId: number; side: "long" | "short"; sender: string;
  sizeUsdDeltaMicro: string; positionSizeUsdMicro: string; fullClose: boolean;
  acceptablePrice12: string; executionPrice12: string; indexPrice12: string;
  slippageBps: number; expectedPositionId: string;
  oracleMessage: string; oracleSignature: string;
  yieldRecallMode: string; maxLongReceiptAmount: string;
    maxShortReceiptAmount: string;
  txns: string[];
};

const groups = (fixture as { closeGroups: Record<string, Captured> }).closeGroups;
const names = Object.keys(groups);
const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));
const ATTACKER = "7777777777777777777777777777777777777777777777777774MSJUVU";

/** Fresh objects per call, so a mutation cannot leak between tests. */
const decode = (c: Captured) =>
  c.txns.map((t) => algosdk.decodeUnsignedTransaction(bytes(t)));

const shown = (c: Captured): DisplayedClose => ({
  sender: c.sender, marketId: c.marketId, side: c.side === "long" ? 1 : 2,
  collateralAssetId: COLLATERAL_ASSET_ID,
  sizeUsdDeltaMicro: BigInt(c.sizeUsdDeltaMicro),
  positionSizeUsdMicro: BigInt(c.positionSizeUsdMicro),
  fullClose: c.fullClose,
  acceptablePrice12: BigInt(c.acceptablePrice12),
  executionPrice12: BigInt(c.executionPrice12),
  indexPrice12: BigInt(c.indexPrice12),
  slippageBps: c.slippageBps,
  expectedPositionId: BigInt(c.expectedPositionId),
  oracleMessage: bytes(c.oracleMessage), oracleSignature: bytes(c.oracleSignature),
  yieldRecallMode: BigInt(c.yieldRecallMode),
  maxLongReceiptAmount: BigInt(c.maxLongReceiptAmount),
  recall: { accounts: [], assets: [], apps: [] },
    maxShortReceiptAmount: BigInt(c.maxShortReceiptAmount),
});

describe("assertCloseGroup — against real SDK bytes", () => {
  it("has fixtures for both markets and both sides", () => {
    expect(names.sort()).toEqual(["m1_long", "m1_short", "m2_long", "m2_short"]);
  });

  for (const name of names) {
    const c = groups[name];

    it(`${name}: accepts the real group unmodified`, () => {
      const r = assertCloseGroup(decode(c), shown(c));
      expect(r.findings).toEqual([]);
      expect(r.ok).toBe(true);
    });

    it(`${name}: the real group is the shape we assert`, () => {
      // A close moves no value in the group itself — SHAPE_CLOSE is {0,0,1..10}.
      const txns = decode(c);
      expect(txns.map((t) => t.type)).toEqual(["appl", "appl", "appl"]);
      expect(txns.some((t) => t.assetTransfer || t.payment)).toBe(false);
      expect(txns.reduce((a, t) => a + Number(t.fee), 0)).toBe(40_000);
    });
  }

  // ── Tampers. Each must be named by its OWN finding code. ──────────────────
  const c = groups[names[0]];
  const tamper = (
    label: string,
    mutate: (txns: algosdk.Transaction[]) => void,
    code: string,
    alsoShown?: (d: DisplayedClose) => void,
  ) => it(`catches: ${label}`, () => {
    const txns = decode(c);
    mutate(txns);
    const d = shown(c);
    alsoShown?.(d);
    const r = assertCloseGroup(txns, d);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain(code);
  });

  const trading = (txns: algosdk.Transaction[]) =>
    txns.find((t) => Number(t.applicationCall?.appIndex) === PEX_APPS.trading)!;
  const setArg = (txns: algosdk.Transaction[], i: number, v: bigint) => {
    (trading(txns).applicationCall!.appArgs as Uint8Array[])[i] = algosdk.encodeUint64(v);
  };

  // The one that matters most: a wildcard closes whatever occupies the key,
  // which after a re-open is a DIFFERENT position than the one displayed.
  tamper("expectedPositionId switched to the wildcard",
    (txns) => {
      const args = trading(txns).applicationCall!.appArgs as Uint8Array[];
      const idx = args.findIndex((a) =>
        a.length === 8 && algosdk.decodeUint64(a, "bigint") === BigInt(c.expectedPositionId));
      expect(idx).toBeGreaterThan(0);
      args[idx] = algosdk.encodeUint64(POSITION_ID_WILDCARD);
    }, "position_id_wildcard");

  tamper("a leg sent by someone other than the user",
    (txns) => {
      (txns[0] as unknown as { sender: algosdk.Address }).sender = algosdk.decodeAddress(ATTACKER);
    }, "foreign_sender");

  tamper("rekeyTo set on a leg",
    (txns) => {
      (txns[0] as unknown as { rekeyTo: algosdk.Address }).rekeyTo = algosdk.decodeAddress(ATTACKER);
    }, "rekey");

  // A close carries no value legs at all, so any transfer is an addition.
  tamper("an asset transfer injected into a close",
    (txns) => {
      const t = txns[0];
      txns.push(algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: c.sender, receiver: ATTACKER, amount: 1_000_000,
        assetIndex: COLLATERAL_ASSET_ID,
        suggestedParams: {
          fee: t.fee, minFee: BigInt(1000), firstValid: t.firstValid,
          lastValid: t.lastValid, genesisHash: t.genesisHash, genesisID: t.genesisID,
        } as algosdk.SuggestedParams,
      }));
    }, "axfer_count");

  tamper("a payment injected into a close",
    (txns) => {
      const t = txns[0];
      txns.push(algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: c.sender, receiver: ATTACKER, amount: 500_000,
        suggestedParams: {
          fee: t.fee, minFee: BigInt(1000), firstValid: t.firstValid,
          lastValid: t.lastValid, genesisHash: t.genesisHash, genesisID: t.genesisID,
        } as algosdk.SuggestedParams,
      }));
    }, "pay_count");

  tamper("an asset-config transaction injected into a close",
    (txns) => {
      const t = txns[0];
      txns.push(algosdk.makeAssetConfigTxnWithSuggestedParamsFromObject({
        sender: c.sender, assetIndex: 12345678,
        manager: ATTACKER, reserve: ATTACKER, freeze: ATTACKER, clawback: ATTACKER,
        strictEmptyAddressChecking: false,
        suggestedParams: {
          fee: t.fee, minFee: BigInt(1000), firstValid: t.firstValid,
          lastValid: t.lastValid, genesisHash: t.genesisHash, genesisID: t.genesisID,
        } as algosdk.SuggestedParams,
      }));
    }, "txn_type");

  tamper("size inflated beyond what was displayed",
    (txns) => {
      const args = trading(txns).applicationCall!.appArgs as Uint8Array[];
      const idx = args.findIndex((a) =>
        a.length === 8 && algosdk.decodeUint64(a, "bigint") === BigInt(c.sizeUsdDeltaMicro));
      expect(idx).toBeGreaterThan(0);
      args[idx] = algosdk.encodeUint64(BigInt(c.sizeUsdDeltaMicro) * BigInt(5));
    }, "size_usd_delta");

  tamper("the oracle message replaced",
    (txns) => {
      const args = trading(txns).applicationCall!.appArgs as Uint8Array[];
      const idx = args.findIndex((a) => a.length === 2 + 133);
      expect(idx).toBeGreaterThan(0);
      const body = new Uint8Array(133).fill(1);
      const out = new Uint8Array(135);
      out[0] = 0; out[1] = 133; out.set(body, 2);
      args[idx] = out;
    }, "oracle_message");

  tamper("a note smuggled onto a close leg",
    (txns) => {
      (txns[0] as unknown as { note: Uint8Array }).note =
        new TextEncoder().encode("pdex-v2-linked-escrow-2");
    }, "note");

  tamper("a lease set on a close leg",
    (txns) => { (txns[0] as unknown as { lease: Uint8Array }).lease = new Uint8Array(32).fill(3); },
    "lease");

  tamper("an attacker address appended to the Trading call's accounts",
    (txns) => {
      (trading(txns).applicationCall!.accounts as unknown[]).push(algosdk.decodeAddress(ATTACKER));
    }, "foreign_account");

  // 45,000 each used to clear the old 120,000 ceiling. The close cap is now
  // MAX_CLOSE_GROUP_FEE_MICRO_ALGO (200,000), raised because a real recall
  // group measures 120,000 — so the tamper has to clear the NEW bound or it is
  // testing nothing. This is the failure mode where a cap is loosened and a
  // test quietly stops covering it.
  tamper("fees inflated across the group",
    (txns) => { txns.forEach((t) => { (t as unknown as { fee: bigint }).fee = BigInt(80_000); }); },
    "fee_cap");

  tamper("duplicate transaction ids",
    (txns) => { const id = txns[0].txID(); txns[2].txID = () => id; },
    "duplicate_txids");

  void setArg;
});
