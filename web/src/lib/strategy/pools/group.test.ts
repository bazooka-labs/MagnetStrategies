// The liquidity assertions, against real SDK groups.
//
// Groups here are real `buildV2DepositLiquidityTransactions` and
// `buildV2WithdrawLiquidityTransactions` output from MainNet — 6 transactions
// at 55,000 µALGO for a deposit, 10 at 117,000 for a withdrawal with both
// recall legs. Regenerate with
// `CAPTURE=1 npx vitest run src/lib/strategy/__fixtures__/capture.test.ts`.
//
// Every test below mutates a REAL group and asserts the check catches it. The
// reason for real bytes rather than literals is written out in
// __fixtures__/capture.test.ts: four separate mistakes in this path were invisible
// to a hand-built group.

import { beforeAll, describe, expect, it } from "vitest";
import algosdk from "algosdk";
import fixture from "../__fixtures__/groups.json";
import {
  assertDepositGroup, assertWithdrawGroup, receiptFromLogs, withTolerance,
  MAX_LIQUIDITY_GROUP_FEE_MICRO_ALGO, LIQUIDITY_SELECTORS,
  type DisplayedDeposit, type DisplayedWithdraw,
} from "./group";
import { PEX_APPS, PEX_ASSETS } from "@/lib/strategy/pex/config";
import { installProtocolManifest } from "@/lib/strategy/pex/manifest";

type CapturedMarket = {
  marketId: number; sender: string;
  deposit: {
    algoMicro: string; usdcMicro: string; minShares: string;
    storagePaymentMicro: string; txns: string[];
  };
  withdraw: {
    shareAmount: string; minAlgoMicro: string; minUsdcMicro: string;
    yieldRecallMode: string; maxLongReceipt: string; maxShortReceipt: string;
    recall: { accounts: string[]; assets: number[]; apps: number[] };
    txns: string[];
  };
  oracleMessageB64: string; oracleSignatureB64: string;
};

const markets = (fixture as { groups: Record<string, CapturedMarket> }).groups;
const names = Object.keys(markets);
const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));
const decode = (txns: string[]) => txns.map((t) => algosdk.decodeUnsignedTransaction(bytes(t)));

/** An address that is not the user, not the builder and not a PEX app. */
const ATTACKER = "7777777777777777777777777777777777777777777777777774MSJUVU";

const depositShown = (m: CapturedMarket): DisplayedDeposit => ({
  sender: m.sender,
  marketId: m.marketId,
  algoMicro: BigInt(m.deposit.algoMicro),
  usdcMicro: BigInt(m.deposit.usdcMicro),
  minShares: BigInt(m.deposit.minShares),
  storagePaymentMicro: BigInt(m.deposit.storagePaymentMicro),
  oracleMessage: bytes(m.oracleMessageB64),
  oracleSignature: bytes(m.oracleSignatureB64),
});

const withdrawShown = (m: CapturedMarket): DisplayedWithdraw => ({
  sender: m.sender,
  marketId: m.marketId,
  shareAmount: BigInt(m.withdraw.shareAmount),
  minAlgoMicro: BigInt(m.withdraw.minAlgoMicro),
  minUsdcMicro: BigInt(m.withdraw.minUsdcMicro),
  yieldRecallMode: BigInt(m.withdraw.yieldRecallMode),
  maxLongReceipt: BigInt(m.withdraw.maxLongReceipt),
  maxShortReceipt: BigInt(m.withdraw.maxShortReceipt),
  oracleMessage: bytes(m.oracleMessageB64),
  oracleSignature: bytes(m.oracleSignatureB64),
  recall: m.withdraw.recall,
});

it("has a fixture for both markets", () => {
  expect(names).toEqual(["m1", "m2"]);
});

describe.each(names)("%s: real deposit group", (name) => {
  const m = markets[name];
  const group = () => decode(m.deposit.txns);

  it("passes unmodified", () => {
    const r = assertDepositGroup(group(), depositShown(m));
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
    // Not a vacuous pass: the checks actually ran.
    expect(r.checked.length).toBeGreaterThanOrEqual(6);
  });

  it("is the shape we measured", () => {
    const g = group();
    expect(g.length).toBe(6);
    expect(g.map((t) => t.type)).toEqual(["pay", "axfer", "pay", "appl", "appl", "appl"]);
    expect(g.reduce((a, t) => a + Number(t.fee), 0)).toBe(55_000);
  });

  it("catches an inflated ALGO leg", () => {
    const g = group();
    const leg = g.find((t) => t.type === "pay" && Number(t.payment!.amount) > 0)!;
    (leg.payment as unknown as { amount: bigint }).amount = BigInt(m.deposit.algoMicro) * BigInt(10);
    const r = assertDepositGroup(g, depositShown(m));
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("algo_leg");
  });

  it("catches an inflated USDC leg", () => {
    const g = group();
    const leg = g.find((t) => t.type === "axfer")!;
    (leg.assetTransfer as unknown as { amount: bigint }).amount = BigInt(m.deposit.usdcMicro) * BigInt(10);
    const r = assertDepositGroup(g, depositShown(m));
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("usdc_amount");
  });

  it("catches a funding leg redirected away from the pool", () => {
    const g = group();
    (g.find((t) => t.type === "axfer")!.assetTransfer as unknown as
      { receiver: algosdk.Address }).receiver = algosdk.decodeAddress(ATTACKER);
    const r = assertDepositGroup(g, depositShown(m));
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("usdc_receiver");
  });

  it("catches a storage payment smuggled in behind a zero display", () => {
    // The open path's 50-ALGO escape, on this flow: a payment the UI showed as
    // zero, moving real ALGO into PEX.
    const g = group();
    const zero = g.filter((t) => t.type === "pay").find((t) => Number(t.payment!.amount) === 0)!;
    (zero.payment as unknown as { amount: bigint }).amount = BigInt(50_000_000);
    const r = assertDepositGroup(g, depositShown(m));
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("storage_leg");
  });

  it("catches a lowered share floor", () => {
    // Lowering the floor leaves the deposit valid but removes the user's only
    // protection against receiving fewer shares than they accepted.
    const g = group();
    const call = g.find((t) => Number(t.applicationCall?.appIndex) === PEX_APPS.adminOps)!;
    (call.applicationCall!.appArgs as Uint8Array[])[2] = algosdk.encodeUint64(BigInt(1));
    const r = assertDepositGroup(g, depositShown(m));
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("min_shares");
  });

  it("catches a redirected market", () => {
    const g = group();
    const call = g.find((t) => Number(t.applicationCall?.appIndex) === PEX_APPS.adminOps)!;
    (call.applicationCall!.appArgs as Uint8Array[])[1] = algosdk.encodeUint64(BigInt(9));
    const r = assertDepositGroup(g, depositShown(m));
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("market_id");
  });

  it("catches a substituted oracle price", () => {
    const g = group();
    const call = g.find((t) => Number(t.applicationCall?.appIndex) === PEX_APPS.adminOps)!;
    const msg = call.applicationCall!.appArgs[3];
    const tampered = Uint8Array.from(msg);
    tampered[tampered.length - 1] ^= 0xff;
    (call.applicationCall!.appArgs as Uint8Array[])[3] = tampered;
    const r = assertDepositGroup(g, depositShown(m));
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("oracle_message");
  });

  it("catches a rekey", () => {
    const g = group();
    (g[0] as unknown as { rekeyTo: algosdk.Address }).rekeyTo = algosdk.decodeAddress(ATTACKER);
    const r = assertDepositGroup(g, depositShown(m));
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("rekey");
  });

  it("catches a close-remainder sweep", () => {
    const g = group();
    (g.find((t) => t.type === "pay")!.payment as unknown as
      { closeRemainderTo: algosdk.Address }).closeRemainderTo = algosdk.decodeAddress(ATTACKER);
    const r = assertDepositGroup(g, depositShown(m));
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("close_remainder_to");
  });

  it("catches an extra call to an app this flow never uses", () => {
    // Trading is pinned and callable on the TRADE path. It is not callable
    // here, which is the point of a separate budget.
    const g = group();
    const call = g.find((t) => Number(t.applicationCall?.appIndex) === PEX_APPS.adminOps)!;
    (call.applicationCall as unknown as { appIndex: bigint }).appIndex = BigInt(PEX_APPS.trading);
    const r = assertDepositGroup(g, depositShown(m));
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("unpinned_app");
  });

  it("catches a fee drain within an otherwise valid group", () => {
    const g = group();
    (g[0] as unknown as { fee: bigint }).fee = BigInt(MAX_LIQUIDITY_GROUP_FEE_MICRO_ALGO) + BigInt(1);
    const r = assertDepositGroup(g, depositShown(m));
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("fee_cap");
  });

  it("catches a foreign sender", () => {
    const r = assertDepositGroup(group(), { ...depositShown(m), sender: ATTACKER });
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("foreign_sender");
  });
});

describe.each(names)("%s: real withdraw group", (name) => {
  const m = markets[name];
  const group = () => decode(m.withdraw.txns);

  it("passes unmodified, with the recall set supplied", () => {
    const r = assertWithdrawGroup(group(), withdrawShown(m));
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("is the shape we measured", () => {
    const g = group();
    expect(g.length).toBe(10);
    // No pay and no axfer: both sides arrive by inner transfer, so any outbound
    // leg here would be money moving the wrong way.
    expect(new Set(g.map((t) => t.type))).toEqual(new Set(["appl"]));
    expect(g.reduce((a, t) => a + Number(t.fee), 0)).toBe(117_000);
  });

  it("refuses the whole group when the recall set is withheld", () => {
    // Not a nicety: without the registry's own enumeration the assertion
    // refuses every correct withdrawal. This test exists so that is a
    // documented property rather than a surprise during an incident.
    const r = assertWithdrawGroup(group(), {
      ...withdrawShown(m), recall: { accounts: [], assets: [], apps: [] },
    });
    expect(r.ok).toBe(false);
    const codes = new Set(r.findings.map((f) => f.code));
    expect(codes.has("foreign_account") || codes.has("foreign_app") || codes.has("foreign_asset"))
      .toBe(true);
  });

  it("catches an inflated share burn", () => {
    const g = group();
    const call = g.find((t) => Number(t.applicationCall?.appIndex) === PEX_APPS.adminOps)!;
    (call.applicationCall!.appArgs as Uint8Array[])[2] = algosdk.encodeUint64(BigInt(m.withdraw.shareAmount) * BigInt(5));
    const r = assertWithdrawGroup(g, withdrawShown(m));
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("share_amount");
  });

  it("catches lowered payout floors", () => {
    const g = group();
    const call = g.find((t) => Number(t.applicationCall?.appIndex) === PEX_APPS.adminOps)!;
    (call.applicationCall!.appArgs as Uint8Array[])[3] = algosdk.encodeUint64(BigInt(0));
    (call.applicationCall!.appArgs as Uint8Array[])[4] = algosdk.encodeUint64(BigInt(0));
    const r = assertWithdrawGroup(g, withdrawShown(m));
    expect(r.ok).toBe(false);
    const codes = r.findings.map((f) => f.code);
    expect(codes).toContain("min_algo");
    expect(codes).toContain("min_usdc");
  });

  it("catches a widened recall cap", () => {
    // The caps bound how much the pool is asked to pull back out of yield.
    const g = group();
    const call = g.find((t) => Number(t.applicationCall?.appIndex) === PEX_APPS.adminOps)!;
    (call.applicationCall!.appArgs as Uint8Array[])[8] = algosdk.encodeUint64(BigInt("18446744073709551615"));
    const r = assertWithdrawGroup(g, withdrawShown(m));
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("max_long_receipt");
  });

  it("catches a changed recall mode", () => {
    const g = group();
    const call = g.find((t) => Number(t.applicationCall?.appIndex) === PEX_APPS.adminOps)!;
    (call.applicationCall!.appArgs as Uint8Array[])[7] = algosdk.encodeUint64(BigInt(0));
    const r = assertWithdrawGroup(g, withdrawShown(m));
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("yield_recall_mode");
  });

  it("catches an outbound payment added to an exit", () => {
    const g = group();
    const sp = { fee: 1000, firstValid: g[0].firstValid, lastValid: g[0].lastValid,
      genesisHash: g[0].genesisHash, genesisID: g[0].genesisID, minFee: 1000 };
    g.push(algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: m.sender, receiver: ATTACKER, amount: 1_000_000,
      suggestedParams: sp as unknown as algosdk.SuggestedParams,
    }));
    const r = assertWithdrawGroup(g, withdrawShown(m));
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("pay_count");
  });

  it("catches the selector being swapped for the deposit method", () => {
    const g = group();
    const call = g.find((t) => Number(t.applicationCall?.appIndex) === PEX_APPS.adminOps)!;
    (call.applicationCall!.appArgs as Uint8Array[])[0] =
      Uint8Array.from(Buffer.from(LIQUIDITY_SELECTORS.depositLiquidity, "hex"));
    const r = assertWithdrawGroup(g, withdrawShown(m));
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("withdraw_selector");
  });

  it("catches a substituted oracle signature", () => {
    const g = group();
    const call = g.find((t) => Number(t.applicationCall?.appIndex) === PEX_APPS.adminOps)!;
    const sig = Uint8Array.from(call.applicationCall!.appArgs[6]);
    sig[sig.length - 1] ^= 0xff;
    (call.applicationCall!.appArgs as Uint8Array[])[6] = sig;
    const r = assertWithdrawGroup(g, withdrawShown(m));
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("oracle_signature");
  });
});

describe("the receipt is what the figures come from", () => {
  // `decodeReceipt` resolves field NAMES out of the protocol manifest, so it
  // needs the manifest installed. Production installs it at the top of both
  // builders; without it the receipt decodes to a different event type and
  // `receiptFromLogs` correctly returns null rather than guessing.
  beforeAll(async () => { await installProtocolManifest(); });

  // The exact bytes MainNet logged for a 0.5 ALGO + 0.5 USDC deposit into
  // market 1, captured 2026-10-21.
  const DEPOSIT_LOG = "151f7c75"
    + "0050" // byte[] length 80
    + "0000000000000001" // event version
    + "0000000000000078" // event type id
    + "0000000000003900" // flags
    + "0000000000000001" // market_id
    + "000000000007a120" // long_amount 500000
    + "000000000007a120" // short_amount 500000
    + "0000000000076507" // shares_minted 484615
    + "0000000155e18231" // long_pool_amount_after
    + "00000000745d8d65" // short_pool_amount_after
    + "000000008c3319d5"; // market_share_supply_after

  it("decodes the contract's own field names", () => {
    const r = receiptFromLogs([Uint8Array.from(Buffer.from(DEPOSIT_LOG, "hex"))], "v2_lp_deposited");
    expect(r).not.toBeNull();
    expect(r!.fields.shares_minted).toBe(BigInt(484_615));
    expect(r!.fields.market_id).toBe(BigInt(1));
    expect(r!.fields.long_amount).toBe(BigInt(500_000));
  });

  it("returns null for a different event rather than the wrong numbers", () => {
    const r = receiptFromLogs([Uint8Array.from(Buffer.from(DEPOSIT_LOG, "hex"))], "v2_lp_withdrawn");
    expect(r).toBeNull();
  });

  it("returns null on logs that carry no receipt", () => {
    expect(receiptFromLogs([], "v2_lp_deposited")).toBeNull();
    expect(receiptFromLogs(undefined, "v2_lp_deposited")).toBeNull();
    expect(receiptFromLogs([new Uint8Array([1, 2, 3])], "v2_lp_deposited")).toBeNull();
  });

  it("applies tolerance downward and never above the figure", () => {
    expect(withTolerance(BigInt(1_000_000), 100)).toBe(BigInt(990_000));
    expect(withTolerance(BigInt(1_000_000), 0)).toBe(BigInt(1_000_000));
    // A negative or absurd tolerance must not produce a floor ABOVE the
    // quantity, which would make the group unsatisfiable.
    expect(withTolerance(BigInt(1_000_000), -500)).toBe(BigInt(1_000_000));
    expect(withTolerance(BigInt(1_000_000), 99_999)).toBe(BigInt(0));
  });

  it("the measured SDK bias is larger than the default tolerance", () => {
    // This is the whole reason the receipt is the source of truth. If the SDK
    // ever becomes accurate this test fails and the comments can be revisited.
    const quoted = 492_506, actual = 484_527; // measured on MainNet, 2026-10-21
    expect(quoted / actual - 1).toBeGreaterThan(0.01);
  });
});

it("pins the selectors against the vendored manifest's own hashes", () => {
  // Each of these was verified against
  // `apps/PDexV2{AdminOps,CvaVault,Math}/method_specs/*/signature`.
  expect(LIQUIDITY_SELECTORS).toEqual({
    depositLiquidity: "115498d8",
    withdrawLiquidity: "cc72508e",
    // The all-USDC path: one call that swaps the ALGO leg inside the pool.
    withdrawLiquidityWithSwap: "0729c57a",
    cvaDeposit: "b2eea014",
    cvaMarkMarket: "7eda6c29",
    mathNoop: "e83a87ab",
  });
  expect(PEX_ASSETS.usdc).toBe(31566704);
});
