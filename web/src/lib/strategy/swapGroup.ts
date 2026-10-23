/**
 * Converting a payout leg to USDC through PEX's own swap.
 *
 * ── Why this exists ──
 * The C-Vault pays out in two assets and has no swap method of its own
 * (confirmed by Ultrade: twenty methods, none swap). A single-asset exit
 * therefore converts the ALGO leg afterwards, through
 * `SwapOps.swap_exact_in`.
 *
 * ── Why it is a SECOND GROUP, not more transactions on the first ──
 * A vault withdrawal is 15 transactions and this swap is 7. Algorand caps a
 * GROUP at 16, so they cannot be one group. They CAN be one signing request:
 * ARC-0001 `signTxns` takes an array spanning several groups and the wallet
 * prompts once. So the user approves once and the chain evaluates two groups.
 *
 * ── The consequence, which is real and is handled rather than hidden ──
 * The two groups are not atomic with each other. The swap is therefore sized to
 * the FLOOR the withdrawal guarantees on chain, never to its simulated output:
 * if the exit pays at least its floor — which the contract asserts — the swap's
 * input is certainly present, so it cannot fail for want of funds the exit did
 * not deliver.
 *
 * The price of that guarantee is dust. At 1% slippage roughly 1% of the ALGO
 * leg stays ALGO, which on a $10 exit measured as 0.2226 ALGO (~$0.024, 0.24%
 * of the withdrawal). Accepted deliberately: "99% converted with a low chance
 * of failure" beats "100% converted, sometimes stranded".
 */

import algosdk from "algosdk";
import { buildV2SwapExactInTransactions } from "@pdex/sdk";
import { PEX_APPS, PEX_ASSETS, ORACLE_MAX_AGE_SEC, MIN_SIGNING_BUDGET_SEC } from "../perps";
import {
  checkEveryTransaction, checkMathCarriers, abiBytes, simulateGroup,
  type AnyTxn, type GroupAssertion, type GroupFinding,
} from "../perpsGroup";
import { getOraclePayload } from "../perpsOracle";
import { receiptFromLogs, withTolerance, type LiquidityReceipt, type Stage } from "./group";

/** `PDexV2SwapOps.swap_exact_in(uint64,uint64,uint64,txn,uint64,address,byte[],byte[],byte[],byte[],uint64,uint64,uint64)byte[]` */
export const SWAP_SELECTOR = "dc43e437" as const;

/**
 * Fee ceiling, µALGO. Measured at 43,000 for a one-hop swap with a yield
 * recall. 100,000 leaves room for an extra carrier without leaving a skimmable
 * margin.
 */
export const MAX_SWAP_GROUP_FEE_MICRO_ALGO = 100_000;

const CALLABLE = new Set<number>([PEX_APPS.swapOps, PEX_APPS.markets, PEX_APPS.math]);

const hex = (b: Uint8Array): string =>
  Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const u64 = (b: Uint8Array | undefined): bigint =>
  b && b.length === 8 ? new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0) : BigInt(-1);
const big = (v: bigint | number | undefined): bigint => BigInt(v ?? 0);
const normalise = (t: unknown[]): AnyTxn[] =>
  t.map((x) => ((x as { txn?: unknown }).txn ?? x) as AnyTxn);

export type DisplayedSwap = {
  sender: string;
  marketId: number;
  /** µALGO going in. The withdrawal's guaranteed floor. */
  amountInMicro: bigint;
  /** Floor on the USDC received. */
  minOutMicro: bigint;
  maxOutputReceipt: bigint;
  oracleMessage: Uint8Array;
  oracleSignature: Uint8Array;
  recall: { accounts: string[]; assets: number[]; apps: number[] };
};

/**
 * Assert a swap group against what was displayed.
 *
 * The `receiver` check is the one that matters most on this flow. Every other
 * field being correct still loses the money if the output is sent somewhere
 * else, and `receiver` is a plain argument on the call — not implied by the
 * sender, and not covered by any other check here.
 */
export function assertSwapGroup(txnsIn: unknown[], shown: DisplayedSwap): GroupAssertion {
  const txns = normalise(txnsIn);
  const findings: GroupFinding[] = [];
  const checked: string[] = [];
  const fail = (code: string, detail: string) => findings.push({ code, detail });
  const did = (name: string) => checked.push(name);

  const counts: Record<string, number> = {};
  txns.forEach((t, i) => {
    const type = String(t.type ?? "");
    counts[type] = (counts[type] ?? 0) + 1;
    if (!["pay", "axfer", "appl"].includes(type)) {
      fail("txn_type", `txn ${i} is "${type || "typeless"}"`);
    }
  });
  // One leg in: the ALGO being converted. ALGO moves by `pay`, so no axfer.
  if ((counts.pay ?? 0) !== 1) {
    fail("pay_count", `expected 1 payment in, found ${counts.pay ?? 0}`);
  }
  if ((counts.axfer ?? 0) !== 0) {
    fail("axfer_count", `expected no asset transfer out, found ${counts.axfer ?? 0}`);
  }
  for (const t of txns) {
    if (!t.applicationCall) continue;
    const app = Number(t.applicationCall.appIndex);
    if (!CALLABLE.has(app)) fail("unpinned_app", `group calls app ${app}, which this flow never uses`);
  }
  did("every transaction is a type and an app this flow uses, in the expected counts");

  const totalFee = checkEveryTransaction(txns, {
    sender: shown.sender,
    collateralAssetId: PEX_ASSETS.usdc,
    allowAccounts: new Set(shown.recall.accounts),
    allowAssets: new Set(shown.recall.assets),
    allowApps: new Set<number>([PEX_APPS.swapOps, ...shown.recall.apps]),
  }, fail, did);
  if (totalFee > BigInt(MAX_SWAP_GROUP_FEE_MICRO_ALGO)) {
    fail("fee_cap", `group fee ${totalFee} µALGO exceeds ${MAX_SWAP_GROUP_FEE_MICRO_ALGO}`);
  } else {
    did(`group fee is within ${MAX_SWAP_GROUP_FEE_MICRO_ALGO} µALGO`);
  }
  checkMathCarriers(txns, fail, did, {
    accounts: new Set(shown.recall.accounts),
    assets: new Set(shown.recall.assets),
    collateralAssetId: PEX_ASSETS.usdc,
  });

  // The ALGO leg. Exactly the amount displayed, paid to the swap venue.
  const pay = txns.find((t) => t.type === "pay");
  if (pay) {
    if (big(pay.payment?.amount) !== shown.amountInMicro) {
      fail("amount_in", `the ALGO leg is ${big(pay.payment?.amount)} µALGO, displayed ${shown.amountInMicro}`);
    } else {
      did(`converts exactly ${shown.amountInMicro} µALGO`);
    }
  }

  const calls = txns.filter((t) => Number(t.applicationCall?.appIndex) === PEX_APPS.swapOps);
  if (calls.length !== 1) {
    fail("swap_calls", `expected exactly 1 SwapOps call, found ${calls.length}`);
    return { ok: false, findings, checked };
  }
  const args = (calls[0].applicationCall?.appArgs ?? []) as Uint8Array[];
  if (hex(args[0] ?? new Uint8Array()) !== SWAP_SELECTOR) {
    fail("swap_selector", `SwapOps call is selector ${hex(args[0] ?? new Uint8Array())}, expected ${SWAP_SELECTOR}`);
    return { ok: false, findings, checked };
  }
  // args: 0 selector | 1 hop_count | 2 market_0 | 3 market_1 |
  //       4 min_final_amount_out | 5 receiver | 6..9 oracles |
  //       10 recall_mode | 11,12 caps        (token_in_transfer is a txn ref)
  if (u64(args[1]) !== BigInt(1)) {
    fail("hop_count", `swap is ${u64(args[1])} hops, expected 1 — a multi-hop route is not what was quoted`);
  }
  if (u64(args[2]) !== BigInt(shown.marketId)) {
    fail("market_id", `swap routes through market ${u64(args[2])}, displayed ${shown.marketId}`);
  }
  if (u64(args[4]) !== shown.minOutMicro) {
    fail("min_out", `minimum USDC out is ${u64(args[4])}, displayed ${shown.minOutMicro}`);
  }
  /**
   * THE check on this flow.
   *
   * `receiver` is a plain argument, so a changed one sends the converted USDC
   * to another account while every amount in the group still matches the
   * screen. Nothing else here would catch it: the sender is still the user,
   * the fee is in budget, the oracle is ours.
   */
  const recv = args[5];
  const want = algosdk.decodeAddress(shown.sender).publicKey;
  if (!recv || recv.length !== 32 || hex(recv) !== hex(want)) {
    fail("receiver", "the swap pays out to an account that is not the user");
  } else {
    did("the converted USDC is paid to the user, and to no one else");
  }
  if (u64(args[10]) !== BigInt(1)) {
    fail("yield_recall_mode", `recall mode is ${u64(args[10])}, expected 1`);
  }
  if (u64(args[11]) !== shown.maxOutputReceipt) {
    fail("max_output_receipt", `receipt cap is ${u64(args[11])}, displayed ${shown.maxOutputReceipt}`);
  }

  const m = args[6] ? abiBytes(args[6]) : null;
  const s = args[7] ? abiBytes(args[7]) : null;
  if (!m || hex(m) !== hex(shown.oracleMessage)) {
    fail("oracle_message", "the oracle price in the swap is not the one that was verified");
  } else if (!s || hex(s) !== hex(shown.oracleSignature)) {
    fail("oracle_signature", "the oracle signature in the swap is not the one that was verified");
  } else {
    did("the swap carries exactly the oracle price we verified against the pinned PEX signer");
  }

  return { ok: findings.length === 0, findings, checked };
}

export type SwapBuild = {
  txns: algosdk.Transaction[];
  assertion: GroupAssertion;
  receipt: LiquidityReceipt;
  /** µUSDC the simulation says this converts to. */
  usdcOut: bigint;
  signingBudgetSec: number;
};

/**
 * Build, assert and simulate a conversion of `amountInMicro` ALGO to USDC.
 *
 * `amountInMicro` must be an amount the caller is CERTAIN will be available —
 * for the vault exit that is the withdrawal's on-chain floor. Passing the
 * simulated output instead is what makes the second group fail after the first
 * has already paid out.
 */
export async function buildAlgoToUsdcSwap(input: {
  algod: algosdk.Algodv2;
  sender: string;
  marketId: number;
  amountInMicro: bigint;
  registry: Record<string, unknown>;
  recall: { accounts: string[]; assets: number[]; apps: number[] };
  slippageBps: number;
  stage?: Stage;
}): Promise<SwapBuild> {
  const { algod, sender, marketId, stage = () => {} } = input;
  if (input.amountInMicro <= BigInt(0)) throw new Error("Nothing to convert.");

  stage("pricing");
  const fetchedAt = Date.now();
  // Targeted at SwapOps: the app that verifies this payload. AdminOps is
  // refused, and the target is inside the signed bytes so it cannot be
  // redirected by passing a different app id.
  const oracle = await getOraclePayload(PEX_APPS.swapOps, marketId);
  if (!oracle.signatureVerified) {
    throw new Error("The price could not be verified against PEX's signing key. Nothing was sent.");
  }

  const sp = await algod.getTransactionParams().do();
  sp.fee = sp.minFee;
  sp.flatFee = true;

  // Generous: a maximum on recalled receipt tokens, bounded by the assertion.
  const maxOutputReceipt = input.amountInMicro * BigInt(20) + BigInt(100_000_000);

  const build = (minOut: bigint) => buildV2SwapExactInTransactions({
    sender, marketId,
    tokenInAssetId: PEX_ASSETS.algo,
    amountIn: input.amountInMicro,
    minAmountOut: minOut,
    receiver: sender,
    yieldRecallMode: 1,
    maxOutputReceiptAmount: maxOutputReceipt,
    marketYieldRegistry: input.registry,
    oracleMessage: oracle.message,
    oracleSignature: oracle.signature,
    indexAssetId: PEX_ASSETS.algo,
    longAssetId: PEX_ASSETS.algo,
    shortAssetId: PEX_ASSETS.usdc,
    v2MathAppId: PEX_APPS.math, v2MarketsAppId: PEX_APPS.markets,
    v2TradingAppId: PEX_APPS.trading, v2TradingRiskOpsAppId: PEX_APPS.tradingRiskOps,
    v2OrderOpsAppId: PEX_APPS.orderOps, v2AdminOpsAppId: PEX_APPS.adminOps,
    v2SwapOpsAppId: PEX_APPS.swapOps, v2AdminControlAppId: PEX_APPS.adminControl,
    v2MarketYieldVaultAppId: PEX_APPS.marketYieldVault,
    v2MarketXalgoYieldVaultAppId: PEX_APPS.marketXAlgoYieldVault,
  } as never, sp) as algosdk.Transaction[];

  // Two passes, as every other path here: the chain's own figure sets the floor.
  const probe = await simulateGroup(algod, build(BigInt(0)));
  if (!probe.ok) {
    throw new Error(`The conversion could not be prepared, so nothing was sent: ${probe.message ?? "unknown"}`);
  }
  const probeReceipt = receiptFromLogs(probe.logs, "v2_swap_executed");
  if (!probeReceipt) {
    throw new Error("PEX did not report what this conversion would pay out, so nothing was sent.");
  }
  const out = probeReceipt.fields.amount_out ?? BigInt(0);
  const minOut = withTolerance(out, input.slippageBps);

  stage("building");
  const txns = build(minOut);

  stage("checking");
  const assertion = assertSwapGroup(txns, {
    sender, marketId,
    amountInMicro: input.amountInMicro,
    minOutMicro: minOut,
    maxOutputReceipt,
    oracleMessage: oracle.message,
    oracleSignature: oracle.signature,
    recall: input.recall,
  });
  if (!assertion.ok) {
    console.warn("swap: failed its assertion", assertion.findings);
    throw new Error(
      `The safety check did not pass, so nothing was sent: ${assertion.findings[0]?.detail ?? "unknown"}`);
  }

  stage("simulating");
  const trial = await simulateGroup(algod, txns);
  if (!trial.ok) {
    throw new Error(`The conversion could not be prepared, so nothing was sent: ${trial.message ?? "unknown"}`);
  }
  const receipt = receiptFromLogs(trial.logs, "v2_swap_executed");
  if (!receipt) {
    throw new Error("PEX did not report what this conversion would pay out, so nothing was sent.");
  }

  const signingBudgetSec =
    ORACLE_MAX_AGE_SEC - oracle.ageSeconds - (Date.now() - fetchedAt) / 1000;
  if (signingBudgetSec < MIN_SIGNING_BUDGET_SEC) {
    throw new Error("Preparing this took longer than the price is valid for. Nothing was sent — try again.");
  }
  return {
    txns, assertion, receipt,
    usdcOut: receipt.fields.amount_out ?? BigInt(0),
    signingBudgetSec,
  };
}
