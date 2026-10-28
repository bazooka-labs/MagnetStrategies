/**
 * The C-Vault assertions, against real SDK groups.
 *
 * The vault is the pool going in front of users first and it had no real-bytes
 * coverage, while the market pools had 55 mutation tests. This closes that.
 *
 * Groups here are real MainNet output: 8 transactions for a deposit (74,000
 * µALGO) and 15 for a market withdrawal (178,000). Regenerate with
 * `CAPTURE=1 npx vitest run src/lib/strategy/__fixtures__/captureCva.test.ts`.
 *
 * ── The mark preamble is this flow's distinctive attack surface ──
 * A deposit's 8 transactions begin with FOUR app calls before any money moves.
 * Two are `mark_market`, and each one writes the NAV the action is then priced
 * against. They move no funds, so a reviewer skims them — but adding, removing
 * or re-pointing one changes the price the user gets while every amount in the
 * group still matches what was displayed. That is the tamper the pools have no
 * equivalent of, and it is tested first.
 */
import { beforeAll, describe, expect, it } from "vitest";
import algosdk from "algosdk";
import fixture from "../__fixtures__/cvaGroups.json";
import {
  assertCvaDepositGroup, assertCvaWithdrawGroup, CVA_SELECTORS,
  MAX_CVA_GROUP_FEE_MICRO_ALGO, CVA_USER_BOX_MBR_MICRO_ALGO,
  type DisplayedCvaDeposit, type DisplayedCvaWithdraw,
} from "./cvaGroup";
import { installProtocolManifest } from "@/lib/strategy/pex/manifest";
import { PEX_APPS, PEX_ASSETS } from "@/lib/strategy/pex/config";
import type { CvaSnapshot } from "./cvaSnapshot";

type Fx = {
  activeMarkets: number[]; markMarkets: number[];
  oracleMessageB64: string; oracleSignatureB64: string;
  deposits: Record<string, {
    sender: string; algoMicro: string; usdcMicro: string;
    minShares: string; storagePaymentMicro: string; txns: string[];
  }>;
  withdraw: {
    sender: string; route: { routeType: "idle" | "single_market"; marketId: number };
    shareAmount: string; minAlgoMicro: string; minUsdcMicro: string;
    maxLongReceipt: string; maxShortReceipt: string;
    recall: { accounts: string[]; assets: number[]; apps: number[] };
    txns: string[];
  };
};
const fx = fixture as unknown as Fx;
const bytes = (b: string) => new Uint8Array(Buffer.from(b, "base64"));
const decode = (t: string[]) => t.map((x) => algosdk.decodeUnsignedTransaction(bytes(x)));
const ATTACKER = "7777777777777777777777777777777777777777777777777774MSJUVU";

/** Only the fields the assertions read. */
const snap = {
  oracle: {
    message: bytes(fx.oracleMessageB64),
    signature: bytes(fx.oracleSignatureB64),
  },
} as unknown as CvaSnapshot;

const dShown = (k: string): DisplayedCvaDeposit => {
  const d = fx.deposits[k];
  return {
    sender: d.sender,
    algoMicro: BigInt(d.algoMicro),
    usdcMicro: BigInt(d.usdcMicro),
    minShares: BigInt(d.minShares),
    storagePaymentMicro: BigInt(d.storagePaymentMicro),
    markMarkets: fx.markMarkets,
  };
};

const wShown = (): DisplayedCvaWithdraw => ({
  sender: fx.withdraw.sender,
  shareAmount: BigInt(fx.withdraw.shareAmount),
  minAlgoMicro: BigInt(fx.withdraw.minAlgoMicro),
  minUsdcMicro: BigInt(fx.withdraw.minUsdcMicro),
  route: fx.withdraw.route,
  maxLongReceipt: BigInt(fx.withdraw.maxLongReceipt),
  maxShortReceipt: BigInt(fx.withdraw.maxShortReceipt),
  markMarkets: fx.markMarkets,
  recall: fx.withdraw.recall,
});

const vaultCall = (g: algosdk.Transaction[], selector: string) =>
  g.find((t) => Number(t.applicationCall?.appIndex) === PEX_APPS.cvaVault
    && Buffer.from(t.applicationCall!.appArgs[0]).toString("hex") === selector)!;

const marks = (g: algosdk.Transaction[]) =>
  g.filter((t) => Number(t.applicationCall?.appIndex) === PEX_APPS.cvaVault
    && Buffer.from(t.applicationCall!.appArgs[0]).toString("hex") === CVA_SELECTORS.markMarket);

// `decodeReceipt` and the assertions resolve names from the manifest.
beforeAll(async () => { await installProtocolManifest(); });

it("has a fixture for both deposit shapes and a withdrawal", () => {
  expect(Object.keys(fx.deposits).sort()).toEqual(["firstTime", "returning"]);
  expect(fx.markMarkets.length).toBeGreaterThan(0);
});

describe.each(["returning", "firstTime"])("real C-Vault deposit (%s)", (which) => {
  const group = () => decode(fx.deposits[which].txns);

  it("passes unmodified", () => {
    const r = assertCvaDepositGroup(group(), dShown(which), snap);
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checked.length).toBeGreaterThanOrEqual(6);
  });

  it("is the shape we measured: a mark preamble before any money moves", () => {
    const g = group();
    expect(g.length).toBe(8);
    expect(g.reduce((a, t) => a + Number(t.fee), 0)).toBe(74_000);
    // Four app calls, then the funding legs, then the deposit.
    expect(g.slice(0, 4).every((t) => t.type === "appl")).toBe(true);
    expect(marks(g).length).toBe(fx.markMarkets.length);
  });

  it("charges the right storage payment for this shape", () => {
    const expected = which === "firstTime" ? CVA_USER_BOX_MBR_MICRO_ALGO : BigInt(0);
    expect(BigInt(fx.deposits[which].storagePaymentMicro)).toBe(expected);
    // And the group really carries it — the pools' production bug was a group
    // that carried zero while the constant said otherwise.
    const g = group();
    const pays = g.filter((t) => t.type === "pay").map((t) => BigInt(t.payment!.amount));
    expect(pays).toContain(expected);
  });

  it("catches a REMOVED mark leg", () => {
    // Fewer marks means the vault prices against a staler NAV than the one the
    // user was quoted, with every displayed amount still matching.
    const g = group();
    const i = g.indexOf(marks(g)[0]);
    g.splice(i, 1);
    const r = assertCvaDepositGroup(g, dShown(which), snap);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("mark_preamble");
  });

  it("catches a mark leg RE-POINTED at another market", () => {
    const g = group();
    const m = marks(g)[0];
    (m.applicationCall!.appArgs as Uint8Array[])[1] = algosdk.encodeUint64(BigInt(99));
    const r = assertCvaDepositGroup(g, dShown(which), snap);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("mark_preamble");
  });

  it("catches an inflated USDC leg", () => {
    const g = group();
    const leg = g.find((t) => t.type === "axfer")!;
    (leg.assetTransfer as unknown as { amount: bigint }).amount =
      BigInt(fx.deposits[which].usdcMicro) * BigInt(10);
    const r = assertCvaDepositGroup(g, dShown(which), snap);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("usdc_amount");
  });

  it("catches funds redirected away from the vault", () => {
    const g = group();
    (g.find((t) => t.type === "axfer")!.assetTransfer as unknown as
      { receiver: algosdk.Address }).receiver = algosdk.decodeAddress(ATTACKER);
    const r = assertCvaDepositGroup(g, dShown(which), snap);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("usdc_receiver");
  });

  it("catches a lowered share floor", () => {
    const g = group();
    const call = vaultCall(g, CVA_SELECTORS.deposit);
    (call.applicationCall!.appArgs as Uint8Array[])[1] = algosdk.encodeUint64(BigInt(1));
    const r = assertCvaDepositGroup(g, dShown(which), snap);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("min_shares");
  });

  it("catches a substituted oracle price", () => {
    const g = group();
    const call = vaultCall(g, CVA_SELECTORS.deposit);
    const msg = Uint8Array.from(call.applicationCall!.appArgs[2]);
    msg[msg.length - 1] ^= 0xff;
    (call.applicationCall!.appArgs as Uint8Array[])[2] = msg;
    const r = assertCvaDepositGroup(g, dShown(which), snap);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("oracle_message");
  });

  it("catches a rekey, a close-out and a clawback", () => {
    for (const [field, code] of [
      ["rekeyTo", "rekey"], ["closeRemainderTo", "close_remainder_to"],
    ] as const) {
      const g = group();
      const t = field === "rekeyTo" ? g[0] : g.find((x) => x.type === "pay")!;
      const target = field === "rekeyTo" ? t : t.payment!;
      (target as unknown as Record<string, algosdk.Address>)[field] =
        algosdk.decodeAddress(ATTACKER);
      const r = assertCvaDepositGroup(g, dShown(which), snap);
      expect(r.ok, field).toBe(false);
      expect(r.findings.map((f) => f.code), field).toContain(code);
    }
  });

  it("catches a fee drain inside an otherwise valid group", () => {
    const g = group();
    (g[0] as unknown as { fee: bigint }).fee =
      BigInt(MAX_CVA_GROUP_FEE_MICRO_ALGO) + BigInt(1);
    const r = assertCvaDepositGroup(g, dShown(which), snap);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("fee_cap");
  });

  it("catches a foreign sender", () => {
    const r = assertCvaDepositGroup(group(), { ...dShown(which), sender: ATTACKER }, snap);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("foreign_sender");
  });
});

describe("real C-Vault withdrawal", () => {
  const group = () => decode(fx.withdraw.txns);

  it("passes unmodified, with the recall set supplied", () => {
    const r = assertCvaWithdrawGroup(group(), wShown(), snap);
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("is the shape we measured, and moves nothing out of the wallet", () => {
    const g = group();
    expect(g.length).toBe(15);
    expect(g.reduce((a, t) => a + Number(t.fee), 0)).toBe(178_000);
    // Both sides arrive by inner transfer, so an outbound leg here is money
    // going the wrong way.
    expect(new Set(g.map((t) => t.type))).toEqual(new Set(["appl"]));
  });

  it("refuses the whole group when the recall set is withheld", () => {
    const r = assertCvaWithdrawGroup(group(), {
      ...wShown(), recall: { accounts: [], assets: [], apps: [] },
    }, snap);
    expect(r.ok).toBe(false);
    const codes = new Set(r.findings.map((f) => f.code));
    expect(codes.has("foreign_account") || codes.has("foreign_app")
      || codes.has("foreign_asset")).toBe(true);
  });

  it("catches an inflated share burn", () => {
    const g = group();
    const call = vaultCall(g, CVA_SELECTORS.withdrawFromMarket);
    (call.applicationCall!.appArgs as Uint8Array[])[2] =
      algosdk.encodeUint64(BigInt(fx.withdraw.shareAmount) * BigInt(5));
    const r = assertCvaWithdrawGroup(g, wShown(), snap);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("share_amount");
  });

  it("catches lowered payout floors", () => {
    const g = group();
    const call = vaultCall(g, CVA_SELECTORS.withdrawFromMarket);
    (call.applicationCall!.appArgs as Uint8Array[])[3] = algosdk.encodeUint64(BigInt(0));
    (call.applicationCall!.appArgs as Uint8Array[])[4] = algosdk.encodeUint64(BigInt(0));
    const r = assertCvaWithdrawGroup(g, wShown(), snap);
    expect(r.ok).toBe(false);
    const codes = r.findings.map((f) => f.code);
    expect(codes).toContain("min_algo");
    expect(codes).toContain("min_usdc");
  });

  it("catches the withdrawal re-pointed at another market", () => {
    // A different allocation unwound than the one quoted and asserted.
    const g = group();
    const call = vaultCall(g, CVA_SELECTORS.withdrawFromMarket);
    (call.applicationCall!.appArgs as Uint8Array[])[1] = algosdk.encodeUint64(BigInt(2));
    const r = assertCvaWithdrawGroup(g, wShown(), snap);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("market_id");
  });

  it("catches a widened recall cap", () => {
    const g = group();
    const call = vaultCall(g, CVA_SELECTORS.withdrawFromMarket);
    (call.applicationCall!.appArgs as Uint8Array[])[8] =
      algosdk.encodeUint64(BigInt("18446744073709551615"));
    const r = assertCvaWithdrawGroup(g, wShown(), snap);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("max_long_receipt");
  });

  it("catches a changed recall mode", () => {
    const g = group();
    const call = vaultCall(g, CVA_SELECTORS.withdrawFromMarket);
    (call.applicationCall!.appArgs as Uint8Array[])[7] = algosdk.encodeUint64(BigInt(0));
    const r = assertCvaWithdrawGroup(g, wShown(), snap);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("yield_recall_mode");
  });

  it("catches a removed mark leg on the exit path too", () => {
    const g = group();
    const i = g.indexOf(marks(g)[0]);
    g.splice(i, 1);
    const r = assertCvaWithdrawGroup(g, wShown(), snap);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("mark_preamble");
  });

  it("catches an outbound payment added to an exit", () => {
    const g = group();
    g.push(algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: fx.withdraw.sender, receiver: ATTACKER, amount: 1_000_000,
      suggestedParams: {
        fee: 1000, minFee: 1000, firstValid: g[0].firstValid,
        lastValid: g[0].lastValid, genesisHash: g[0].genesisHash,
        genesisID: g[0].genesisID,
      } as unknown as algosdk.SuggestedParams,
    }));
    const r = assertCvaWithdrawGroup(g, wShown(), snap);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("pay_count");
  });

  it("catches the deposit selector swapped in for the withdrawal", () => {
    const g = group();
    const call = vaultCall(g, CVA_SELECTORS.withdrawFromMarket);
    (call.applicationCall!.appArgs as Uint8Array[])[0] =
      Uint8Array.from(Buffer.from(CVA_SELECTORS.deposit, "hex"));
    const r = assertCvaWithdrawGroup(g, wShown(), snap);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("withdraw_calls");
  });

  it("catches a substituted oracle signature", () => {
    const g = group();
    const call = vaultCall(g, CVA_SELECTORS.withdrawFromMarket);
    const sig = Uint8Array.from(call.applicationCall!.appArgs[6]);
    sig[sig.length - 1] ^= 0xff;
    (call.applicationCall!.appArgs as Uint8Array[])[6] = sig;
    const r = assertCvaWithdrawGroup(g, wShown(), snap);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("oracle_signature");
  });
});

it("pins the C-Vault selectors against the vendored manifest", () => {
  expect(CVA_SELECTORS).toEqual({
    deposit: "b2eea014",
    withdraw: "e8e9f32d",
    withdrawFromMarket: "92ad0e57",
    markMarket: "7eda6c29",
  });
  expect(PEX_ASSETS.usdc).toBe(31566704);
});
