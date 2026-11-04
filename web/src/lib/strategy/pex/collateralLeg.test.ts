// How the open assertion FINDS the collateral leg, against real SDK groups.
//
// ── Why this is its own file ─────────────────────────────────────────────────
// The leg used to be located as `txns.filter((t) => t.assetTransfer)[0]` — the
// first asset transfer in the group. That is not an identity, it is a guess
// that happened to hold while collateral was always USDC and always the only
// axfer.
//
// It fails in two directions:
//
//   - ALGO collateral is a PAYMENT, not an axfer (`makeTokenTransferTxn`
//     returns `makePaymentTxnWithSuggestedParamsFromObject` when the asset id
//     is 0). There is then no axfer to find, `if (xfer)` is skipped, and with
//     it the asset, amount, receiver and LEVERAGE checks — the last being the
//     only thing binding `sizeUsdDelta`, which is a free frontend integer.
//   - With protection on, the keeper-fee escrow IS an axfer, so `[0]` can
//     select the escrow and validate it against the displayed collateral.
//
// This is the same defect the file header of `groupReal.test.ts` describes for
// the escrow leg: "located the keeper-fee escrow by elimination, which breaks
// the moment a group carries two legs". That one was fixed; the collateral leg
// kept it.
//
// The leg is now anchored at `openIdx - 1`, relative to the `open_or_increase`
// call located by PINNED SELECTOR. Spec: strategy/perps/ALGO_COLLATERAL_SPEC.md §4.
//
// Groups are real `@pdex/sdk` output captured from MainNet, decoded back into
// genuine algosdk Transactions.

import { describe, expect, it } from "vitest";
import algosdk from "algosdk";
import fixture from "./__fixtures__/perpsGroups.json";
import {
  assertOpenWithAttachedOrders, ORDER_KIND_TAKE_PROFIT,
  type DisplayedOpen, type DisplayedTakeProfit,
} from "@/lib/strategy/pex/group";
import { COLLATERAL_ASSET_ID } from "@/lib/strategy/pex/config";

type Captured = Record<string, string | number | string[]>;
const groups = fixture.groups as unknown as Record<string, Captured>;
const c = Object.values(groups)[0];

const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));
const decode = (txns: string[]) =>
  txns.map((t) => algosdk.decodeUnsignedTransaction(Buffer.from(t, "base64")));

const shownOpen = (storage = false): DisplayedOpen => ({
  storagePaymentMicro: storage ? BigInt(c.storagePaymentMicro as string) : BigInt(0),
  sender: c.sender as string,
  marketId: c.marketId as number,
  side: c.side === "long" ? 1 : 2,
  collateralAssetId: COLLATERAL_ASSET_ID,
  collateralAmountMicro: BigInt(c.collateralAmountMicro as string),
  sizeUsdDeltaMicro: BigInt(c.sizeUsdDeltaMicro as string),
  /**
   * What a card would have shown for this group.
   *
   * Derived from the fixture's own size and collateral, NOT from the price the
   * assertion prices with — so the two arrive by different routes and a unit
   * error in the assertion makes them disagree. For USDC the signed short
   * price sits about 2 bps off par, far inside the 150 bp budget.
   */
  asRenderedLeverage: Number(c.sizeUsdDeltaMicro) / Number(c.collateralAmountMicro),
  acceptablePrice12: BigInt(c.acceptablePrice12 as string),
  executionPrice12: BigInt(c.executionPrice12 as string),
  indexPrice12: BigInt(c.indexPrice12 as string),
  slippageBps: c.slippageBps as number,
  oracleMessage: bytes(c.oracleMessage as string),
  oracleSignature: bytes(c.oracleSignature as string),
});

const shownTp = (): DisplayedTakeProfit => ({
  triggerPrice12: BigInt(c.tpTriggerPrice12 as string),
  acceptablePrice12: BigInt(c.tpAcceptablePrice12 as string),
  sizeUsdDeltaMicro: BigInt(c.sizeUsdDeltaMicro as string),
  keeperFeeMicro: BigInt(c.tpKeeperFeeMicro as string),
  baseOrderId: BigInt(c.baseOrderId as string),
  slippageBps: c.slippageBps as number,
  oracleMessage: bytes(c.tpOracleMessage as string),
  oracleSignature: bytes(c.tpOracleSignature as string),
});

const run = (txns: algosdk.Transaction[], storage = false) =>
  assertOpenWithAttachedOrders(txns, shownOpen(storage), [{
    ...shownTp(),
    orderKind: ORDER_KIND_TAKE_PROFIT,
    childOrderId: BigInt(c.baseOrderId as string) + BigInt(1),
  }]);

const codes = (r: ReturnType<typeof run>) => r.findings.map((f) => f.code);
const collateralMicro = BigInt(c.collateralAmountMicro as string);

/** The collateral leg in a real group: the axfer whose amount is the collateral. */
const collateralIdx = (txns: algosdk.Transaction[]) =>
  txns.findIndex((t) => t.assetTransfer?.amount === collateralMicro);
/** The keeper-fee escrow: the OTHER axfer. */
const escrowIdx = (txns: algosdk.Transaction[]) =>
  txns.findIndex((t) => t.assetTransfer && t.assetTransfer.amount !== collateralMicro);

describe("the collateral leg is found by position, not by type", () => {
  it("passes on the real captured group", () => {
    expect(run(decode(c.txns as string[])).ok).toBe(true);
  });

  it("passes on the real STORAGE variant, which carries an extra payment", () => {
    // The storage group emits an un-noted payment to the same trading address
    // as the collateral. Locating by "pays the trading app" would be ambiguous
    // here; locating by openIdx - 1 is not.
    expect(run(decode(c.storageTxns as string[]), true).ok).toBe(true);
  });
});

describe("tampering the group cannot move the check onto another leg", () => {
  it("catches the keeper escrow standing in for the collateral", () => {
    /**
     * Honest note: the OLD rule caught this one too, by luck of ordering —
     * swapping the axfers also moves the escrow to the earlier index, so
     * `filter(assetTransfer)[0]` picked it and the amount mismatched.
     *
     * It is kept because the behaviour is worth pinning either way, not
     * because it distinguishes the fix. The tests that do that are the
     * storage-payment swap below and the ALGO case, both of which go red when
     * the old rule is restored.
     */
    const txns = decode(c.txns as string[]);
    const ci = collateralIdx(txns), ei = escrowIdx(txns);
    expect(ci).toBeGreaterThan(-1);
    expect(ei).toBeGreaterThan(-1);
    [txns[ci], txns[ei]] = [txns[ei], txns[ci]];
    const r = run(txns);
    expect(r.ok).toBe(false);
    expect(codes(r).join(",")).toMatch(/transfer_amount|collateral_leg|note|transfer_asset/);
  });

  it("catches the storage payment standing in for the collateral", () => {
    /**
     * Why the first proposed fix — "the leg paying the trading app that is not
     * the escrow" — was discarded. In the storage variant that description
     * matches two transactions.
     */
    const txns = decode(c.storageTxns as string[]);
    const ci = collateralIdx(txns);
    const pi = txns.findIndex((t) => t.payment
      && t.payment.amount === BigInt(c.storagePaymentMicro as string));
    expect(ci).toBeGreaterThan(-1);
    expect(pi).toBeGreaterThan(-1);
    [txns[ci], txns[pi]] = [txns[pi], txns[ci]];
    const r = run(txns, true);
    expect(r.ok).toBe(false);
  });

  it("catches the collateral leg being removed entirely", () => {
    const txns = decode(c.txns as string[]);
    txns.splice(collateralIdx(txns), 1);
    expect(run(txns).ok).toBe(false);
  });
});

describe("ALGO collateral", () => {
  it("is REFUSED rather than waved through unchecked", () => {
    /**
     * PEX accepts ALGO collateral today — 210.87 ALGO is posted on market 1.
     * Our UI does not offer it, and the leverage check below divides
     * `sizeUsdDelta` by the raw transfer amount, which is a leverage only
     * because µUSDC equals µUSD. Against µALGO it is wrong by the ALGO price,
     * roughly 10.7x at $0.0935.
     *
     * So until the feature lands with the USD conversion, an ALGO leg must
     * FAIL here rather than pass an unverifiable ratio.
     *
     * Worth being precise about what the old rule did here, because it is the
     * sharpest version of the danger. With an ALGO payment as collateral the
     * only axfer left is the keeper escrow, so `filter(assetTransfer)[0]`
     * selected the ESCROW and validated it against the displayed collateral.
     * It failed — but only because the escrow's amount happened to differ.
     * Had the keeper fee equalled the collateral, an ALGO group would have
     * passed every check while nothing about the actual money was examined.
     */
    const txns = decode(c.txns as string[]);
    const ci = collateralIdx(txns);
    const orig = txns[ci];
    txns[ci] = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: orig.sender,
      receiver: orig.assetTransfer!.receiver,
      amount: collateralMicro,
      suggestedParams: {
        fee: orig.fee, firstValid: orig.firstValid, lastValid: orig.lastValid,
        genesisHash: orig.genesisHash, genesisID: orig.genesisID, flatFee: true,
        minFee: BigInt(1000),
      },
    });
    const r = run(txns);
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("collateral_asset_unsupported");
  });
});
