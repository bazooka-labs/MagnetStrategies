// Perps — the write path.
//
// One function opens a position, and it is the only place in the app that hands
// a group to a wallet. The order of operations is the point:
//
//   1. install the pinned protocol manifest      (never fetched)
//   2. re-read market state and oracle           (fresh, not the card's copy)
//   3. allocate baseOrderId from chain           (never from local state)
//   4. build the group
//   5. ASSERT the group against what was displayed
//   6. simulate as a pre-flight
//   7. only then prompt the wallet
//
// Step 5 gates step 7. A group that fails assertion is never presented for
// signature — see strategy/perps/SPEC.md, Invariant 9. That is a defence against
// construction bugs, not against a compromised frontend, which would own this
// file too.

import algosdk from "algosdk";
import { buildV2MarketOpenWithAttachedOrdersTransactions } from "@pdex/sdk/transactions";
import { V2_ORDER_TARGET } from "@pdex/sdk";
import {
  BUILDER_ADDRESS,
  CHILD_KEEPER_FEE_USDC,
  COLLATERAL_ASSET_ID,
  DEFAULT_SLIPPAGE_BPS,
  ORACLE_MAX_AGE_SEC,
  PEX_APPS,
  POSITION_BUILDER_FEE_BPS,
} from "./perps";
import { allocateBaseOrderId, assertBaseOrderIdFree, readMarketState, readPosition } from "./perpsReads";
import { getOraclePayload } from "./perpsOracle";
import { installProtocolManifest } from "./perpsManifest";
import { assertOpenWithTakeProfit, simulateGroup, ORDER_BOX_MBR_MICRO_ALGO } from "./perpsGroup";
import { acceptableForClose, quoteOpen } from "./perpsQuote";
import type { Side } from "./perpsSolver";

type SignFn = (txns: Uint8Array[]) => Promise<(Uint8Array | null)[]>;

export type OpenStage =
  | "preparing" | "allocating" | "building" | "checking"
  | "simulating" | "signing" | "submitting" | "confirming";

export type OpenPositionInput = {
  algod: algosdk.Algodv2;
  signTransactions: SignFn;
  sender: string;
  marketId: number;
  side: Side;
  /** Collateral in whole USDC, as shown. */
  collateralUsd: number;
  /** Notional in whole USD, as shown. */
  notionalUsd: number;
  /** Take-profit trigger, Price12, exactly as displayed. */
  takeProfitPrice12: bigint;
  slippageBps?: number;
  onStage?: (s: OpenStage) => void;
};

export type OpenPositionResult = {
  txId: string;
  baseOrderId: bigint;
  /** What the assertion actually checked, for the receipt. */
  checks: string[];
  /**
   * False when the group was submitted but confirmation was not observed in
   * time. It is NOT a failure: the group stays valid for the rest of its window
   * and will most likely commit. The caller must show the txId and say the
   * outcome is unknown — never that it failed.
   */
  confirmed: boolean;
};

/** Thrown when a position already exists on this market and side. */
export class PositionAlreadyOpenError extends Error {
  constructor(readonly sizeUsdMicro: bigint) {
    super("You already have a position on this market and side. Close it before opening another.");
    this.name = "PositionAlreadyOpenError";
  }
}

const micro = (usd: number): bigint => BigInt(Math.round(usd * 1e6));

/**
 * Rounds to wait for confirmation. Algorand blocks are ~2.8s, so this is about
 * two minutes — long enough to cover a slow round and a load-balanced poll,
 * short enough not to strand the UI. Running out is reported, never thrown.
 */
const CONFIRM_ROUNDS = 40;

/** ALGO needed for the order-box MBR plus group fees, with headroom. */
const MIN_ALGO_MICRO = ORDER_BOX_MBR_MICRO_ALGO + BigInt(200_000);

export async function openPosition(input: OpenPositionInput): Promise<OpenPositionResult> {
  const {
    algod, signTransactions, sender, marketId, side,
    collateralUsd, notionalUsd, takeProfitPrice12,
  } = input;
  const slippageBps = input.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const stage = (s: OpenStage) => input.onStage?.(s);

  if (!BUILDER_ADDRESS) throw new Error("Builder address is not configured.");
  if (collateralUsd <= 0 || notionalUsd <= 0) throw new Error("Enter an amount first.");

  stage("preparing");
  // Encoding without a verified ABI is the one thing we never do.
  await installProtocolManifest();

  // Deliberately re-read rather than trusting the card's snapshot: an oracle
  // payload is only valid for a few seconds, and parameters move.
  const [state, oracle, account] = await Promise.all([
    readMarketState(algod, marketId),
    getOraclePayload(PEX_APPS.trading, marketId),
    algod.accountInformation(sender).do(),
  ]);

  if (!oracle.signatureVerified) {
    throw new Error("The price could not be verified against PEX's signing key. Nothing was sent.");
  }
  if (oracle.ageSeconds > ORACLE_MAX_AGE_SEC) {
    throw new Error("The price is stale. Try again.");
  }

  // Fail with something actionable rather than letting the chain reject it.
  const algoSpendable = BigInt(account.amount) - BigInt(account.minBalance);
  if (algoSpendable < MIN_ALGO_MICRO) {
    throw new Error(
      `Needs about ${(Number(MIN_ALGO_MICRO) / 1e6).toFixed(2)} spendable ALGO for the order record and fees.`,
    );
  }
  const usdcHeld = (account.assets ?? []).find(
    (a: { assetId?: bigint | number }) => Number(a.assetId) === COLLATERAL_ASSET_ID,
  );
  if (!usdcHeld) throw new Error("This wallet does not hold USDC.");
  if (BigInt(usdcHeld.amount) < micro(collateralUsd) + micro(CHILD_KEEPER_FEE_USDC)) {
    throw new Error("Not enough USDC for the position plus its keeper fee.");
  }

  // Slippage is anchored to the quoted execution price, not the index — an
  // index-anchored bound fails at every size once impact is charged.
  const probe = quoteOpen({
    state, oracle, side, collateralUsd, notionalUsd,
    builderAddress: BUILDER_ADDRESS, collateralAssetId: COLLATERAL_ASSET_ID, slippageBps,
  });
  if (!probe.ok) {
    throw new Error(`The exchange will not accept this position: ${probe.reasons.join(", ")}`);
  }
  const acceptablePrice = probe.acceptablePrice12;
  // A take-profit CLOSES the position, so its acceptable price sits on the
  // opposite side of the trigger from an open. See acceptableForClose.
  const tpAcceptable = acceptableForClose(takeProfitPrice12, side, slippageBps);

  // ── One position per (market, side) ──────────────────────────────────────
  // PEX keeps exactly one position per (market, collateral asset, side) and a
  // second open INCREASES it. We do not support increases: it is a second
  // economic path with its own quoting and assertion surface, and it is what
  // turns an unobserved confirmation into a doubled position. Refuse instead.
  //
  // This also makes `position: null` in the quote correct rather than merely
  // convenient — every open we permit really does start from nothing.
  const existing = await readPosition(algod, sender, marketId, COLLATERAL_ASSET_ID, side === "long" ? 1 : 2);
  if (existing && existing.size_usd > BigInt(0)) {
    throw new PositionAlreadyOpenError(existing.size_usd);
  }

  stage("allocating");
  const alloc = await allocateBaseOrderId(algod, sender);
  if (!(await assertBaseOrderIdFree(algod, sender, alloc))) {
    throw new Error("Order id was taken while preparing. Try again.");
  }

  stage("building");
  const sp = await algod.getTransactionParams().do();
  const sideCode = side === "long" ? BigInt(1) : BigInt(2);
  const keeperFee = micro(CHILD_KEEPER_FEE_USDC);

  const group = buildV2MarketOpenWithAttachedOrdersTransactions({
    sender, marketId,
    collateralAssetId: COLLATERAL_ASSET_ID,
    side: sideCode,
    collateralAmount: micro(collateralUsd),
    sizeUsdDelta: micro(notionalUsd),
    acceptablePrice,
    oracleMessage: oracle.message,
    oracleSignature: oracle.signature,
    builderFee: { builderAddress: BUILDER_ADDRESS, builderFeeBps: BigInt(POSITION_BUILDER_FEE_BPS) },
    baseOrderId: alloc.baseOrderId,
    targetKind: V2_ORDER_TARGET.PAIR,
    indexAssetId: Number(state.core.index_asset_id),
    longAssetId: Number(state.core.long_asset_id),
    shortAssetId: Number(state.core.short_asset_id),
    takeProfit: {
      triggerPrice: takeProfitPrice12,
      acceptablePrice: tpAcceptable,
      sizeUsdDelta: micro(notionalUsd),
      collateralAmount: BigInt(0),
      keeperFeeAssetId: COLLATERAL_ASSET_ID,
      keeperFeeAmount: keeperFee,
      outputSwapMode: BigInt(0),
      minPrimaryOutputAmount: BigInt(0),
      minSecondaryOutputAmount: BigInt(0),
      timeInForce: BigInt(0),
      expiryTime: BigInt(0),
    },
    v2MathAppId: PEX_APPS.math,
    v2MarketsAppId: PEX_APPS.markets,
    v2TradingAppId: PEX_APPS.trading,
    v2TradingRiskOpsAppId: PEX_APPS.tradingRiskOps,
    v2OrderOpsAppId: PEX_APPS.orderOps,
    v2MarketXalgoYieldVaultAppId: PEX_APPS.marketXAlgoYieldVault,
    v2AdminControlAppId: PEX_APPS.adminControl,
  }, sp) as unknown[];

  stage("checking");
  const assertion = assertOpenWithTakeProfit(
    group,
    {
      sender, marketId, side: side === "long" ? 1 : 2,
      collateralAssetId: COLLATERAL_ASSET_ID,
      collateralAmountMicro: micro(collateralUsd),
      sizeUsdDeltaMicro: micro(notionalUsd),
      acceptablePrice12: acceptablePrice,
      executionPrice12: probe.executionPrice12,
      indexPrice12: oracle.indexPrice12,
      slippageBps,
      oracleMessage: oracle.message,
      oracleSignature: oracle.signature,
    },
    {
      triggerPrice12: takeProfitPrice12,
      acceptablePrice12: tpAcceptable,
      sizeUsdDeltaMicro: micro(notionalUsd),
      keeperFeeMicro: keeperFee,
      baseOrderId: alloc.baseOrderId,
      slippageBps,
    },
  );
  if (!assertion.ok) {
    // Nothing is presented for signature. The detail is deliberately verbose —
    // this should never fire, and if it does someone needs the specifics.
    throw new Error(
      `Safety check failed, nothing was sent: ${assertion.findings.map((f) => `${f.code} (${f.detail})`).join("; ")}`,
    );
  }

  stage("simulating");
  const sim = await simulateGroup(algod, group);
  if (!sim.ok) {
    throw new Error(`The exchange rejected this in simulation, so it was not sent: ${sim.message ?? "unknown"}`);
  }

  // Re-check immediately before the prompt. This narrows the window rather than
  // closing it: two tabs could still both pass, and because positions MERGE the
  // loser is not rejected — it increases. Nothing off chain can close that gap.
  const stillClear = await readPosition(algod, sender, marketId, COLLATERAL_ASSET_ID, side === "long" ? 1 : 2);
  if (stillClear && stillClear.size_usd > BigInt(0)) {
    throw new PositionAlreadyOpenError(stillClear.size_usd);
  }

  stage("signing");
  const txns = group.map((t) => ((t as { txn?: algosdk.Transaction }).txn ?? t) as algosdk.Transaction);
  // The SDK already grouped these; re-assigning would invalidate the assertion
  // that just passed over these exact bytes.
  const signed = await signTransactions(txns.map((t) => algosdk.encodeUnsignedTransaction(t)));
  const blobs = signed.filter((s): s is Uint8Array => !!s);
  if (blobs.length !== txns.length) throw new Error("Signing cancelled.");

  stage("submitting");
  const res = await algod.sendRawTransaction(blobs).do();

  // Past this line the money may already have moved. Nothing below may throw
  // away the txid, and a wait that runs out is NOT a failure.
  //
  // The old code waited 6 rounds — about 17 seconds — against a validity window
  // of roughly 47 minutes, then threw. Worse, algod here is a load-balanced
  // endpoint and the SDK deliberately swallows the 404s that come from polling a
  // different node than the one that accepted the submission. So a successful
  // open reported as failed was not an edge case; it was the expected outcome of
  // a slow round. The user then retried and opened a second position.
  stage("confirming");
  let confirmed = false;
  try {
    await algosdk.waitForConfirmation(algod, res.txid, CONFIRM_ROUNDS);
    confirmed = true;
  } catch {
    // Deliberately swallowed. The caller is told `confirmed: false` and given the
    // txid; it must not present this as a failure.
    confirmed = false;
  }

  return { txId: res.txid, baseOrderId: alloc.baseOrderId, checks: assertion.checked, confirmed };
}
