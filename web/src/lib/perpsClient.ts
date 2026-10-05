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
import {
  buildV2MarketOpenWithAttachedOrdersTransactions,
  buildV2CancelOrderTransactions,
  buildV2DecreaseOrCloseTransactions,
  buildV2OpenOrIncreaseWithStorageTransactions,
  buildV2OpenLimitWithAttachedOrdersTransactions,
} from "@pdex/sdk/transactions";
import { V2_ORDER_KIND, V2_ORDER_TARGET } from "@pdex/sdk";
import {
  BUILDER_ADDRESS,
  CHILD_KEEPER_FEE_USDC,
  COLLATERAL_ASSET_ID,
  DEFAULT_SLIPPAGE_BPS,
  MAX_DISPLAY_DRIFT_BPS,
  MAX_ENTRY_DRIFT_BPS,
  MAX_LIQUIDATION_DRIFT_BPS,
  MAX_NET_COLLATERAL_DRIFT_BPS,
  ORACLE_MAX_AGE_SEC,
  PEX_APPS,
  POSITION_BUILDER_FEE_BPS,
  TAKE_PROFIT_TIME_IN_FORCE,
} from "./perps";
import {
  allocateBaseOrderId,
  orderLinkBaseOrderId,
  readOrders,
  assertBaseOrderIdFree,
  readMarketState,
  readPosition,
  readTraderState,
  readYieldRegistry,
  storagePaymentNeeded,
  type PositionState,
} from "./perpsReads";
import { getOraclePayload } from "./perpsOracle";
import { installProtocolManifest } from "./perpsManifest";
import { exitBlocked, preflight } from "./perpsPreflight";
import {
  assertCancelGroup,
  assertCloseGroup,
  assertOpenGroup,
  assertOpenLimitGroup,
  assertOpenWithAttachedOrders,
  ORDER_KIND_STOP_LOSS,
  ORDER_KIND_TAKE_PROFIT,
  type DisplayedLeg,
  simulateGroup,
  ORDER_BOX_MBR_MICRO_ALGO,
  SHAPE_OPEN,
  SHAPE_OPEN_STORAGE,
  type DisplayedLimit,
} from "./perpsGroup";
import {
  acceptableForClose,
  acceptableForOpen,
  quoteOpen,
  quoteProtectiveOrderCrossed,
  stopLossBounds,
  takeProfitBounds,
  type CloseQuote,
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
  /** Optional stop-loss trigger, Price12. Zero or absent means none. */
  stopLossPrice12?: bigint;
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
    /** "Backing the position" on the cost table, 1e6-scaled USD. */
    asRenderedNetCollateralMicro: bigint;
  };
  slippageBps?: number;
  onStage?: (s: OpenStage) => void;
};

/**
 * How the submission ended.
 *
 * `unknown` is not a failure — see the note at the confirmation step. `rejected`
 * is, definitively, and must be rendered as one.
 */
export type OpenOutcome = "confirmed" | "unknown" | "rejected";

/** Thrown when submission itself failed but the group may already be on chain. */
export class SubmissionUnknownError extends Error {
  constructor(readonly txId: string, readonly cause: string) {
    super(
      "The transaction was sent but the response was lost, so its outcome is unknown. Check the link before trying again — opening a second time would add to the position.",
    );
    this.name = "SubmissionUnknownError";
  }
}

export type OpenPositionResult = {
  txId: string;
  /** Prefer this over `confirmed`; it distinguishes rejected from unknown. */
  outcome: OpenOutcome;
  /** Node's reason, when there is one. For display on a rejection. */
  reason?: string;
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

/**
 * ALGO this group actually needs, given whether it also funds storage.
 *
 * The old flat 299,700 fitted neither case. Measured: 252,900 microALGO for a
 * first trade (100,200 escrow + 99,700 order-box MBR + 53,000 fees) and 150,700
 * for a funded trader (99,700 + 51,000). So it refused a repeat trader holding
 * 0.20 spendable ALGO — plenty — while telling them they need 0.30, and left
 * only 46,800 of margin in the case that needs the most.
 *
 * It also ran *before* the trader-state read that decides the storage payment,
 * so it could not have known which case it was in.
 */
/**
 * Headroom over the measured group fee — now per LEG.
 *
 * A flat 60,000 was sized for the one-leg group. A second leg adds about 17,000:
 * its OrderOps submit is 14,000, which is `V2_ORDER_OPS_METHOD_FLAT_FEE_MICRO_ALGO`
 * — a FLAT protocol fee, not a per-transaction minimum — plus its escrow, its MBR
 * payment and an extra Math carrier, since
 * `buildV2LinkedOrderMarketResourceCarrierCalls` emits two carriers once there is
 * more than one child order rather than one combined.
 *
 * Left flat, a two-leg group could clear this check and then be rejected by the
 * node for overspend: the user signs and the group dies for want of a few
 * thousand microALGO the check said they had.
 */
const groupFeeHeadroomMicro = (legs: number): bigint =>
  BigInt(60_000) + BigInt(Math.max(0, legs - 1)) * BigInt(20_000);
/**
 * The order-box MBR only applies when there IS an order — audit 8 MEDIUM 8.
 *
 * It was added unconditionally, so a funded repeat trader opening with no
 * take-profit was told *"Needs about 0.16 spendable ALGO"* against a real need of
 * ~0.034. Trade-blocking at the margin, and for a box the group never creates.
 */
// One order box per attached protective order, so this takes a COUNT. It took a
// boolean while take-profit was the only leg; a second leg is a second MBR.
const minAlgoMicro = (storagePayment: bigint, legs: number): bigint =>
  storagePayment + BigInt(legs) * ORDER_BOX_MBR_MICRO_ALGO
  + groupFeeHeadroomMicro(legs);

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
  const stopLossPrice12 = input.stopLossPrice12 ?? BigInt(0);
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
  /**
   * A take-profit is OPTIONAL now, and zero is how "none" is expressed.
   *
   * It used to be mandatory, because with no close path it was the only exit a
   * position had — leaving it off meant liquidation was the sole outcome. The
   * close path exists now, so a target is a choice again, which is what a
   * leveraged position being allowed to run requires.
   *
   * A NEGATIVE value is still refused: that is a broken caller, not a choice.
   */
  const wantsTakeProfit = takeProfitPrice12 > BigInt(0);
  if (takeProfitPrice12 < BigInt(0)) {
    throw new Error("That take-profit price is not valid.");
  }
  /**
   * A stop-loss is the same deal: optional, zero means none, negative is a
   * broken caller rather than a choice. It occupies the OTHER reserved slot —
   * `v2ExpectedLinkedChildOrderId` puts the take-profit at base+1 and the
   * stop-loss at base+2 — so the two never contend and either can ride alone.
   */
  const wantsStopLoss = stopLossPrice12 > BigInt(0);
  if (stopLossPrice12 < BigInt(0)) {
    throw new Error("That stop-loss price is not valid.");
  }
  /**
   * How many protective orders ride along: 0, 1 or 2.
   *
   * Every per-order cost keys off this rather than off "is there a take-profit"
   * — a second leg is a second keeper fee and a second order-box MBR, and the
   * disclosure understating that is precisely the regression audit 8 recorded
   * when the take-profit first became optional.
   */
  const legCount = (wantsTakeProfit ? 1 : 0) + (wantsStopLoss ? 1 : 0);
  /**
   * One protective leg at a time — see `PROTECTION_ENABLED`.
   *
   * Enforced HERE as well as in the card, because the card is advisory and this
   * is the control. The restriction is the flag's own precondition about OCO:
   * with a single leg there is no sibling to orphan, so the unobserved question
   * does not arise. Lift both together, not one.
   */
  if (legCount > 1) {
    throw new Error(
      "A take-profit and a stop-loss cannot be set on the same position yet. Choose one for now.",
    );
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
  // The ALGO check waits until the storage payment is known — see below.
  const algoSpendable = BigInt(account.amount) - BigInt(account.minBalance);
  const usdcHeld = (account.assets ?? []).find(
    (a: { assetId?: bigint | number }) => Number(a.assetId) === COLLATERAL_ASSET_ID,
  );
  if (!usdcHeld) throw new Error("This wallet does not hold USDC.");
  // The keeper fee is only escrowed when a take-profit is attached. Demanding it
  // unconditionally refused a wallet that held exactly enough. Audit 8 MEDIUM 8.
  const usdcNeeded = micro(collateralUsd)
    // One keeper fee per attached order, not per trade.
    + BigInt(legCount) * micro(CHILD_KEEPER_FEE_USDC);
  if (BigInt(usdcHeld.amount) < usdcNeeded) {
    throw new Error(wantsTakeProfit
      ? "Not enough USDC for the position plus its keeper fee."
      : "Not enough USDC for the position.");
  }

  // ── One position per (market, side) ──────────────────────────────────────
  // PEX keeps exactly one position per (market, collateral asset, side) and a
  // second open INCREASES it. We do not support increases: it is a second
  // economic path with its own quoting and assertion surface, and it is what
  // turns an unobserved confirmation into a doubled position. Refuse instead.
  //
  // This also makes `position: null` in the quote correct rather than merely
  // convenient — every open we permit really does start from nothing.
  // Both boxes in one round trip: the position guard, and the trader-state box
  // that decides whether this group must fund storage.
  const [existing, trader] = await Promise.all([
    readPosition(algod, sender, marketId, COLLATERAL_ASSET_ID, side === "long" ? 1 : 2),
    readTraderState(algod, sender),
  ]);
  if (existing && existing.size_usd > BigInt(0)) {
    throw new PositionAlreadyOpenError(existing.size_usd);
  }

  // ── Storage escrow ───────────────────────────────────────────────────────
  //
  // Trading asserts the caller's `t2:` box exists before it will open anything.
  // The group only creates that box when a storage payment leads it, so without
  // one a first-time trader dies in simulation at `pc=2907` — and since only
  // nineteen accounts on MainNet hold this box, that was **every real user**.
  //
  // The escrow is persistent and reusable: opening locks from it, closing
  // returns to it. So this tops it up only when short, which keeps the
  // nine-transaction group for anyone already funded rather than accumulating
  // idle ALGO in their escrow on every trade.
  const storagePayment = storagePaymentNeeded(trader);
  const fundsStorage = storagePayment > BigInt(0);

  // Now the ALGO requirement is knowable, so it can be both correct and honest.
  const algoNeeded = minAlgoMicro(storagePayment, legCount);
  if (algoSpendable < algoNeeded) {
    throw new Error(
      `Needs about ${(Number(algoNeeded) / 1e6).toFixed(2)} spendable ALGO${
        fundsStorage ? " — this is your first trade on PEX, which sets up an on-chain storage record" : ""
      }. You have ${(Number(algoSpendable) / 1e6).toFixed(2)}.`,
    );
  }

  stage("allocating");
  const alloc = await allocateBaseOrderId(algod, sender);
  if (!(await assertBaseOrderIdFree(algod, sender, alloc))) {
    throw new Error("Order id was taken while preparing. Try again.");
  }

  // ── The oracle payload, fetched as LATE as possible ─────────────────────
  //
  // PEX publishes every **2-3 seconds** — measured over 86 samples, not the
  // "~30 second cadence" this comment used to claim, which was wrong by an
  // order of magnitude and is the number anyone tuning the constants below
  // would have reasoned from. The 30 seconds is the payload's validity window,
  // not its cadence. ORACLE_MAX_AGE_SEC is 20 and
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
  // **Two separately targeted payloads, not one.**
  //
  // A signed oracle message binds the app it may be presented to. The entry call
  // goes to Trading; the attached take-profit goes to OrderOps. Reusing the
  // Trading payload on the child made OrderOps compare its own application id
  // against Trading's and fail at `pc=6359` — the second half of B6, and the
  // half our own assertion was enforcing rather than catching.
  const [oracle, childOracle] = await Promise.all([
    getOraclePayload(PEX_APPS.trading, marketId),
    getOraclePayload(PEX_APPS.orderOps, marketId),
  ]);
  if (!oracle.signatureVerified || !childOracle.signatureVerified) {
    throw new Error("The price could not be verified against PEX's signing key. Nothing was sent.");
  }
  // Both payloads must survive the same signing window, so the budget is
  // measured against whichever is older.
  const oracleAgeSeconds = Math.max(oracle.ageSeconds, childOracle.ageSeconds);
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
  /**
   * A zero reference means "the screen showed no value", not "no drift".
   *
   * PEX returns `liquidation_price_estimate = 0` when a position cannot be
   * liquidated, and the card correctly renders "None". Feeding that into
   * `drift` hit the zero-denominator branch and returned zero — disabling the
   * check rather than refusing an unverifiable comparison. Measured: 27% of
   * slider positions produce that sentinel, and on every one of them a
   * documented control was failing open.
   *
   * So: if the screen showed "None", the fresh probe must also say "None".
   */
  const sentinelMismatch = (fresh: bigint, shown: bigint) =>
    (shown === BigInt(0)) !== (fresh === BigInt(0));
  const indexDrift = drift(oracle.indexPrice12, displayed.asRenderedIndexPrice12);
  const entryDrift = drift(probe.entryPrice12, displayed.asRenderedEntryPrice12);
  const liqDrift = drift(probe.liquidationPrice12, displayed.asRenderedLiquidationPrice12);
  // `netCollateralUsd` is what actually backs the position, and it moves with
  // PEX's admin-mutable fee parameters. It was displayed ("Backing the
  // position") and never compared — and a fee change large enough to matter
  // moves the liquidation price by less than its own tolerance, so the guard
  // that could have noticed did not.
  const netDrift = drift(
    micro(probe.netCollateralUsd), displayed.asRenderedNetCollateralMicro,
  );
  if (indexDrift > BigInt(MAX_DISPLAY_DRIFT_BPS)
    || entryDrift > BigInt(MAX_ENTRY_DRIFT_BPS)
    || liqDrift > BigInt(MAX_LIQUIDATION_DRIFT_BPS)
    || netDrift > BigInt(MAX_NET_COLLATERAL_DRIFT_BPS)
    || sentinelMismatch(probe.liquidationPrice12, displayed.asRenderedLiquidationPrice12)) {
    throw new Error(
      "The figures on screen are out of date — the market moved while this was being prepared. Nothing was sent; check the new numbers and try again.",
    );
  }

  const acceptablePrice = probe.acceptablePrice12;
  // A take-profit CLOSES the position, so its acceptable price sits on the
  // opposite side of the trigger from an open. See acceptableForClose.
  const tpAcceptable = acceptableForClose(takeProfitPrice12, side, slippageBps);
  // A stop-loss closes too, so its acceptable price sits on the same side of its
  // own trigger as a take-profit's.
  const slAcceptable = wantsStopLoss
    ? acceptableForClose(stopLossPrice12, side, slippageBps) : BigInt(0);

  /**
   * ── A stop-loss must sit OUTSIDE the index band ──────────────────────────
   *
   * This compared the trigger to `oracle.indexPrice12` — a point. PEX does not:
   * `v2OrderCrossedByOracle` measures a `DECREASE_STOP_LOSS` against the band,
   * `indexMin <= trigger` for a long and `indexMax >= trigger` for a short. With
   * `indexMin <= indexPrice <= indexMax`, every long stop in
   * `[indexMin, indexPrice)` passed the point check and was crossed by PEX.
   *
   * A crossed stop executes on arrival: the position opens and closes in one
   * group and the user holds nothing, having paid both fees, both builder fees,
   * the keeper fee and exit impact — under a card that said the loss was capped.
   * The identical defect was measured for the take-profit at $1.58 on a $50
   * stake, and the guard this replaced claimed in its own comment to be that
   * guard's mirror while having neither the band nor PEX's answer.
   *
   * Both layers now, as the take-profit has: our bounds first, because they are
   * cheap and give a usable message, then PEX's own verdict.
   */
  if (wantsStopLoss) {
    const slBounds = stopLossBounds(probe);
    if (stopLossPrice12 < slBounds.minPrice12 || stopLossPrice12 > slBounds.maxPrice12) {
      throw new Error(
        side === "long"
          ? "That stop-loss is too close to the current price — it would trigger the moment the position opened, closing it straight away for a loss in fees. Move it further below."
          : "That stop-loss is too close to the current price — it would trigger the moment the position opened, closing it straight away for a loss in fees. Move it further above.",
      );
    }
    const slCross = quoteProtectiveOrderCrossed({
      orderKind: V2_ORDER_KIND.DECREASE_STOP_LOSS,
      state, oracle, side, owner: sender, notionalUsd,
      triggerPrice12: stopLossPrice12,
      acceptablePrice12: slAcceptable,
      keeperFeeMicro: micro(CHILD_KEEPER_FEE_USDC),
      collateralAssetId: COLLATERAL_ASSET_ID,
      builderAddress: BUILDER_ADDRESS,
    });
    if (slCross.blocking) {
      throw new Error(
        slCross.crossed
          ? "That stop-loss would trigger immediately at the current price, closing the position as soon as it opened. Move it further away."
          : `The exchange will not accept that stop-loss: ${slCross.reasons.join(", ")}`,
      );
    }
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

  /**
   * Two builders, one input.
   *
   * `buildV2OpenOrIncreaseWithStorageTransactions` is the bare open — no order
   * leg, so no keeper-fee transfer and no order-box MBR. It has always existed
   * and `SHAPE_OPEN` / `assertOpenGroup` were written for it; it simply had no
   * caller while a take-profit was mandatory.
   */
  const openInput = {
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
    // Omitted entirely when already funded — passing 0 is not the same as not
    // passing it, and only the omission yields the audited nine-txn shape.
    ...(fundsStorage ? { storagePaymentMicroAlgo: storagePayment } : {}),
    indexAssetId: Number(state.core.index_asset_id),
    longAssetId: Number(state.core.long_asset_id),
    shortAssetId: Number(state.core.short_asset_id),
    ...(wantsStopLoss ? { stopLoss: {
      triggerPrice: stopLossPrice12,
      acceptablePrice: slAcceptable,
      sizeUsdDelta: micro(notionalUsd),
      collateralAmount: BigInt(0),
      keeperFeeAssetId: COLLATERAL_ASSET_ID,
      keeperFeeAmount: keeperFee,
      outputSwapMode: BigInt(0),
      minPrimaryOutputAmount: BigInt(0),
      minSecondaryOutputAmount: BigInt(0),
      timeInForce: BigInt(TAKE_PROFIT_TIME_IN_FORCE),
      expiryTime: BigInt(0),
      // The same OrderOps-targeted payload the take-profit leg uses: both
      // children are submitted to OrderOps, so both are bound to that app.
      oracleMessage: childOracle.message,
      oracleSignature: childOracle.signature,
    } } : {}),
    ...(wantsTakeProfit ? { takeProfit: {
      triggerPrice: takeProfitPrice12,
      acceptablePrice: tpAcceptable,
      sizeUsdDelta: micro(notionalUsd),
      collateralAmount: BigInt(0),
      keeperFeeAssetId: COLLATERAL_ASSET_ID,
      keeperFeeAmount: keeperFee,
      outputSwapMode: BigInt(0),
      minPrimaryOutputAmount: BigInt(0),
      minSecondaryOutputAmount: BigInt(0),
      timeInForce: BigInt(TAKE_PROFIT_TIME_IN_FORCE),
      expiryTime: BigInt(0),
      // The child's OWN payload, bound to OrderOps. See the fetch above.
      oracleMessage: childOracle.message,
      oracleSignature: childOracle.signature,
    } } : {}),
    v2MathAppId: PEX_APPS.math,
    v2MarketsAppId: PEX_APPS.markets,
    v2TradingAppId: PEX_APPS.trading,
    v2TradingRiskOpsAppId: PEX_APPS.tradingRiskOps,
    v2OrderOpsAppId: PEX_APPS.orderOps,
    v2MarketXalgoYieldVaultAppId: PEX_APPS.marketXAlgoYieldVault,
    v2AdminControlAppId: PEX_APPS.adminControl,
  };
  const group = (legCount > 0
    ? buildV2MarketOpenWithAttachedOrdersTransactions(openInput as never, sp)
    : buildV2OpenOrIncreaseWithStorageTransactions(openInput as never, sp)) as unknown[];

  stage("checking");
  const shownOpen = {
    storagePaymentMicro: storagePayment,
    sender, marketId, side: (side === "long" ? 1 : 2) as 1 | 2,
    collateralAssetId: COLLATERAL_ASSET_ID,
    collateralAmountMicro: micro(collateralUsd),
    sizeUsdDeltaMicro: micro(notionalUsd),
    acceptablePrice12: acceptablePrice,
    executionPrice12: probe.executionPrice12,
    indexPrice12: oracle.indexPrice12,
    slippageBps,
    oracleMessage: oracle.message,
    oracleSignature: oracle.signature,
  };
  /**
   * One leg per attached order, each naming the slot its kind belongs in.
   *
   * The ORDER of this array does not matter — `assertOpenWithAttachedOrders`
   * locates each leg's escrow, MBR and submit call by that leg's own child order
   * id, never by position. That is the point of the rewrite: the single-leg
   * version found the escrow by elimination ("the transfer that is not the
   * collateral"), which with two legs would have checked one of them twice and
   * the other not at all.
   */
  const legs: DisplayedLeg[] = [
    ...(wantsTakeProfit ? [{
      orderKind: ORDER_KIND_TAKE_PROFIT,
      childOrderId: alloc.baseOrderId + BigInt(1),
      triggerPrice12: takeProfitPrice12,
      acceptablePrice12: tpAcceptable,
      sizeUsdDeltaMicro: micro(notionalUsd),
      keeperFeeMicro: keeperFee,
      baseOrderId: alloc.baseOrderId,
      slippageBps,
      oracleMessage: childOracle.message,
      oracleSignature: childOracle.signature,
    }] : []),
    ...(wantsStopLoss ? [{
      orderKind: ORDER_KIND_STOP_LOSS,
      childOrderId: alloc.baseOrderId + BigInt(2),
      triggerPrice12: stopLossPrice12,
      acceptablePrice12: slAcceptable,
      sizeUsdDeltaMicro: micro(notionalUsd),
      keeperFeeMicro: keeperFee,
      baseOrderId: alloc.baseOrderId,
      slippageBps,
      oracleMessage: childOracle.message,
      oracleSignature: childOracle.signature,
    }] : []),
  ];
  const assertion = legCount > 0
    ? assertOpenWithAttachedOrders(group, shownOpen, legs)
    // The bare open. SHAPE_OPEN was measured for exactly this group and has
    // been sitting unreachable since take-profit became mandatory.
    : assertOpenGroup(group, {
      storagePaymentMicro: storagePayment,
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
    }, storagePayment > BigInt(0) ? SHAPE_OPEN_STORAGE : SHAPE_OPEN);
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
    // Deliberately does not say "the exchange rejected this" — a simulation
    // failure can equally be our own harness (it was, for every rekeyed
    // account until `fixSigners` was set), and naming PEX for our defect sends
    // the user to the wrong place.
    throw new Error(`The pre-flight check did not pass, so nothing was sent: ${sim.message ?? "unknown"}`);
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
  const budgetLeft = ORACLE_MAX_AGE_SEC - oracleAgeSeconds
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
  // Computed BEFORE submission. A dropped socket or a timeout after the node
  // accepted the group used to reject out of `sendRawTransaction`, discarding
  // the id — so the user got "failed" with no link for a group that may well
  // have committed. That is B5 one call earlier, and nothing forces it: the id
  // is a property of the signed bytes, not of the response.
  const txId = txns[0].txID();
  try {
    await algod.sendRawTransaction(blobs).do();
  } catch (e) {
    throw new SubmissionUnknownError(txId, e instanceof Error ? e.message : String(e));
  }

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
  // **Three outcomes, not two.**
  //
  // `waitForConfirmation` throws for two structurally different things:
  // `Transaction Rejected: <poolError>`, where the node has definitively
  // refused the group, and `Transaction not confirmed after N rounds`, where
  // the answer is genuinely unknown. Collapsing both into `confirmed: false`
  // made the card tell a user whose transaction had been REJECTED that "this is
  // not a failure, it will most likely confirm, do not open again" — every
  // clause false, and it steers them away from the one correct action. That is
  // B5 inverted, and worse: B5 understated a success, this overstates a failure.
  let outcome: OpenOutcome = "unknown";
  let reason: string | undefined;
  try {
    await algosdk.waitForConfirmation(algod, txId, CONFIRM_ROUNDS);
    outcome = "confirmed";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/^Transaction Rejected:/i.test(msg)) {
      outcome = "rejected";
      reason = msg.replace(/^Transaction Rejected:\s*/i, "");
    } else {
      // A wait that runs out is NOT a failure. The group stays valid for the
      // rest of its window and will most likely commit; algod here is
      // load-balanced and the SDK swallows the 404s from polling a node other
      // than the one that accepted it.
      outcome = "unknown";
      reason = msg;
    }
  }

  return {
    txId, baseOrderId: alloc.baseOrderId, checks: assertion.checked,
    outcome, reason, confirmed: outcome === "confirmed",
  };
}

// ── Limit entries ───────────────────────────────────────────────────────────

export type OpenLimitInput = {
  algod: algosdk.Algodv2;
  signTransactions: SignFn;
  sender: string;
  marketId: number;
  side: Side;
  collateralUsd: number;
  notionalUsd: number;
  /** The price the order waits for, Price12, exactly as displayed. */
  triggerPrice12: bigint;
  /** Attached take-profit trigger, Price12. Optional — unlike a market open. */
  takeProfitPrice12?: bigint;
  slippageBps?: number;
  onStage?: (s: OpenStage) => void;
};

/**
 * Place a resting limit entry, optionally with a take-profit attached.
 *
 * ── How this differs from `openPosition`, and why there is no drift guard ───
 * A market open is checked against what the card rendered — entry price,
 * liquidation price, net collateral — because those are quoted numbers that
 * move between render and signature. A limit entry has none of them. Nothing is
 * quoted: the user picks a trigger, and the only prices in the group are that
 * trigger and the slippage bound derived from it. Both are the user's own
 * input, so there is nothing to drift AGAINST. Adding a guard here would be the
 * tautology audit 5 removed from the open path — comparing our numbers to our
 * own numbers and calling it verification.
 *
 * What replaces it is the assertion, which binds the built group to the trigger
 * the user chose, and the crossing refusal below.
 */
export async function openLimitOrder(input: OpenLimitInput): Promise<OpenPositionResult> {
  if (openInFlight) {
    throw new Error("An order is already in progress. Wait for it to finish.");
  }
  openInFlight = true;
  try {
    return await openLimitOrderInner(input);
  } finally {
    openInFlight = false;
  }
}

async function openLimitOrderInner(input: OpenLimitInput): Promise<OpenPositionResult> {
  const { algod, signTransactions, sender, marketId, side, collateralUsd, notionalUsd } = input;
  const slippageBps = input.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const stage = (s: OpenStage) => input.onStage?.(s);
  const sideCode: 1 | 2 = side === "long" ? 1 : 2;

  if (!BUILDER_ADDRESS) throw new Error("Builder address is not configured.");
  if (!Number.isFinite(collateralUsd) || !Number.isFinite(notionalUsd)
    || collateralUsd <= 0 || notionalUsd <= 0) {
    throw new Error("Enter an amount first.");
  }
  if (input.triggerPrice12 <= BigInt(0)) throw new Error("Set a trigger price first.");
  if (input.takeProfitPrice12 !== undefined && input.takeProfitPrice12 <= BigInt(0)) {
    throw new Error("The take-profit price is not valid.");
  }
  if (!Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new Error("Slippage tolerance is out of range.");
  }

  stage("preparing");
  await installProtocolManifest();

  const [state, account, pre] = await Promise.all([
    readMarketState(algod, marketId),
    algod.accountInformation(sender).do(),
    preflight(algod),
  ]);
  if (!pre.canOpen) {
    if (pre.detail) console.warn(`perps: preflight refused the limit order — ${pre.detail}`);
    throw new Error(pre.reason ?? "Trading is unavailable right now.");
  }

  const usdcHeld = (account.assets ?? []).find(
    (a: { assetId?: bigint | number }) => Number(a.assetId) === COLLATERAL_ASSET_ID,
  );
  if (!usdcHeld) throw new Error("This wallet does not hold USDC.");
  // A limit entry escrows BOTH in one transfer, and a take-profit adds a second
  // keeper fee of its own.
  const keeper = micro(CHILD_KEEPER_FEE_USDC);
  const usdcNeeded = micro(collateralUsd) + keeper
    + (input.takeProfitPrice12 !== undefined ? keeper : BigInt(0));
  if (BigInt(usdcHeld.amount) < usdcNeeded) {
    throw new Error("Not enough USDC for the order plus its keeper fee.");
  }

  const [existing, trader] = await Promise.all([
    readPosition(algod, sender, marketId, COLLATERAL_ASSET_ID, sideCode),
    readTraderState(algod, sender),
  ]);
  // Same rule as a market open: a fill on an existing position INCREASES it,
  // and increases are a separate economic path we do not support. Refusing at
  // placement is better than letting an order rest that would merge on fill.
  if (existing && existing.size_usd > BigInt(0)) {
    throw new PositionAlreadyOpenError(existing.size_usd);
  }

  /**
   * **Refused, not built.** The storage-funding shape is unverified here.
   *
   * A trader without a `t2:` box needs one funded before Trading will accept
   * anything, and the limit group's storage variant has never been simulated —
   * it would add a payment and very likely a Trading call, which is a shape
   * `assertOpenLimitGroup` does not know. Building it would either fail the
   * assertion on a correct group or, worse, pass an unchecked one.
   *
   * A market open funds the escrow, so the path out is real and cheap to state.
   */
  if (storagePaymentNeeded(trader) > BigInt(0)) {
    throw new Error(
      "Limit orders need a funded storage escrow on PEX. Open a position at market first — that funds it once, and limit orders work from then on.",
    );
  }

  stage("allocating");
  const alloc = await allocateBaseOrderId(algod, sender);
  if (!(await assertBaseOrderIdFree(algod, sender, alloc))) {
    throw new Error("Could not allocate an order id. Try again.");
  }

  // OrderOps-targeted, because EVERY leg of this group presents to OrderOps —
  // there is no Trading call at all. Reusing a Trading payload here is the same
  // defect as B6's second half, one flow over.
  const oracleFetchedAt = Date.now();
  const oracle = await getOraclePayload(PEX_APPS.orderOps, marketId);
  if (!oracle.signatureVerified) {
    throw new Error("The price could not be verified against PEX's signing key. Nothing was sent.");
  }

  /**
   * A limit that is already crossed is a worse market order. Refuse it.
   *
   * PEX accepts it — the child link mode becomes CHILD_ACTIVE and a keeper
   * fills it almost immediately — but the user pays a keeper fee and an order
   * box MBR for an execution the market button would have done in one group at
   * the same price. Routing to the better path is not blocking a valid trade.
   */
  const index = oracle.indexPrice12;
  const crossed = sideCode === 1 ? input.triggerPrice12 >= index : input.triggerPrice12 <= index;
  if (crossed) {
    throw new Error(
      side === "long"
        ? "That trigger is at or above the current price, so it would fill immediately. Use a market order, or set a lower trigger."
        : "That trigger is at or below the current price, so it would fill immediately. Use a market order, or set a higher trigger.",
    );
  }

  // Bounded against the TRIGGER, not the index — the order fills later, so the
  // index now says nothing about the fill. Matches the assertion exactly.
  const acceptablePrice = acceptableForOpen(input.triggerPrice12, side, slippageBps);
  const tpAcceptable = input.takeProfitPrice12 !== undefined
    ? acceptableForClose(input.takeProfitPrice12, side, slippageBps) : BigInt(0);

  stage("building");
  const sp = await algod.getTransactionParams().do();
  // Same pin as the market-open path — see HIGH 3 on the fee cap.
  sp.fee = sp.minFee;
  sp.flatFee = true;
  const stakeMicro = micro(collateralUsd);
  const sizeMicro = micro(notionalUsd);

  const built = buildV2OpenLimitWithAttachedOrdersTransactions({
    sender, marketId,
    collateralAssetId: COLLATERAL_ASSET_ID,
    side: BigInt(sideCode),
    collateralAmount: stakeMicro,
    sizeUsdDelta: sizeMicro,
    triggerPrice: input.triggerPrice12,
    acceptablePrice,
    keeperFeeAssetId: COLLATERAL_ASSET_ID,
    keeperFeeAmount: keeper,
    timeInForce: BigInt(TAKE_PROFIT_TIME_IN_FORCE),
    expiryTime: BigInt(0),
    outputSwapMode: BigInt(0),
    minPrimaryOutputAmount: BigInt(0),
    minSecondaryOutputAmount: BigInt(0),
    oracleMessage: oracle.message,
    oracleSignature: oracle.signature,
    builderFee: { builderAddress: BUILDER_ADDRESS, builderFeeBps: BigInt(POSITION_BUILDER_FEE_BPS) },
    baseOrderId: alloc.baseOrderId,
    targetKind: V2_ORDER_TARGET.PAIR,
    indexAssetId: Number(state.core.index_asset_id),
    longAssetId: Number(state.core.long_asset_id),
    shortAssetId: Number(state.core.short_asset_id),
    ...(input.takeProfitPrice12 !== undefined ? {
      takeProfit: {
        triggerPrice: input.takeProfitPrice12,
        acceptablePrice: tpAcceptable,
        sizeUsdDelta: sizeMicro,
        collateralAmount: BigInt(0),
        keeperFeeAssetId: COLLATERAL_ASSET_ID,
        keeperFeeAmount: keeper,
        outputSwapMode: BigInt(0),
        minPrimaryOutputAmount: BigInt(0),
        minSecondaryOutputAmount: BigInt(0),
        timeInForce: BigInt(TAKE_PROFIT_TIME_IN_FORCE),
        expiryTime: BigInt(0),
        oracleMessage: oracle.message,
        oracleSignature: oracle.signature,
      },
    } : {}),
    v2MathAppId: PEX_APPS.math,
    v2MarketsAppId: PEX_APPS.markets,
    v2TradingAppId: PEX_APPS.trading,
    v2TradingRiskOpsAppId: PEX_APPS.tradingRiskOps,
    v2OrderOpsAppId: PEX_APPS.orderOps,
    v2MarketXalgoYieldVaultAppId: PEX_APPS.marketXAlgoYieldVault,
    v2AdminControlAppId: PEX_APPS.adminControl,
  } as never, sp) as algosdk.Transaction[];

  /**
   * Declare the two sibling order boxes the SDK leaves out.
   *
   * Measured on MainNet: the built group declares `o2:` for the BASE order
   * only, while the contract touches `base + 1` and `base + 2` — the slots
   * `ORDER_ID_STRIDE` reserves. Un-patched, the group dies at the OrderOps call
   * with `invalid Box reference`, with or without a take-profit attached.
   *
   * **This is not fixable by simulating with `allowUnnamedResources`.**
   * Simulation would auto-fill the reference and report ok; a real submission
   * has no such auto-fill and would fail on chain. That flag is a diagnostic,
   * never a remedy — using it here would manufacture a green pre-flight on the
   * one check standing between a group and a wallet.
   */
  const carrier = built.find((t) => t.type === "appl"
    && (t.applicationCall?.boxes ?? []).some((b) => Number(b.appIndex) === PEX_APPS.orderOps));
  if (!carrier) throw new Error("Could not prepare the order group. Nothing was sent.");
  const call = carrier.applicationCall!;
  const boxes = [...(call.boxes ?? [])].filter((b) => b.name.length > 0);
  for (const extra of [alloc.baseOrderId + BigInt(1), alloc.baseOrderId + BigInt(2)]) {
    boxes.push({
      appIndex: BigInt(PEX_APPS.orderOps),
      name: new Uint8Array([
        ...new TextEncoder().encode("o2:"),
        ...algosdk.decodeAddress(sender).publicKey,
        ...algosdk.encodeUint64(extra),
      ]),
    });
  }
  (call as unknown as { boxes: unknown[] }).boxes = boxes;
  // Mutating after the SDK grouped these invalidates the group id, and algod
  // rejects the whole group as incomplete. Re-assign over the final bytes.
  for (const t of built) (t as unknown as { group?: Uint8Array }).group = undefined;
  algosdk.assignGroupID(built);

  stage("checking");
  const shown: DisplayedLimit = {
    sender, marketId, side: sideCode,
    collateralAssetId: COLLATERAL_ASSET_ID,
    collateralAmountMicro: stakeMicro,
    sizeUsdDeltaMicro: sizeMicro,
    triggerPrice12: input.triggerPrice12,
    acceptablePrice12: acceptablePrice,
    keeperFeeMicro: keeper,
    baseOrderId: alloc.baseOrderId,
    slippageBps,
    oracleMessage: oracle.message,
    oracleSignature: oracle.signature,
  };
  const assertion = assertOpenLimitGroup(built, shown,
    input.takeProfitPrice12 !== undefined ? {
      triggerPrice12: input.takeProfitPrice12,
      acceptablePrice12: tpAcceptable,
      sizeUsdDeltaMicro: sizeMicro,
      keeperFeeMicro: keeper,
      baseOrderId: alloc.baseOrderId,
      slippageBps,
      oracleMessage: oracle.message,
      oracleSignature: oracle.signature,
    } : undefined);
  if (!assertion.ok) {
    console.error("perps: limit group assertion failed", assertion.findings);
    throw new Error(
      `Safety check failed, so nothing was sent: ${assertion.findings[0]?.detail ?? "unknown"}`,
    );
  }

  stage("simulating");
  const sim = await simulateGroup(algod, built);
  if (!sim.ok) {
    throw new Error(`The pre-flight check did not pass, so nothing was sent: ${sim.message ?? "unknown"}`);
  }

  const budgetLeft = ORACLE_MAX_AGE_SEC - oracle.ageSeconds
    - (Date.now() - oracleFetchedAt) / 1000;
  if (budgetLeft < MIN_SIGNING_BUDGET_SEC) {
    throw new Error("Preparing this took longer than the price is valid for. Nothing was sent — try again.");
  }

  stage("signing");
  const signed = await signTransactions(built.map((t) => algosdk.encodeUnsignedTransaction(t)));
  const blobs = signed.filter((s): s is Uint8Array => !!s);
  if (blobs.length !== built.length) throw new Error("Signing cancelled.");

  stage("submitting");
  const txId = built[0].txID();
  try {
    await algod.sendRawTransaction(blobs).do();
  } catch (e) {
    throw new SubmissionUnknownError(txId, e instanceof Error ? e.message : String(e));
  }

  stage("confirming");
  let outcome: OpenOutcome = "unknown";
  let reason: string | undefined;
  try {
    await algosdk.waitForConfirmation(algod, txId, CONFIRM_ROUNDS);
    outcome = "confirmed";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/^Transaction Rejected:/i.test(msg)) {
      outcome = "rejected";
      reason = msg.replace(/^Transaction Rejected:\s*/i, "");
    } else {
      outcome = "unknown";
      reason = msg;
    }
  }
  return {
    txId, baseOrderId: alloc.baseOrderId, checks: assertion.checked,
    outcome, reason, confirmed: outcome === "confirmed",
  };
}

// ── Cancelling ──────────────────────────────────────────────────────────────

export type CancelOrderInput = {
  algod: algosdk.Algodv2;
  signTransactions: SignFn;
  sender: string;
  /** The order the user clicked on. */
  ownerOrderId: bigint;
  /** Its attached children, so their boxes are released in the same call. */
  attachedOrderIds?: bigint[];
  /**
   * True when this order is a bracket PARENT — i.e. a limit entry.
   *
   * Decides whether the reserved sibling slots are declared. See the stride note
   * in the body; getting this wrong is the difference between a cancel that
   * works and one that dies on a box reference.
   */
  isBracketParent?: boolean;
  onStage?: (s: OpenStage) => void;
};

/**
 * Cancel a resting order and release everything it holds.
 *
 * ── Why this is the smallest write path, and still asserted ─────────────────
 * It moves nothing out of the wallet: the stake, the keeper fee and the
 * order-box MBR all come BACK, as inner transactions. Measured on chain by
 * pairing one submit against its own cancel — 10.124513 USDC and 100,200
 * µALGO out, the identical amounts back, the only cost being ~34,000 µALGO of
 * network fees across both groups. Across 127 historical cancels every one
 * refunded, and the ALGO figure always matched what that order had paid.
 *
 * So the rule to rely on is **"refunds what it took"**, not a constant: our
 * attached take-profit pays 99,700 for its box while a limit entry pays
 * 100,200, and each is refunded its own amount.
 *
 * It is still asserted, because a cancel prompt is the most harmless-looking
 * signature this product asks for and therefore the best place to hide
 * something. See `assertCancelGroup`.
 */
export async function cancelOrder(input: CancelOrderInput): Promise<OpenPositionResult> {
  const { algod, signTransactions, sender, ownerOrderId } = input;
  /**
   * A bracket parent's cancel must declare its whole reserved STRIDE, whether
   * or not children exist.
   *
   * ── Found by a real cancel failing, 2026-10-04 ──────────────────────────────
   * A limit entry with no take-profit was placed and then could not be
   * cancelled: `invalid Box reference o2:…0000000000000002`, at
   * `concat; dup; box_len`. `cancel_order` on a bracket parent PROBES both child
   * slots to clean them up, and a box reference must be DECLARED even for a box
   * that does not exist — `box_len` on an undeclared key is the error above, not
   * a zero.
   *
   * The UI derived the children from orders it could see, found none, and
   * declared none. Confirmed by simulation: no children declared → fails on
   * slot 2; declare slot 2 only → fails on slot 3; declare both → ok.
   *
   * **This is the third time the reserved stride has caused a defect** — the
   * limit SUBMIT path needed the same two references added by hand, for the same
   * reason. `ORDER_ID_STRIDE` is 3 and the contract touches all three slots, so
   * the rule is the stride, never the observed children.
   *
   * A standalone or child reduce order probes nothing, and declaring extra
   * references there would only widen what `assertCancelGroup` permits, so the
   * caller says which kind this is.
   */
  const attachedOrderIds = input.isBracketParent
    ? [ownerOrderId + BigInt(1), ownerOrderId + BigInt(2)]
    : (input.attachedOrderIds ?? []);

  /**
   * Refuse if a reserved slot holds an order that is NOT this one's child.
   *
   * ── Why this is needed, and only for accounts that already exist ──────────
   * `allocateBaseOrderId` now steps by the stride, so no NEW allocation can land
   * inside a live bracket's reservation. But ids already on chain were handed
   * out by the old `highest + 1` rule, which could: a bare limit order creates
   * box N alone while reserving {N, N+1, N+2}, so the next allocation took N+1.
   *
   * For those accounts the stride declaration above names a box belonging to an
   * unrelated live order, and `assertCancelGroup` cannot catch it — N+1 is
   * legitimately inside the stride it was told to expect. Review of audit 9
   * (HIGH 2) pointed out that the forward fix does nothing for them, and it is
   * right: this is the part that does.
   *
   * The check is an ownership question, not an id question, so it reads the link
   * the protocol itself uses: a child's `flags` word packs its parent's id, and
   * `orderLinkBaseOrderId` mirrors the SDK's own accessor. A slot that is empty
   * is fine and must still be declared — the contract probes it either way, which
   * is the whole reason the stride is declared at all.
   *
   * Refusing is the conservative end. The alternative is submitting a group that
   * asks `cancel_order` to clean up a box the user still wants, and the cost of
   * being wrong in that direction is someone else's resting order.
   */
  if (input.isBracketParent) {
    const siblings = await readOrders(algod, sender);
    const bySlot = new Map(siblings.map((o) => [String(o.owner_order_id), o]));
    for (const slot of attachedOrderIds) {
      const occupant = bySlot.get(String(slot));
      if (!occupant) continue;
      const parent = orderLinkBaseOrderId(occupant);
      if (parent !== ownerOrderId) {
        throw new Error(
          `This order cannot be cancelled safely: order ${slot} sits in its reserved range but belongs to `
          + `${parent === BigInt(0) ? "no bracket" : `order ${parent}`}. Cancelling would ask the exchange to `
          + `clean up an order you did not choose. Cancel order ${slot} first, or contact us.`,
        );
      }
    }
  }
  const stage = (s: OpenStage) => input.onStage?.(s);
  if (ownerOrderId <= BigInt(0)) throw new Error("That order id is not valid.");

  stage("preparing");
  await installProtocolManifest();

  /**
   * Cancelling consults the preflight too — audit 8 HIGH 6.
   *
   * It did not, while opening and closing both did. In a drift state that let a
   * user remove their take-profit but not close, leaving liquidation as the only
   * remaining exit. Whatever the gate is, the write paths have to agree on it.
   */
  const pre = await preflight(algod);
  // Same narrow set as closing, and for the same reason — a cancel group moves
  // nothing at all, so our treasury's opt-in and the leverage ceiling are
  // irrelevant to it.
  if (exitBlocked(pre.kind)) {
    if (pre.detail) console.warn(`perps: preflight refused the cancel — ${pre.detail}`);
    throw new Error(pre.reason ?? "Trading is unavailable right now.");
  }

  stage("building");
  const sp = await algod.getTransactionParams().do();
  // Pinned to the network minimum, for the reason `openPositionInner` gives:
  // algod's suggestion scales with congestion, and a fee is not where this
  // product should surprise anyone. Audit 8 HIGH 3.
  sp.fee = sp.minFee;
  sp.flatFee = true;
  const built = buildV2CancelOrderTransactions({
    sender,
    ownerOrderId,
    collateralAssetId: COLLATERAL_ASSET_ID,
    keeperFeeAssetId: COLLATERAL_ASSET_ID,
    // Named so their boxes are in the call's reference set; without this a
    // bracket parent cannot release its children and their escrow stays locked.
    ...(attachedOrderIds[0] !== undefined ? { attachedTakeProfitOrderId: attachedOrderIds[0] } : {}),
    ...(attachedOrderIds[1] !== undefined ? { attachedStopLossOrderId: attachedOrderIds[1] } : {}),
    v2OrderOpsAppId: PEX_APPS.orderOps,
    v2MathAppId: PEX_APPS.math,
    v2MarketsAppId: PEX_APPS.markets,
    v2TradingAppId: PEX_APPS.trading,
    v2TradingRiskOpsAppId: PEX_APPS.tradingRiskOps,
    v2AdminControlAppId: PEX_APPS.adminControl,
  } as never, sp) as algosdk.Transaction[];

  stage("checking");
  const assertion = assertCancelGroup(built, {
    sender, ownerOrderId, attachedOrderIds, collateralAssetId: COLLATERAL_ASSET_ID,
  });
  if (!assertion.ok) {
    console.error("perps: cancel assertion failed", assertion.findings);
    throw new Error(`Safety check failed, so nothing was sent: ${assertion.findings[0]?.detail ?? "unknown"}`);
  }

  stage("simulating");
  const sim = await simulateGroup(algod, built);
  if (!sim.ok) {
    // The common case is a genuinely benign race: the keeper executed the order
    // between the panel rendering it and the click. Say that rather than
    // presenting a contract assert to someone who cancelled a button.
    throw new Error(
      `This order could not be cancelled — it may have just executed or already been cancelled. Nothing was sent. (${sim.message ?? "unknown"})`,
    );
  }

  stage("signing");
  const signed = await signTransactions(built.map((t) => algosdk.encodeUnsignedTransaction(t)));
  const blobs = signed.filter((s): s is Uint8Array => !!s);
  if (blobs.length !== built.length) throw new Error("Signing cancelled.");

  stage("submitting");
  const txId = built[0].txID();
  try {
    await algod.sendRawTransaction(blobs).do();
  } catch (e) {
    throw new SubmissionUnknownError(txId, e instanceof Error ? e.message : String(e));
  }

  stage("confirming");
  let outcome: OpenOutcome = "unknown";
  let reason: string | undefined;
  try {
    await algosdk.waitForConfirmation(algod, txId, CONFIRM_ROUNDS);
    outcome = "confirmed";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/^Transaction Rejected:/i.test(msg)) {
      outcome = "rejected";
      reason = msg.replace(/^Transaction Rejected:\s*/i, "");
    } else {
      outcome = "unknown";
      reason = msg;
    }
  }
  return {
    txId, baseOrderId: ownerOrderId, checks: assertion.checked,
    outcome, reason, confirmed: outcome === "confirmed",
  };
}

// ── Closing ─────────────────────────────────────────────────────────────────

export type ClosePositionInput = {
  algod: algosdk.Algodv2;
  signTransactions: SignFn;
  sender: string;
  marketId: number;
  side: Side;
  /** How much to close, 1e6 USD. Must equal the position size for a full close. */
  sizeUsdMicro: bigint;
  /** The live position, read immediately before this call. */
  position: PositionState;
  /** The close quote the user was shown — its execution price anchors slippage. */
  quote: CloseQuote;
  slippageBps?: number;
  onStage?: (s: OpenStage) => void;
};

/**
 * Close a position, or part of one.
 *
 * ── Why this needs a yield recall, always ───────────────────────────────────
 * Ultrade, 2026-09-29: *"generally speaking, I would suggest always using
 * recall because most of the time the yield deployment doesn't leave much idle
 * assets."* Simulation agrees more bluntly — `yieldRecallMode: 0` builds fine
 * and then fails at `inner tx 0` on a live position. The no-recall path is not
 * an option even when it looks like one.
 *
 * ── Why the registry is read rather than fetched ────────────────────────────
 * The SDK's supported route calls Ultrade's API for the recall inputs. We build
 * the same thing from chain instead — see `readYieldRegistry`, which documents
 * where each value comes from and why the proposer list is the hard part.
 *
 * ── The acceptable price is anchored to EXECUTION ───────────────────────────
 * Same discipline as the open path, and the same reason B2 taught: an
 * index-anchored bound fails once impact is charged. The quote's
 * `executionPrice12` is the anchor, and `assertCloseGroup` re-checks it.
 */
export async function closePosition(input: ClosePositionInput): Promise<OpenPositionResult> {
  if (openInFlight) throw new Error("Another action is already in progress. Wait for it to finish.");
  openInFlight = true;
  try {
    return await closePositionInner(input);
  } finally {
    openInFlight = false;
  }
}

async function closePositionInner(input: ClosePositionInput): Promise<OpenPositionResult> {
  const { algod, signTransactions, sender, marketId, side, position, quote } = input;
  const slippageBps = input.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const stage = (s: OpenStage) => input.onStage?.(s);
  const sideCode: 1 | 2 = side === "long" ? 1 : 2;

  if (!BUILDER_ADDRESS) throw new Error("Builder address is not configured.");
  if (input.sizeUsdMicro <= BigInt(0)) throw new Error("Nothing to close.");
  if (input.sizeUsdMicro > position.size_usd) {
    throw new Error("That is larger than the position.");
  }
  if (!quote.ok) {
    throw new Error(`PEX would not accept this close right now: ${quote.blockedReason || "unknown"}`);
  }

  stage("preparing");
  await installProtocolManifest();

  const [state, pre] = await Promise.all([readMarketState(algod, marketId), preflight(algod)]);
  // Not `!pre.canOpen`: only the kinds that actually affect an exit. A drifted
  // or unreachable chain means we would be guessing at the ABI, which is no
  // safer because the user is trying to get out — but our own builder-address
  // configuration and the leverage ceiling have nothing to do with closing, and
  // blocking escrow recovery on them would be a self-inflicted trap. See
  // `EXIT_BLOCKS`.
  if (exitBlocked(pre.kind)) {
    if (pre.detail) console.warn(`perps: preflight refused the close — ${pre.detail}`);
    throw new Error(pre.reason ?? "Trading is unavailable right now.");
  }

  // Re-read rather than trusting the panel's copy: a position that moved, was
  // liquidated, or had its take-profit fire between render and click must not
  // be closed against stale numbers.
  const live = await readPosition(algod, sender, marketId, COLLATERAL_ASSET_ID, sideCode);
  if (!live || live.size_usd === BigInt(0)) {
    throw new Error("That position is no longer open — it may have just closed or been liquidated.");
  }
  if (live.position_id !== position.position_id) {
    throw new Error("That position has been replaced since the page loaded. Refresh and try again.");
  }
  // Narrowed into a const because the build/check helpers below close over it,
  // and TypeScript cannot carry a null-check across a function boundary.
  const livePos = live;
  const sizeToClose = input.sizeUsdMicro > livePos.size_usd ? livePos.size_usd : input.sizeUsdMicro;

  stage("building");
  const oracleFetchedAt = Date.now();
  const oracle = await getOraclePayload(PEX_APPS.trading, marketId);
  if (!oracle.signatureVerified) {
    throw new Error("The price could not be verified against PEX's signing key. Nothing was sent.");
  }
  const indexAssetId = Number(state.core.index_asset_id);
  const longAssetId = Number(state.core.long_asset_id);
  const shortAssetId = Number(state.core.short_asset_id);
  const registry = await readYieldRegistry(algod, marketId, COLLATERAL_ASSET_ID, indexAssetId);

  /**
   * Recall caps, from our own close quote.
   *
   * `quoteClose` aggregates what this close pays out per asset, and a recall must
   * make at least that much available.
   *
   * **A unit note, because the comment used to overstate this.** These args are
   * RECEIPT-token caps (xALGO, fUSDC) and the outputs are denominated in the
   * UNDERLYING. Lending receipts appreciate against underlying, so the cap comes
   * out generous rather than tight. That is safe in the only direction it can be
   * — a cap is a maximum, and all 11 live closes pass with it — but calling it
   * "the tight, honest choice" was describing a number in the wrong unit.
   */
  const capFor = (assetId: number) =>
    quote.outputs.find((o) => o.assetId === assetId)?.amount ?? BigInt(0);

  /**
   * Two recall shapes, tightest first.
   *
   * Recalling BOTH legs pulls the Folks pool, its manager and their addresses
   * into the group's reference budget, and on larger positions that is enough
   * to squeeze the xALGO vault out — simulation then fails with
   * `unavailable App 3690309169` inside Trading. Recalling only the index leg
   * fits, and it matches what PEX's own keeper did when it executed our
   * take-profit: that group touched the consensus app and never Folks, because
   * the collateral leg had idle balance to pay from.
   *
   * So: try the tighter shape, fall back to the fuller one. Both are asserted
   * and simulated before anything reaches a wallet, so the fallback costs a
   * round trip and risks nothing — and attempting the collateral recall only
   * when the tight shape fails means we ask the pool for no more than needed.
   */
  const recallShapes: { label: string; long: bigint; short: bigint }[] = [
    { label: "index leg only", long: capFor(longAssetId), short: BigInt(0) },
    { label: "both legs", long: capFor(longAssetId), short: capFor(shortAssetId) },
  ];

  const acceptablePrice = acceptableForClose(quote.executionPrice12, side, slippageBps);
  const sp = await algod.getTransactionParams().do();
  // The close path needs the same pin as the other three: algod's suggestion
  // scales with congestion, and the close fee cap is the only thing between a
  // congested network and a multi-ALGO group. Audit 8 HIGH 3.
  sp.fee = sp.minFee;
  sp.flatFee = true;

  let built: algosdk.Transaction[] | null = null;
  let assertion: ReturnType<typeof assertCloseGroup> | null = null;
  let lastProblem = "";
  for (const shape of recallShapes) {
    const candidate = buildCloseGroup(shape.long, shape.short);
    const check = checkCloseGroup(candidate, shape.long, shape.short);
    if (!check.ok) {
      lastProblem = `safety check: ${check.findings[0]?.detail ?? "unknown"}`;
      console.warn(`perps: close (${shape.label}) failed the assertion`, check.findings);
      continue;
    }
    stage("simulating");
    const trial = await simulateGroup(algod, candidate);
    if (trial.ok) { built = candidate; assertion = check; break; }
    lastProblem = trial.message ?? "unknown";
  }
  if (!built || !assertion) {
    throw new Error(`The pre-flight check did not pass, so nothing was sent: ${lastProblem}`);
  }

  function buildCloseGroup(longCap: bigint, shortCap: bigint) {
    return buildV2DecreaseOrCloseTransactions({
    sender, marketId,
    collateralAssetId: COLLATERAL_ASSET_ID,
    side: BigInt(sideCode),
    sizeUsdDelta: sizeToClose,
    acceptablePrice,
    outputSwapMode: 0,
    minPrimaryOutputAmount: 0,
    minSecondaryOutputAmount: 0,
    builderFee: { builderAddress: BUILDER_ADDRESS, builderFeeBps: BigInt(POSITION_BUILDER_FEE_BPS) },
    oracleMessage: oracle.message,
    oracleSignature: oracle.signature,
    yieldRecallMode: 1,
    maxLongReceiptAmount: longCap,
    maxShortReceiptAmount: shortCap,
    marketYieldRegistry: registry,
    // The real id, never a wildcard: a wildcard closes whatever occupies the key.
    expectedPositionId: livePos.position_id,
    indexAssetId, longAssetId, shortAssetId,
    v2MathAppId: PEX_APPS.math,
    v2MarketsAppId: PEX_APPS.markets,
    v2TradingAppId: PEX_APPS.trading,
    v2TradingRiskOpsAppId: PEX_APPS.tradingRiskOps,
    v2OrderOpsAppId: PEX_APPS.orderOps,
      v2MarketXalgoYieldVaultAppId: PEX_APPS.marketXAlgoYieldVault,
      v2AdminControlAppId: PEX_APPS.adminControl,
    } as never, sp) as algosdk.Transaction[];
  }

  // No `as never` here, deliberately. An earlier draft cast this and the cast
  // silently swallowed five missing fields — including the recall mode and caps,
  // which are exactly what this assertion exists to check on a close. A cast
  // that hides a missing argument to a safety check is worse than no check.
  function checkCloseGroup(group: algosdk.Transaction[], longCap: bigint, shortCap: bigint) {
    stage("checking");
    return assertCloseGroup(group, {
    sender, marketId, side: sideCode,
    collateralAssetId: COLLATERAL_ASSET_ID,
    sizeUsdDeltaMicro: sizeToClose,
    positionSizeUsdMicro: livePos.size_usd,
    fullClose: sizeToClose === livePos.size_usd,
    acceptablePrice12: acceptablePrice,
    executionPrice12: quote.executionPrice12,
    indexPrice12: oracle.indexPrice12,
    slippageBps,
    expectedPositionId: livePos.position_id,
    oracleMessage: oracle.message,
    oracleSignature: oracle.signature,
    yieldRecallMode: BigInt(1),
    maxLongReceiptAmount: longCap,
    maxShortReceiptAmount: shortCap,
    recall: registry.recall,
    });
  }

  const budgetLeft = ORACLE_MAX_AGE_SEC - oracle.ageSeconds - (Date.now() - oracleFetchedAt) / 1000;
  if (budgetLeft < MIN_SIGNING_BUDGET_SEC) {
    throw new Error("Preparing this took longer than the price is valid for. Nothing was sent — try again.");
  }

  stage("signing");
  const signed = await signTransactions(built.map((t) => algosdk.encodeUnsignedTransaction(t)));
  const blobs = signed.filter((s): s is Uint8Array => !!s);
  if (blobs.length !== built.length) throw new Error("Signing cancelled.");

  stage("submitting");
  const txId = built[0].txID();
  try {
    await algod.sendRawTransaction(blobs).do();
  } catch (e) {
    throw new SubmissionUnknownError(txId, e instanceof Error ? e.message : String(e));
  }

  stage("confirming");
  let outcome: OpenOutcome = "unknown";
  let reason: string | undefined;
  try {
    await algosdk.waitForConfirmation(algod, txId, CONFIRM_ROUNDS);
    outcome = "confirmed";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/^Transaction Rejected:/i.test(msg)) {
      outcome = "rejected";
      reason = msg.replace(/^Transaction Rejected:\s*/i, "");
    } else {
      outcome = "unknown";
      reason = msg;
    }
  }
  return {
    txId, baseOrderId: livePos.position_id, checks: assertion.checked,
    outcome, reason, confirmed: outcome === "confirmed",
  };
}
