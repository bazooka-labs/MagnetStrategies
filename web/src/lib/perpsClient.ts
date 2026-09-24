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
  MAX_KEEPER_FEE_ESCROW_USDC,
  ORACLE_MAX_AGE_SEC,
  PEX_APPS,
  POSITION_BUILDER_FEE_BPS,
} from "./perps";
import { allocateBaseOrderId, assertBaseOrderIdFree, readMarketState } from "./perpsReads";
import { getOraclePayload } from "./perpsOracle";
import { installProtocolManifest } from "./perpsManifest";
import { assertOpenWithTakeProfit, simulateGroup, ORDER_BOX_MBR_MICRO_ALGO } from "./perpsGroup";
import { acceptableFromExecution, quoteOpen } from "./perpsQuote";
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
};

const micro = (usd: number): bigint => BigInt(Math.round(usd * 1e6));

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
  const tpAcceptable = acceptableFromExecution(takeProfitPrice12, side, slippageBps);

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
      maxKeeperFeeMicro: micro(MAX_KEEPER_FEE_ESCROW_USDC),
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

  stage("signing");
  const txns = group.map((t) => ((t as { txn?: algosdk.Transaction }).txn ?? t) as algosdk.Transaction);
  // The SDK already grouped these; re-assigning would invalidate the assertion
  // that just passed over these exact bytes.
  const signed = await signTransactions(txns.map((t) => algosdk.encodeUnsignedTransaction(t)));
  const blobs = signed.filter((s): s is Uint8Array => !!s);
  if (blobs.length !== txns.length) throw new Error("Signing cancelled.");

  stage("submitting");
  const res = await algod.sendRawTransaction(blobs).do();
  stage("confirming");
  await algosdk.waitForConfirmation(algod, res.txid, 6);

  return { txId: res.txid, baseOrderId: alloc.baseOrderId, checks: assertion.checked };
}
