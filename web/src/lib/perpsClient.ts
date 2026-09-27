// Perps — the write path.
//
// One function opens a position, and it is the only place in the app that hands
// a group to a wallet. The order of operations is the point:
//
//   1. install the pinned protocol manifest      (never fetched)
//   2. re-read market state + verify the pins    (fresh, not the card's copy)
//   3. refuse if a position is already open      (we do not support increases)
//   4. allocate baseOrderId from chain           (never from local state)
//   5. fetch the signed oracle payload           (LAST — it expires in ~30s)
//   6. quote, and refuse a crossed take-profit   (PEX's answer, not ours)
//   7. refuse if the market moved past what the card showed
//   8. build the group
//   9. ASSERT the group against what was displayed
//  10. simulate as a pre-flight
//  11. only then prompt the wallet
//
// Step 9 gates step 11. Steps 3-4 deliberately precede step 5: none of them
// need a price, and every second spent before fetching the payload is a second
// of its validity window spent before the user ever sees the wallet prompt. A group that fails assertion is never presented for
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
  MAX_DISPLAY_DRIFT_BPS,
  MAX_ENTRY_DRIFT_BPS,
  MAX_LIQUIDATION_DRIFT_BPS,
  ORACLE_MAX_AGE_SEC,
  PEX_APPS,
  POSITION_BUILDER_FEE_BPS,
} from "./perps";
import { allocateBaseOrderId, assertBaseOrderIdFree, readMarketState, readPosition } from "./perpsReads";
import { getOraclePayload } from "./perpsOracle";
import { installProtocolManifest } from "./perpsManifest";
import { preflight } from "./perpsPreflight";
import { assertOpenWithTakeProfit, simulateGroup, ORDER_BOX_MBR_MICRO_ALGO } from "./perpsGroup";
import {
  acceptableForClose,
  quoteOpen,
  quoteTakeProfitCrossed,
  takeProfitBounds,
} from "./perpsQuote";
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
  /**
   * The prices the card had on screen when the user decided.
   *
   * **Required, deliberately.** As an optional field this would be the fourth
   * documented control in this codebase with no caller, and it is the one that
   * makes Invariant 9 true rather than merely stated: without it the assertion
   * compares the group against numbers `openPosition` computed itself moments
   * earlier, which proves the builder is self-consistent and nothing about
   * whether the user saw these numbers.
   */
  displayed: {
    /**
     * The field names carry `asRendered` deliberately.
     *
     * This check is only meaningful if these are the values that were on the
     * screen. A caller that fills them from its own fresh read turns the guard
     * back into the tautology it was built to remove, and the type cannot
     * enforce provenance — so the name states the requirement at every call
     * site instead. Pass the exact values the rendered memo held.
     */
    asRenderedIndexPrice12: bigint;
    asRenderedEntryPrice12: bigint;
    asRenderedLiquidationPrice12: bigint;
  };
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

/**
 * Seconds of oracle validity that must remain when the wallet is prompted.
 *
 * A wallet round trip is a human action: read the prompt, approve it, maybe
 * unlock a device. Under this, the signature would very likely land against an
 * expired price and be rejected on chain — after approval, which is the worst
 * moment to discover it.
 */
const MIN_SIGNING_BUDGET_SEC = 8;

/**
 * One open at a time, per tab.
 *
 * Two rapid clicks used to run two full flows and raise two wallet prompts.
 * That was not a doubling path — both allocate the same `baseOrderId` and the
 * `o2:` box collision makes the second group fail atomically on chain — but
 * relying on that is relying on an accident of PEX's storage model to protect
 * a UI mistake. It also wastes a prompt and reads as a bug.
 */
let openInFlight = false;

export async function openPosition(input: OpenPositionInput): Promise<OpenPositionResult> {
  if (openInFlight) {
    throw new Error("An open is already in progress. Wait for it to finish.");
  }
  openInFlight = true;
  try {
    return await openPositionInner(input);
  } finally {
    openInFlight = false;
  }
}

async function openPositionInner(input: OpenPositionInput): Promise<OpenPositionResult> {
  const {
    algod, signTransactions, sender, marketId, side,
    collateralUsd, notionalUsd, takeProfitPrice12, displayed,
  } = input;
  const slippageBps = input.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const stage = (s: OpenStage) => input.onStage?.(s);

  if (!BUILDER_ADDRESS) throw new Error("Builder address is not configured.");
  // `Number.isFinite` rather than a comparison: NaN fails EVERY comparison, so
  // `NaN <= 0` is false and a NaN used to pass this guard untouched, then reach
  // `BigInt(Math.round(NaN))` and surface as a raw RangeError with no wallet
  // prompt and no explanation. Infinity did the same.
  if (!Number.isFinite(collateralUsd) || !Number.isFinite(notionalUsd)
    || collateralUsd <= 0 || notionalUsd <= 0) {
    throw new Error("Enter an amount first.");
  }
  if (takeProfitPrice12 <= BigInt(0)) {
    throw new Error("Set a take-profit price first.");
  }
  if (!Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new Error("Slippage tolerance is out of range.");
  }

  stage("preparing");
  // Encoding without a verified ABI is the one thing we never do.
  await installProtocolManifest();

  // Deliberately re-read rather than trusting the card's snapshot: parameters
  // move. **The oracle is NOT fetched here** — see the note before it below.
  const [state, account, pre] = await Promise.all([
    readMarketState(algod, marketId),
    algod.accountInformation(sender).do(),
    // Normally cached and warm — the card starts it on mount. Re-checked here
    // rather than taken from the caller: the card's gate is there so the button
    // is honest, and this one is here so the gate is not the only thing
    // standing between an upgraded PEX and a signature.
    preflight(algod),
  ]);

  if (!pre.canOpen) {
    if (pre.detail) console.warn(`perps: preflight refused the open — ${pre.detail}`);
    throw new Error(pre.reason ?? "Trading is unavailable right now.");
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

  // ── The oracle payload, fetched as LATE as possible ─────────────────────
  //
  // PEX publishes on a ~30 second cadence, but ORACLE_MAX_AGE_SEC is 20 and
  // every budget number here is computed against OUR 20, not PEX's 30 — so a
  // payload that passes these checks has more real chain validity left than the
  // arithmetic claims. Deliberately the conservative direction.
  //
  // Fetching this up front alongside the other
  // reads put it 4-6 seconds old on arrival and, measured end to end on a fast
  // wired connection with a warm preflight, **about 12 seconds old by the time
  // the wallet prompt appeared** — leaving under 18 seconds for the entire
  // signing round trip. A mobile deep link or a hardware wallet routinely takes
  // longer, and the group then fails on chain after the user has already signed.
  //
  // Nothing above this line needs a price: the preflight, the balance checks,
  // the one-position guard and the order-id allocation (which paginates boxes,
  // and is the slowest step) are all price-independent. So they run first and
  // the payload is fetched here, immediately before it is used.
  const oracleFetchedAt = Date.now();
  const oracle = await getOraclePayload(PEX_APPS.trading, marketId);
  if (!oracle.signatureVerified) {
    throw new Error("The price could not be verified against PEX's signing key. Nothing was sent.");
  }
  // No staleness check here: `getOraclePayload` throws on an over-age payload
  // before returning, and the bundle is fetched `no-store` every call, so a
  // check at this point could never fire. It read like a control and was not
  // one. The budget check before the wallet prompt is the real guard, and it
  // measures elapsed time since THIS fetch, which is a thing that can change.

  // Slippage is anchored to the quoted execution price, not the index — an
  // index-anchored bound fails at every size once impact is charged.
  const probe = quoteOpen({
    state, oracle, side, collateralUsd, notionalUsd,
    builderAddress: BUILDER_ADDRESS, collateralAssetId: COLLATERAL_ASSET_ID, slippageBps,
  });
  if (!probe.ok) {
    throw new Error(`The exchange will not accept this position: ${probe.reasons.join(", ")}`);
  }
  // ── What the screen said, against what is about to be signed ────────────
  //
  // The one check this module was premised on and did not perform. Both
  // references are Price12 bigints, so the comparison is exact arithmetic with
  // no Number round-trip at BTC magnitudes.
  const drift = (a: bigint, b: bigint): bigint => {
    if (b === BigInt(0)) return BigInt(0);
    const diff = a > b ? a - b : b - a;
    return (diff * BigInt(10_000)) / b;
  };
  const indexDrift = drift(oracle.indexPrice12, displayed.asRenderedIndexPrice12);
  const entryDrift = drift(probe.entryPrice12, displayed.asRenderedEntryPrice12);
  const liqDrift = drift(probe.liquidationPrice12, displayed.asRenderedLiquidationPrice12);
  if (indexDrift > BigInt(MAX_DISPLAY_DRIFT_BPS)
    || entryDrift > BigInt(MAX_ENTRY_DRIFT_BPS)
    || liqDrift > BigInt(MAX_LIQUIDATION_DRIFT_BPS)) {
    throw new Error(
      "The figures on screen are out of date — the market moved while this was being prepared. Nothing was sent; check the new numbers and try again.",
    );
  }

  const acceptablePrice = probe.acceptablePrice12;
  // A take-profit CLOSES the position, so its acceptable price sits on the
  // opposite side of the trigger from an open. See acceptableForClose.
  const tpAcceptable = acceptableForClose(takeProfitPrice12, side, slippageBps);

  // ── The take-profit must not already be crossed ──────────────────────────
  //
  // Checked HERE and not only in the card, for two reasons. The card's bounds
  // are computed from a snapshot up to a refresh cycle old, and the band moves;
  // and a bound is our arithmetic about PEX, whereas this is PEX's own answer.
  //
  // A crossed take-profit executes on arrival, so the position opens and closes
  // in one group: the user pays open fee, close fee, two builder fees, the
  // keeper fee and exit impact, and holds nothing. On $50 at 9.27x that is
  // about $1.58 — and the card had just promised a profit.
  const bounds = takeProfitBounds(probe);
  if (takeProfitPrice12 < bounds.minPrice12 || takeProfitPrice12 > bounds.maxPrice12) {
    throw new Error(
      "That take-profit price is no longer valid at the current market price. Check it and try again.",
    );
  }
  const crossCheck = quoteTakeProfitCrossed({
    state, oracle, side, owner: sender, notionalUsd,
    triggerPrice12: takeProfitPrice12,
    acceptablePrice12: tpAcceptable,
    keeperFeeMicro: micro(CHILD_KEEPER_FEE_USDC),
    collateralAssetId: COLLATERAL_ASSET_ID,
    builderAddress: BUILDER_ADDRESS,
  });
  if (crossCheck.blocking) {
    throw new Error(
      crossCheck.crossed
        ? "That take-profit would trigger immediately at the current price, closing the position as soon as it opened. Pick a target further away."
        : `The exchange will not accept that take-profit: ${crossCheck.reasons.join(", ")}`,
    );
  }

  stage("building");
  const sp = await algod.getTransactionParams().do();
  // **Pin the fee to the network minimum.**
  //
  // algod returns a per-byte `fee` suggestion that rises with congestion, and
  // the SDK multiplies it across every transaction. MainNet currently returns
  // `fee: 0, minFee: 1000`, so groups cost 51,000 microALGO and all is well —
  // but at a suggestion of 10,000 the same group builds at 8,388,000, i.e.
  // **8.4 ALGO**. The assertion would correctly refuse it, except that the user
  // would then read "Safety check failed, nothing was sent" — which sounds like
  // a security incident — and every open would be dead until congestion eased.
  //
  // Flat minimum fees, so MAX_GROUP_FEE_MICRO_ALGO stays a tripwire for a
  // construction bug rather than the thing that decides whether trading works.
  sp.fee = sp.minFee;
  sp.flatFee = true;
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

  // The payload has to survive the wallet round trip, not just reach it. Every
  // check above has cost time, and a signature over an expired price is
  // rejected on chain after the user has already approved it — the worst place
  // to find out. Fetching the oracle late (see above) buys the budget; this
  // spends it honestly.
  const budgetLeft = ORACLE_MAX_AGE_SEC - oracle.ageSeconds
    - (Date.now() - oracleFetchedAt) / 1000;
  if (budgetLeft < MIN_SIGNING_BUDGET_SEC) {
    throw new Error(
      "Preparing this took longer than the price is valid for. Nothing was sent — try again.",
    );
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
