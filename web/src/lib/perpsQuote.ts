// Perps — quoting.
//
// The solver (perpsSolver.ts) decides what the risk bar can offer. This module
// decides what the chain will actually accept, by asking the SDK's own quote.
// Nothing here reimplements PEX's maths: the closed form is a pre-filter so the
// bar can render without a round trip, and everything shown as a committed
// number comes from quoteV2OpenPosition.
//
// ── Slippage is anchored to the execution price, not the index ───────────────
// Price impact is charged BEFORE the slippage test, and on ALGO/USD it is a flat
// 55 bps. An index-anchored acceptablePrice at a 50 bps tolerance therefore fails
// at every size — the whole side is unopenable, which renders as a bar where
// every point rejects. So we quote once permissively to learn the execution
// price, then anchor the user's tolerance to that, and surface impact as its own
// cost line rather than silently eating the tolerance with it.

import { quoteV2DecreasePosition, quoteV2LiquidationPrice, quoteV2OpenPosition } from "@pdex/sdk";
import { quoteV2DecreaseOrder } from "@pdex/sdk";
import { V2_ORDER_KIND } from "@pdex/sdk";
import {
  CROSS_MARGIN_BPS,
  DEFAULT_SLIPPAGE_BPS,
  MAX_QUICK_PICK_MOVE_BPS,
  MAX_TAKE_PROFIT_MULTIPLE,
  PEX_APPS,
  POSITION_BUILDER_FEE_BPS,
} from "./perps";
import { USD_SCALE, type MarketFunding, type MarketState } from "./perpsReads";
import type { OraclePayload } from "./perpsOracle";
import { solveBar, steppedCeilingUsd, type Side } from "./perpsSolver";

const SIDE_CODE: Record<Side, bigint> = { long: BigInt(1), short: BigInt(2) };

export type OpenQuote = {
  ok: boolean;
  reasons: string[];
  side: Side;
  collateralUsd: number;
  notionalUsd: number;
  leverage: number;
  entryPrice12: bigint;
  executionPrice12: bigint;
  indexPrice12: bigint;
  /**
   * The signed oracle's index band, carried through because **PEX measures
   * whether an order is crossed against this band, not against the entry
   * price**. Only the midpoint used to survive the quote, which is why
   * `takeProfitBounds` was checking the wrong reference entirely.
   */
  indexMinPrice12: bigint;
  indexMaxPrice12: bigint;
  acceptablePrice12: bigint;
  liquidationPrice12: bigint;
  liquidationDirection: string;
  /** PEX's open fee, in dollars. */
  openFeeUsd: number;
  /** Our builder fee, in dollars. Deducted FROM collateral, charged again at close. */
  builderFeeUsd: number;
  /** Signed: positive means impact worked in the user's favour. */
  impactUsd: number;
  /** Collateral left backing the position after every deduction. */
  netCollateralUsd: number;
  effectiveInitialMarginBps: number;
  /** The SDK's own record, for anything the card does not model. */
  raw: Record<string, unknown>;
};

/** One asset leaving the position on a close, aggregated by asset. */
export type CloseOutput = { assetId: number; amount: bigint };

export type CloseQuote = {
  ok: boolean;
  reasons: string[];
  /** PEX's own words when it refuses, which are not always in `reasons`. */
  blockedReason: string;
  side: Side;
  executionPrice12: bigint;
  acceptablePrice12: bigint;
  /**
   * What the user actually receives, by asset.
   *
   * **A close is not a single-asset payout.** On ALGO/USD a long returns its
   * collateral in USDC and its profit in ALGO — measured live: 5.567172 USDC
   * plus 15.72 ALGO on one position. Reporting one dollar figure hid the second
   * leg entirely.
   */
  outputs: CloseOutput[];
  /**
   * Those outputs valued in USD, for a headline.
   *
   * Null when an output is in an asset we cannot price — better to show the
   * per-asset amounts than to invent a total.
   */
  payoutUsd: number | null;
  pnlUsd: number;
  closeFeeUsd: number;
  builderFeeUsd: number;
  /** Gross accrued funding cost, unsigned. Not what settled — see `fundingNetUsd`. */
  fundingFeeUsd: number;
  borrowingFeeUsd: number;
  /** Funding and borrowing as settled into collateral. Positive = paid to you. */
  fundingNetUsd: number;
  impactUsd: number;
  liquidatable: boolean;
  raw: Record<string, unknown>;
};

const toUsd = (v: unknown): number => Number(v ?? 0) / Number(USD_SCALE);
const big = (v: unknown): bigint => BigInt(String(v ?? 0));

/**
 * Flatten the four state boxes into the single record the SDK quote expects.
 *
 * The SDK takes market metadata as one flat object; on chain it is split across
 * m2:, ma2:, mr2:, mp2:, mo2: and doi:. Order matters only in that every key is
 * distinct — and ma2: is required, not optional: without opposing_trader_share_bps
 * the cost quote throws instead of returning a failure.
 */
export function marketRecord(state: MarketState): Record<string, bigint> {
  return { ...state.core, ...state.adaptive, ...state.risk, ...state.oi, ...state.doi };
}

/**
 * Price input built from the SIGNED oracle bytes.
 *
 * The collateral leg is USDC, whose price the payload also carries; using a
 * hardcoded $1 here would quietly misprice a depeg.
 */
export function priceInput(oracle: OraclePayload): Record<string, bigint> {
  const d = oracle.decoded;
  return {
    index_price: oracle.indexPrice12,
    index_price_min: d.indexMinPrice,
    index_price_max: d.indexMaxPrice,
    long_price: (d.longMinPrice + d.longMaxPrice) / BigInt(2),
    long_price_min: d.longMinPrice,
    long_price_max: d.longMaxPrice,
    short_price: (d.shortMinPrice + d.shortMaxPrice) / BigInt(2),
    short_price_min: d.shortMinPrice,
    short_price_max: d.shortMaxPrice,
  };
}

/**
 * Acceptable price for an **opening** order.
 *
 * A long pays up to X more; a short receives down to X less. This is the wrong
 * helper for a take-profit — see `acceptableForClose`, and read the note there
 * before using either.
 */
export function acceptableFromExecution(executionPrice12: bigint, side: Side, slippageBps: number): bigint {
  const bps = BigInt(Math.round(slippageBps));
  const ten_k = BigInt(10_000);
  return side === "long"
    ? (executionPrice12 * (ten_k + bps)) / ten_k
    : (executionPrice12 * (ten_k - bps)) / ten_k;
}

function shape(
  raw: Record<string, unknown>, side: Side, collateralUsd: number, oracle: OraclePayload,
): OpenQuote {
  const notionalUsd = toUsd(raw.size_usd_delta);
  return {
    ok: Boolean(raw.ok),
    reasons: ((raw.failure_reasons as string[]) ?? []).slice(),
    side,
    collateralUsd,
    notionalUsd,
    leverage: collateralUsd > 0 ? notionalUsd / collateralUsd : 0,
    entryPrice12: big(raw.position_entry_price_after),
    executionPrice12: big(raw.execution_price),
    indexPrice12: big(raw.index_price),
    indexMinPrice12: oracle.decoded.indexMinPrice,
    indexMaxPrice12: oracle.decoded.indexMaxPrice,
    acceptablePrice12: big(raw.acceptable_price),
    liquidationPrice12: big(raw.liquidation_price_estimate),
    liquidationDirection: String(raw.liquidation_price_direction ?? ""),
    openFeeUsd: toUsd(raw.platform_fee_amount),
    builderFeeUsd: toUsd(raw.builder_fee_paid),
    impactUsd: toUsd(raw.impact_positive_usd) - toUsd(raw.impact_negative_usd),
    netCollateralUsd: toUsd(raw.position_collateral_after),
    effectiveInitialMarginBps: Number(raw.effective_initial_margin_bps ?? 0),
    raw,
  };
}

/**
 * Acceptable price for a **closing** order — a take-profit or a stop.
 *
 * The direction inverts, and getting it wrong is silent until the SDK refuses
 * the whole group. Closing a long means SELLING, so the worst price accepted is
 * BELOW the trigger; closing a short means buying, so it is above. The contract
 * enforces this: `v2OrderPriceCoherenceFailure` rejects a
 * `DECREASE_TAKE_PROFIT` whose acceptable price sits above the trigger for a
 * long, or below it for a short.
 *
 * This existed only as `acceptableFromExecution` for a while, and the take-profit
 * leg called it — which made every group unbuildable, on both markets and both
 * sides, for as long as that code existed. It is a separate named function so the
 * open/close distinction is visible at the call site rather than carried in the
 * caller's head.
 */
export function acceptableForClose(triggerPrice12: bigint, side: Side, slippageBps: number): bigint {
  const bps = BigInt(Math.round(slippageBps));
  const ten_k = BigInt(10_000);
  return side === "long"
    ? (triggerPrice12 * (ten_k - bps)) / ten_k   // selling: accept down to trigger - slip
    : (triggerPrice12 * (ten_k + bps)) / ten_k;  // buying:  accept up to trigger + slip
}

/**
 * The worst price a limit ENTRY will accept, from its trigger.
 *
 * The exact mirror of `acceptableForClose`, and a separate named function for
 * the same reason that one is: the open/close distinction has already made
 * every group in this codebase unbuildable once, when a close-side helper was
 * used on an open leg. Naming it at the call site is the control.
 *
 * Opening a long BUYS, so it accepts paying up to `trigger + slip`; opening a
 * short SELLS, so it accepts receiving down to `trigger - slip`. That is the
 * opposite of the close case on both sides.
 *
 * **Anchored to the trigger, never the index.** A limit order fills at some
 * future moment, so the index at submission says nothing about the fill; using
 * it would let the bound sit arbitrarily far from the price the user chose.
 */
export function acceptableForOpen(triggerPrice12: bigint, side: Side, slippageBps: number): bigint {
  const bps = BigInt(Math.round(slippageBps));
  const ten_k = BigInt(10_000);
  return side === "long"
    ? (triggerPrice12 * (ten_k + bps)) / ten_k   // buying:  accept up to trigger + slip
    : (triggerPrice12 * (ten_k - bps)) / ten_k;  // selling: accept down to trigger - slip
}

export type QuoteInput = {
  state: MarketState;
  oracle: OraclePayload;
  side: Side;
  collateralUsd: number;
  notionalUsd: number;
  builderAddress: string;
  collateralAssetId: number;
  slippageBps?: number;
  builderFeeBps?: number;
};

/**
 * Quote one open, with slippage anchored to the quoted execution price.
 *
 * Two passes deliberately. The first is permissive purely to learn where this
 * size would execute; the second is the real quote at the real acceptable price
 * and is the only one whose result is returned.
 */
export function quoteOpen(input: QuoteInput): OpenQuote {
  const { state, oracle, side, collateralUsd, notionalUsd } = input;
  const market = marketRecord(state);
  const pool = { ...state.pool };
  const prices = priceInput(oracle);
  const sideCode = SIDE_CODE[side];
  const collateralAmount = BigInt(Math.round(collateralUsd * Number(USD_SCALE)));
  const sizeUsdDelta = BigInt(Math.round(notionalUsd * Number(USD_SCALE)));
  const builderFee = {
    builderAddress: input.builderAddress,
    builderFeeBps: BigInt(input.builderFeeBps ?? POSITION_BUILDER_FEE_BPS),
  };
  const base = {
    market, pool, prices, position: null,
    collateralAssetId: BigInt(input.collateralAssetId),
    side: sideCode, collateralAmount, sizeUsdDelta, builderFee,
  };

  // Pass 1 — permissive bound, used only to read execution_price back out.
  const permissive = side === "long" ? oracle.indexPrice12 * BigInt(1000) : BigInt(1);
  const probe = quoteV2OpenPosition({ ...base, acceptablePrice: permissive }) as unknown as Record<string, unknown>;
  const executionPrice12 = big(probe.execution_price) || oracle.indexPrice12;

  // Pass 2 — the real quote.
  const acceptablePrice = acceptableFromExecution(
    executionPrice12, side, input.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
  );
  const real = quoteV2OpenPosition({ ...base, acceptablePrice }) as unknown as Record<string, unknown>;
  return shape(real, side, collateralUsd, oracle);
}

/**
 * The ceiling the UI may actually offer.
 *
 * The closed form is conservative but not exhaustive — position_quantization and
 * impact_consumes_size sit on this path and are not modelled — so the solved
 * ceiling is confirmed by a real quote before the right end of the bar is
 * enabled. On rejection it steps down rather than giving up, because the gap is
 * cents and a user who typed a round number should not be told "no".
 *
 * Returns null when nothing on the bar opens; the caller renders the side closed.
 */
/**
 * PEX's rejection reasons that are about the MARKET's current capacity rather
 * than about the position being asked for.
 *
 * `checkOiAfter` and `checkReservesAfterTrade` push these, and both are called
 * only from `quoteV2OpenPosition` — so they answer "can this open right now",
 * which is not the question a resting limit order asks.
 */
const CAPACITY_REASONS = new Set([
  "long_oi_cap", "short_oi_cap",
  "long_reserves_exceeded", "short_reserves_exceeded",
]);

/**
 * A quote that failed ONLY because the market has no room right now.
 *
 * Its numbers are still real — entry price, liquidation price and direction are
 * all computed before the capacity test runs, and were verified populated on a
 * forced `long_oi_cap`. The only untrue thing about such a quote is that the
 * position could open *this instant*, which is precisely the thing a resting
 * limit order does not claim.
 *
 * Audit 10 HIGH 3: `solveBar` and `confirmCeiling` were taught to ignore
 * capacity for a limit order and the card's display quote was not, so the bar
 * widened, the ceiling widened, and then `canSubmit` — which requires
 * `quote.ok` — refused every size the bar had just offered. Dead button, no
 * explanation, under a banner saying the order could be placed. The loosening
 * has to reach every layer or it is worse than not loosening at all.
 */
export const capacityOnlyFailure = (q: OpenQuote | null | undefined): boolean =>
  !!q && !q.ok && q.reasons.length > 0 && q.reasons.every((r) => CAPACITY_REASONS.has(r));

export function confirmCeiling(
  input: Omit<QuoteInput, "notionalUsd">,
  opts: { maxSteps?: number; marketCapacityApplies?: boolean } = {},
): { notionalUsd: number; quote: OpenQuote } | null {
  const maxSteps = opts.maxSteps ?? 12;
  const capacityApplies = opts.marketCapacityApplies ?? true;
  /**
   * In limit mode a quote that fails ONLY on capacity is acceptable.
   *
   * Relaxing `solveBar` alone is not enough: this function confirms its ceiling
   * with `quoteOpen`, which is `quoteV2OpenPosition` and applies the very caps
   * the bar just stopped applying. Without this the bar would widen and every
   * candidate would then be rejected, leaving the ceiling pinned at the floor —
   * the same wrong answer by a longer route.
   *
   * Everything else the quote checks still binds, which is the point: margin,
   * leverage, minimum size and fee coverage are properties of the position and
   * are as true at fill time as now.
   */
  const acceptable = (q: OpenQuote): boolean =>
    q.ok || (!capacityApplies && q.reasons.length > 0 && q.reasons.every((r) => CAPACITY_REASONS.has(r)));
  const d = input.oracle.decoded;
  const bar = solveBar(input.state, input.side, input.collateralUsd, input.oracle.indexPrice12, {
    builderFeeBps: input.builderFeeBps,
    marketCapacityApplies: capacityApplies,
    prices: {
      indexPrice12: input.oracle.indexPrice12,
      longPrice12: (d.longMinPrice + d.longMaxPrice) / BigInt(2),
      shortPrice12: (d.shortMinPrice + d.shortMaxPrice) / BigInt(2),
    },
  });
  if (!bar.open) return null;

  let candidate = steppedCeilingUsd(bar);
  const floor = bar.minNotionalUsd;
  // Geometric back-off between the stepped ceiling and the floor. Linear steps
  // would spend every attempt in the top 1% where the rejection actually is.
  for (let i = 0; i < maxSteps && candidate >= floor; i++) {
    const quote = quoteOpen({ ...input, notionalUsd: candidate });
    if (acceptable(quote)) return { notionalUsd: candidate, quote };
    candidate = floor + (candidate - floor) * 0.7;
  }
  const last = quoteOpen({ ...input, notionalUsd: floor });
  return acceptable(last) ? { notionalUsd: floor, quote: last } : null;
}

/**
 * Payoff at an exit price, in dollars, before exit costs.
 *
 * Deliberately simple and deliberately labelled: this is the number on the card
 * next to a take-profit price. It does NOT include the close fee, the second
 * builder fee, funding or borrowing — those are separate lines, because folding
 * them in here would make the headline number unfalsifiable against the chain.
 */
export function payoffAtPrice(quote: OpenQuote, exitPrice12: bigint): number {
  if (quote.entryPrice12 === BigInt(0)) return 0;
  const entry = Number(quote.entryPrice12);
  const exit = Number(exitPrice12);
  const move = (exit - entry) / entry;
  return quote.notionalUsd * (quote.side === "long" ? move : -move);
}

/**
 * Largest profit this position can reach, in dollars.
 *
 * A short is bounded: price cannot go below zero, so the most it can make is its
 * notional. A long is unbounded. Take-profit is MANDATORY in this product, so a
 * target the position can never reach has to be refused at the input rather than
 * accepted and left to never trigger.
 */
export function maxPayoffUsd(quote: OpenQuote): number {
  return quote.side === "short" ? quote.notionalUsd : Number.POSITIVE_INFINITY;
}

/**
 * Valid take-profit prices, Price12.
 *
 * ── The near edge: crossing ──────────────────────────────────────────────────
 * This used to sit at `entryPrice12 ± 1`, on the reasoning that a take-profit
 * just has to be on the profitable side of entry. **PEX does not measure
 * crossing against entry — it measures against the signed oracle's index
 * band.** When impact is favourable a long's entry lands *below* `indexMin`,
 * and every target in the gap between them was accepted by the card while
 * `quoteV2DecreaseOrder` reported `crossed: true`.
 *
 * A crossed take-profit executes immediately, so the position opens and closes
 * in the same breath. Measured on live ALGO/USD: entry $0.116635848681 against
 * `indexMin` $0.116855, a 0.188% window. On $50 of collateral at 9.27x that is
 * open fee + close fee + two builder fees + keeper fee + exit impact — about
 * **$1.58, 3.2% of the stake, and no position** — under a card that read
 * "Closes for $0.87 profit before costs".
 *
 * So the near edge is the *far* side of the band plus `CROSS_MARGIN_BPS`. Using
 * the far side is deliberately conservative: the measured boundary is the near
 * side, and the only thing the extra width costs is a target sitting almost
 * exactly at the current price — which is precisely the target most likely to
 * cross between quoting and signing anyway.
 *
 * ── The far edge: typos ──────────────────────────────────────────────────────
 * Symmetric, and a guard against a misplaced decimal rather than a claim about
 * reachability. A short's floor was `1n` — $0.000000000001 — on the reasoning
 * that `maxPayoffUsd` already bounds a short at zero. That bounds the *payoff*,
 * not the *reachability*: on a live $134.86 short the card accepted that target
 * and printed "Closes for $134.86 profit before costs", and a one-decimal typo
 * printed $121.38. Take-profit is mandatory here precisely so a position
 * closes, and there is no close UI and no stop-loss, so an unreachable target
 * leaves the position with no exit but liquidation.
 *
 * The typo edge is **exclusive**, which matters more than it looks. A slipped
 * decimal point is exactly a factor of ten, and `MAX_TAKE_PROFIT_MULTIPLE` is
 * ten — so an inclusive bound accepts precisely the most likely typo and
 * rejects only the ones nobody makes. Measured: `$8,429` for `$84,290` landed
 * exactly on the floor and validated.
 */
export function takeProfitBounds(quote: OpenQuote): { minPrice12: bigint; maxPrice12: bigint } {
  const tenK = BigInt(10_000);
  const margin = BigInt(Math.round(CROSS_MARGIN_BPS));
  const mult = BigInt(MAX_TAKE_PROFIT_MULTIPLE);
  return quote.side === "long"
    ? {
        minPrice12: (quote.indexMaxPrice12 * (tenK + margin)) / tenK,
        maxPrice12: quote.entryPrice12 * mult - BigInt(1),
      }
    : {
        minPrice12: quote.entryPrice12 / mult + BigInt(1),
        maxPrice12: (quote.indexMinPrice12 * (tenK - margin)) / tenK,
      };
}

/**
 * The band a stop-loss trigger must sit outside.
 *
 * ── Why this is not a comparison against the index price ───────────────────
 * The first version of the stop-loss guard compared the trigger to
 * `oracle.indexPrice12`. PEX does not: `v2OrderCrossedByOracle` measures a
 * `DECREASE_STOP_LOSS` against the signed oracle's index BAND —
 *
 *     crossed = side === LONG ? indexMin <= trigger : indexMax >= trigger
 *
 * and `indexMin <= indexPrice <= indexMax`. So every long stop in
 * `[indexMin, indexPrice)` and every short stop in `(indexPrice, indexMax]`
 * passed the point comparison and was reported crossed by PEX. A crossed stop
 * executes on arrival: the position opens and closes in the same group, and the
 * user pays open fee, close fee, two builder fees, the keeper fee and exit
 * impact for nothing.
 *
 * This codebase has already measured that exact failure for the take-profit —
 * see `takeProfitBounds` above: a 0.188% window on live ALGO/USD, **$1.58 on a
 * $50 stake, 3.2%, and no position**. The stop-loss reproduced it, under a
 * comment claiming to be that guard's mirror.
 *
 * So the edge is the binding band edge moved outward by `CROSS_MARGIN_BPS`,
 * the same margin and the same conservatism.
 */
export function stopLossBounds(quote: OpenQuote): { minPrice12: bigint; maxPrice12: bigint } {
  const tenK = BigInt(10_000);
  const margin = BigInt(Math.round(CROSS_MARGIN_BPS));
  return quote.side === "long"
    // Below the LOWER edge: PEX crosses a long stop at indexMin and above.
    ? { minPrice12: BigInt(1), maxPrice12: (quote.indexMinPrice12 * (tenK - margin)) / tenK }
    // Above the UPPER edge: PEX crosses a short stop at indexMax and below.
    : { minPrice12: (quote.indexMaxPrice12 * (tenK + margin)) / tenK, maxPrice12: BigInt(2) ** BigInt(63) };
}

/**
 * Quote closing a position, in full or in part.
 *
 * ── Two things this needs that an open does not ─────────────────────────────
 *
 * **`mf2:` (funding and borrowing).** Without it `quoteV2DecreasePosition`
 * *throws* `funding factor regression` rather than returning a failure.
 * Confirmed against a live $5.50 ALGO position: without `mf2:` it throws, with
 * it the quote returns `ok: true`. This is why the close preview could not be
 * built until `readMarketFunding` existed. Opens never need it, because we
 * permit one position per market and side and so every open starts from nothing.
 *
 * **Execution anchoring.** Same discipline as `quoteOpen`, and for the same
 * reason B2 taught us: an acceptable price anchored to the index fails once
 * impact is charged. Measured — an index-anchored close quote on a live position
 * returned `ok: false` where the execution-anchored one returns `ok: true`. So
 * the first pass is permissive purely to learn where this size would execute,
 * and the second is the real quote.
 */
/**
 * Where an OPEN position gets liquidated, from PEX's own solver.
 *
 * The chart's liquidation line used to come from the card's prospective quote —
 * the order being composed in the form, not the position actually held. With an
 * empty form there was no quote and the line simply vanished, which is why
 * entry and liquidation disappeared from the chart on every page refresh and
 * came back only once something was typed into the collateral field.
 *
 * A position's liquidation price is not ours to derive. `quoteV2LiquidationPrice`
 * binary-searches `quoteV2PositionHealth` for the boundary, accounting for
 * funding and borrowing accrued since entry — none of which a
 * `collateral / size` approximation knows about. Two components computing a
 * liquidation price separately is how they come to disagree, and disagreeing
 * about a liquidation price is not a cosmetic failure.
 *
 * Returns null rather than a zero on any refusal: the SDK answers
 * `non_monotonic_liquidation_boundary` when the search finds no clean crossing,
 * and a zero drawn on a chart is a line at the bottom of the axis claiming the
 * position is safe all the way down.
 *
 * `current_liquidatable` is carried, NOT discarded. The SDK flips its search
 * direction on it (`searchUp = (side === SHORT) !== anchorLiquidatable`), so for
 * a position that is ALREADY liquidatable this returns the highest price that is
 * still liquidatable — a level ABOVE the index on a long, still labelled
 * `at_or_below`. Drawn unconditionally that is a solid red "Your liquidation"
 * line sitting in the profit direction while the position can be closed out now.
 * Audit 11 HIGH 3.
 *
 * NOTE the result keys differ from the open quote's. This one returns
 * `liquidation_price` and `direction`; `quoteV2OpenPosition` returns
 * `liquidation_price_estimate` and `liquidation_price_direction`. Reading the
 * open quote's names here yields undefined, which `big()` turns into a
 * confident 0n.
 */
export function quoteLiquidationPrice(input: {
  state: MarketState;
  /** From `readMarketFunding`. The health solve needs it, as the close quote does. */
  funding: MarketFunding;
  position: Record<string, bigint>;
  oracle: OraclePayload;
  side: Side;
  collateralAssetId: number;
}): { price12: bigint; direction: string; liquidatableNow: boolean } | null {
  let raw: Record<string, unknown>;
  try {
    raw = quoteV2LiquidationPrice({
      market: { ...marketRecord(input.state), ...input.funding },
      pool: { ...input.state.pool },
      position: input.position,
      collateralAssetId: BigInt(input.collateralAssetId),
      side: SIDE_CODE[input.side],
      prices: priceInput(input.oracle),
    } as never) as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!raw.ok) return null;
  const price12 = big(raw.liquidation_price);
  const direction = String(raw.direction ?? "");
  if (price12 <= BigInt(0) || direction === "") return null;
  return { price12, direction, liquidatableNow: Boolean(raw.current_liquidatable) };
}

export function quoteClose(input: {
  state: MarketState;
  /** From `readMarketFunding`. Not optional — the SDK throws without it. */
  funding: MarketFunding;
  position: Record<string, bigint>;
  oracle: OraclePayload;
  side: Side;
  owner: string;
  /** How much of the position to close, 1e6-scaled USD. */
  sizeUsdMicro: bigint;
  collateralAssetId: number;
  builderAddress: string;
  slippageBps?: number;
  builderFeeBps?: number;
  /**
   * ALGO's price in USD, Price12 — from market 1's signed payload.
   *
   * Only needed when ALGO is not this market's index asset, which is market 2.
   * Without it a BTC position cannot show what closing returns. Audit 8 MEDIUM 7.
   */
  algoPrice12?: bigint;
}): CloseQuote {
  const slippageBps = input.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const base = {
    market: { ...marketRecord(input.state), ...input.funding },
    pool: { ...input.state.pool },
    position: input.position,
    owner: input.owner,
    marketId: BigInt(input.state.marketId),
    collateralAssetId: BigInt(input.collateralAssetId),
    side: SIDE_CODE[input.side],
    sizeUsdDelta: input.sizeUsdMicro,
    prices: priceInput(input.oracle),
    builderFee: {
      builderAddress: input.builderAddress,
      builderFeeBps: BigInt(input.builderFeeBps ?? POSITION_BUILDER_FEE_BPS),
    },
  };

  // Pass 1 — permissive, read execution_price back out. Closing a long SELLS,
  // so the permissive bound is the lowest possible price; a short BUYS, so it is
  // the highest. This is the mirror of quoteOpen's probe.
  const permissive = input.side === "long" ? BigInt(1) : input.oracle.indexPrice12 * BigInt(1000);
  const probe = quoteV2DecreasePosition(
    { ...base, acceptablePrice: permissive } as never,
  ) as unknown as Record<string, unknown>;
  const executionPrice12 = big(probe.execution_price) || input.oracle.indexPrice12;

  // Pass 2 — the real quote, anchored to where it actually executes.
  const acceptablePrice12 = acceptableForClose(executionPrice12, input.side, slippageBps);
  const raw = quoteV2DecreasePosition(
    { ...base, acceptablePrice: acceptablePrice12 } as never,
  ) as unknown as Record<string, unknown>;

  const outputs = aggregateCloseOutputs(raw, input.state.core);
  const payoutUsd = valueCloseOutputs(outputs, {
    collateralAssetId: input.collateralAssetId,
    indexAssetId: Number(input.state.core.index_asset_id),
    indexPrice12: input.oracle.indexPrice12,
    // Passed through so a BTC close, which pays out in ALGO, can be valued —
    // see the field's note. Optional, so a caller without it keeps the old
    // withhold-rather-than-guess behaviour.
    algoPrice12: input.algoPrice12,
  });

  return {
    ok: Boolean(raw.ok),
    reasons: ((raw.failure_reasons as string[]) ?? []).slice(),
    blockedReason: String(raw.blocked_reason ?? ""),
    side: input.side,
    executionPrice12: big(raw.execution_price),
    acceptablePrice12,
    outputs,
    payoutUsd,
    /** Signed: PEX reports profit and loss separately. */
    pnlUsd: toUsd(raw.effective_profit_usd) - toUsd(raw.loss_usd),
    closeFeeUsd: toUsd(raw.close_fee_usd ?? raw.platform_fee_amount),
    builderFeeUsd: toUsd(raw.builder_fee_paid),
    /**
     * Funding as a **gross accrued cost**, and never the settlement.
     *
     * `settledPosition` computes it from
     * `max(0n, fundingFee - funding_fee_per_size_snapshot_milli_bps)`, so it is
     * non-negative by construction. Rendering it as "what funding cost you" was
     * wrong on 5 of 8 live positions, where funding had in fact been CREDITED.
     * Use `fundingNetUsd` for anything a user reads.
     */
    fundingFeeUsd: toUsd(raw.funding_fee_collateral_amount),
    borrowingFeeUsd: toUsd(raw.borrowing_fee_collateral_amount),
    /**
     * Funding and borrowing as actually settled into collateral. **Signed.**
     *
     * `collateralIncrease - collateralDecrease` in the SDK's `settledPosition`:
     * positive means funding paid the trader, negative means it charged them.
     * The claimable funding owed TO a position can exceed its accrued cost —
     * which is why longs credit more often than shorts, and why the gross field
     * above disagrees with the chain on exactly those.
     *
     * Verified against the WHOLE live population, 9 of 9 positions on
     * 2026-09-29: this equals `collateral_delta - collateral_amount` exactly.
     */
    fundingNetUsd: toUsd(raw.collateral_funding_net_amount),
    impactUsd: toUsd(raw.impact_positive_usd) - toUsd(raw.impact_negative_usd),
    liquidatable: Boolean(raw.liquidatable),
    raw,
  };
}

/**
 * How many decimals the card shows for a price of this magnitude.
 *
 * **The single source of truth for price precision.** It lives here, next to
 * the bounds, rather than in the card, because having the rule in one place and
 * the bound in another is exactly how H2 happened: the card printed a bound
 * rounded to whole dollars and then refused that number, because validation
 * compared against the unrounded value. On BTC the crossing bound is never an
 * integer, so a long's floor was unreachable essentially always — and
 * take-profit is mandatory, so there was no way past the screen.
 */
export function priceDisplayDecimals(usd: number): number {
  return usd >= 1000 ? 0 : usd >= 1 ? 2 : 6;
}

/**
 * A price, formatted exactly as the card prints it.
 *
 * Lives here so a test can call the function the product calls. The round trip
 * that matters — bound -> printed -> retyped -> validated — is only meaningful
 * if the test formats the way the screen formats, and the last two audits both
 * turned up defects that escaped precisely because a harness reimplemented what
 * production did instead of calling it.
 */
export function formatPriceUsd(usd: number): string {
  const d = priceDisplayDecimals(usd);
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

/**
 * The take-profit bounds **as the card prints and enforces them**.
 *
 * Each edge is rounded OUTWARD — a floor up, a ceiling down — to the precision
 * it will be displayed at, so the number on screen is by construction a number
 * the card accepts. A user who is told "choose a target above $84,868" can type
 * $84,868.
 *
 * These are strictly tighter than `takeProfitBounds`, never looser, so anything
 * the card accepts the write path also accepts. The write path deliberately
 * keeps using the true bounds: it is guarding against a real crossing, not
 * against a rounding artefact, and it should not inherit a display concern.
 */
export function displayTakeProfitBounds(quote: OpenQuote): { minPrice12: bigint; maxPrice12: bigint } {
  const t = takeProfitBounds(quote);
  return {
    minPrice12: roundPrice12(t.minPrice12, "up"),
    maxPrice12: roundPrice12(t.maxPrice12, "down"),
  };
}

/** Round a Price12 to its displayed precision, in the named direction. */
export function roundPrice12(p12: bigint, direction: "up" | "down"): bigint {
  const decimals = priceDisplayDecimals(Number(p12) / 1e12);
  // Price12 carries 12 decimals; keeping `decimals` of them means quantising to
  // this unit. bigint throughout — at BTC magnitudes Price12 exceeds
  // MAX_SAFE_INTEGER, and only the magnitude test above touches Number.
  const unit = BigInt(10) ** BigInt(12 - decimals);
  if (unit <= BigInt(1)) return p12;
  const down = (p12 / unit) * unit;
  if (direction === "down") return down;
  return down === p12 ? p12 : down + unit;
}

/**
 * Ask PEX itself whether a take-profit would execute on arrival.
 *
 * `takeProfitBounds` is the cheap pre-filter the card renders against; this is
 * the authority, and the write path refuses on it. Bounds are computed from the
 * band we hold, but the band moves — a target that was clear when the card
 * quoted it can cross by the time the group is built, which is exactly the
 * window `CROSS_MARGIN_BPS` is sized for and exactly why the check has to run
 * again immediately before signing rather than only in the UI.
 *
 * ── Reading the result ──────────────────────────────────────────────────────
 * `ok` is **false on every call made before the open**, with the single reason
 * `position_missing` — we are quoting a decrease against a position that does
 * not exist yet. Blocking on `ok` would therefore block 100% of trades, which
 * is the same shape as B1 and was nearly the shape of this fix: an earlier
 * draft of this very docstring said to do exactly that.
 *
 * So `blocking` is the field callers use: true when PEX says the order would
 * execute on arrival, or when the quote failed for any reason OTHER than the
 * position not being open yet. An unquotable take-profit is still not a safe
 * one — but "you have not opened it yet" is not unquotable, it is expected.
 */
/**
 * Failure reasons that are the expected consequence of quoting a take-profit
 * for a position that has not been opened yet, and so must not block the open.
 */
const EXPECTED_PRE_OPEN_REASONS: ReadonlySet<string> = new Set(["position_missing"]);

/**
 * PEX's own answer on whether a protective order is already crossed.
 *
 * Takes the KIND. It hardcoded `DECREASE_TAKE_PROFIT`, so the stop-loss had no
 * equivalent of this layer at all — only our own arithmetic about PEX, where
 * the take-profit has both that and this. `quoteV2DecreaseOrder` handles kind 3
 * identically, so the only thing that was missing was the argument.
 */
export function quoteProtectiveOrderCrossed(input: {
  /** `V2_ORDER_KIND` literal. Defaults to take-profit, so existing callers
   *  are unchanged. Typed as the SDK types it, not as bigint. */
  orderKind?: typeof V2_ORDER_KIND.DECREASE_TAKE_PROFIT | typeof V2_ORDER_KIND.DECREASE_STOP_LOSS;
  state: MarketState;
  oracle: OraclePayload;
  side: Side;
  owner: string;
  notionalUsd: number;
  triggerPrice12: bigint;
  acceptablePrice12: bigint;
  keeperFeeMicro: bigint;
  collateralAssetId: number;
  builderAddress: string;
  builderFeeBps?: number;
}): { crossed: boolean; ok: boolean; reasons: string[]; blocking: boolean } {
  const raw = quoteV2DecreaseOrder({
    market: marketRecord(input.state),
    pool: { ...input.state.pool },
    position: null,
    owner: input.owner,
    marketId: BigInt(input.state.marketId),
    orderKind: input.orderKind ?? V2_ORDER_KIND.DECREASE_TAKE_PROFIT,
    collateralAssetId: BigInt(input.collateralAssetId),
    side: SIDE_CODE[input.side],
    sizeUsdDelta: BigInt(Math.round(input.notionalUsd * Number(USD_SCALE))),
    triggerPrice: input.triggerPrice12,
    acceptablePrice: input.acceptablePrice12,
    keeperFeeAssetId: BigInt(input.collateralAssetId),
    keeperFeeAmount: input.keeperFeeMicro,
    prices: priceInput(input.oracle),
    builderFee: {
      builderAddress: input.builderAddress,
      builderFeeBps: BigInt(input.builderFeeBps ?? POSITION_BUILDER_FEE_BPS),
    },
  }) as unknown as Record<string, unknown>;
  const crossed = Boolean(raw.crossed);
  const reasons = ((raw.failure_reasons as string[]) ?? []).slice();
  const unexpected = reasons.filter((r) => !EXPECTED_PRE_OPEN_REASONS.has(r));
  return {
    crossed,
    ok: Boolean(raw.ok),
    reasons,
    blocking: crossed || unexpected.length > 0,
  };
}

/**
 * The exit price at which a take-profit target returns a given profit.
 *
 * Returns null when no such price exists. A short asked for more profit than its
 * notional solves to a NEGATIVE price — arithmetically consistent and completely
 * meaningless — so the impossible case is reported rather than rendered.
 */
export function priceForPayoff(quote: OpenQuote, targetUsd: number): bigint | null {
  if (quote.notionalUsd <= 0 || targetUsd <= 0) return null;
  if (targetUsd >= maxPayoffUsd(quote)) return null;
  const move = targetUsd / quote.notionalUsd;
  const signed = quote.side === "long" ? move : -move;
  const price = BigInt(Math.round(Number(quote.entryPrice12) * (1 + signed)));
  return price > BigInt(0) ? price : null;
}

/** A profit chip resolved against a quote, or the reason it was not. */
export type QuickPick =
  | {
      ok: true; price12: bigint; moveBps: number;
      /**
       * True when the crossing guard moved the target off the chip's number.
       *
       * The chip still reads "+10%" but the price written is not +10%, so the
       * profit shown will not match the label. Measured across 3,060 swept
       * resolutions it fires on 16 (0.52%) — every one the +10% chip on a $6
       * ALGO long at 9.5x-11x, which is the regime of the only real trade this
       * product has made. Reported rather than silent.
       */
      clamped: boolean;
    }
  | { ok: false; reason: "unpayable" | "unreachable"; moveBps: number | null };

/**
 * Resolve a "+N% of stake" chip into an exit price the card will stand behind.
 *
 * Lives here rather than in the card, and is one function rather than two, for
 * the reason audit 7 gave: the chip's enabled state and the price it writes were
 * separate expressions of the same rule, and only one of them knew about the
 * bound. A chip that is clickable must write a price, and a price written must
 * be one the chip could offer.
 *
 * Two ways a target is refused:
 *
 * - **`unpayable`** — more profit than the position can produce at any price. A
 *   short's ceiling is its notional; `priceForPayoff` solves these to a negative
 *   price and returns null rather than rendering it.
 * - **`unreachable`** — payable, but only after a price move larger than
 *   `MAX_QUICK_PICK_MOVE_BPS`. This is the audit-7 case: the chips solve
 *   `pct / leverage`, so at the bar's left end (0.10x) "+50% of stake" is a
 *   +500% price move, valid by every other check, and with no close path it
 *   leaves a position whose only exit cannot be reached.
 *
 * `moveBps` is returned on success too, so the card can show what a chip
 * actually implies instead of leaving the relationship invisible.
 */
export function quickPickPrice(quote: OpenQuote, targetUsd: number): QuickPick {
  const wanted = priceForPayoff(quote, targetUsd);
  if (wanted === null) return { ok: false, reason: "unpayable", moveBps: null };

  const entry = quote.entryPrice12;
  if (entry <= BigInt(0)) return { ok: false, reason: "unpayable", moveBps: null };
  const moveOf = (p: bigint) =>
    Number(((p > entry ? p - entry : entry - p) * BigInt(10_000)) / entry);

  // The bound is judged on what was ASKED for, before any clamp: a target
  // needing a 500% move is refused whether or not a bound would pull it back,
  // because the chip is offering something the position cannot deliver.
  if (moveOf(wanted) > MAX_QUICK_PICK_MOVE_BPS) {
    return { ok: false, reason: "unreachable", moveBps: moveOf(wanted) };
  }

  // Clamp into the band the card enforces. At high leverage a small percentage
  // of stake is a small price move, which can land inside the crossing guard —
  // and a card showing its own invalid target is worse than a conservative one.
  const b = displayTakeProfitBounds(quote);
  const price12 = wanted < b.minPrice12 ? b.minPrice12
    : wanted > b.maxPrice12 ? b.maxPrice12 : wanted;
  const clamped = price12 !== wanted;
  // Reported on the price actually WRITTEN, not on `wanted`. Measured on the
  // pre-fix version: the clamp fired on 16 of 3,060 swept resolutions, every
  // one the +10% chip on a $6 ALGO long at 9.5x-11x — the exact regime of the
  // only real trade — where the card read "a 0.98% price move" over a price
  // that moves 1.05%.
  return { ok: true, price12, moveBps: moveOf(price12), clamped };
}

/**
 * What a close actually pays out, aggregated by asset.
 *
 * Extracted from `quoteClose` so it can be tested without a network, which is
 * the point: this arithmetic shipped **wrong in both directions** through six
 * audits and had no test when audit 7 found it still had none.
 *
 * Ultrade, 2026-09-28: do NOT use `collateral_delta`. Aggregate
 * `primary_output_amount` (net collateral), `pnl_output_amount` (realized
 * profit) and the claimable token outputs BY ASSET, and do **not** subtract the
 * funding/borrowing breakdown again — those costs are already settled into
 * collateral before the proportional withdrawal is computed, which is also why
 * they do not scale with the close fraction.
 *
 * Legs at or below zero are dropped rather than summed: a zero leg is an asset
 * the user does not receive, and listing "0.000000 ALGO" as something you get
 * back is noise on the one line that has to be read.
 */
export function aggregateCloseOutputs(
  raw: Record<string, unknown>,
  core: { long_asset_id: bigint | number; short_asset_id: bigint | number },
): CloseOutput[] {
  const byAsset = new Map<number, bigint>();
  const add = (amount: unknown, assetId: unknown) => {
    const a = big(amount);
    if (a <= BigInt(0)) return;
    const id = Number(assetId ?? 0);
    byAsset.set(id, (byAsset.get(id) ?? BigInt(0)) + a);
  };
  add(raw.primary_output_amount, raw.primary_output_asset_id);
  add(raw.pnl_output_amount, raw.pnl_output_asset_id);
  add(raw.claimable_long_token_output, core.long_asset_id);
  add(raw.claimable_short_token_output, core.short_asset_id);
  // Sorted by asset id, deterministically. NOT by raw amount: micro-units of
  // different assets are not comparable, and doing so put "16.251005 ALGO"
  // ($2.14) ahead of "5.568338 USDC" ($5.57) — the leading, largest-LOOKING
  // figure being the smaller one. Display order by value belongs where the
  // prices are; see `valueCloseOutputs` and the panel.
  //
  // The old comparator also returned -1 for equal amounts, which is not a valid
  // ordering. Harmless at two or three elements, wrong in principle.
  return [...byAsset.entries()]
    .map(([assetId, amount]) => ({ assetId, amount }))
    .sort((a, b) => a.assetId - b.assetId);
}

/**
 * Those outputs in dollars, or null if any leg cannot be priced.
 *
 * USDC is the collateral asset at 1:1; the market's index asset is priced by the
 * signed oracle. Anything else and the TOTAL is withheld — never guessed, never
 * partially summed. A partial total is indistinguishable from a complete one on
 * screen, which is exactly how a payout gets understated by a hidden leg.
 */
export function valueCloseOutputs(
  outputs: CloseOutput[],
  ctx: {
    collateralAssetId: number; indexAssetId: number; indexPrice12: bigint;
    /**
     * ALGO's price, when it is not this market's index asset.
     *
     * **Audit 8 MEDIUM 7.** Market 2's `index_asset_id` is the synthetic
     * `9000000000000000`, but a BTC/USD close actually pays out in ALGO and
     * USDC — so ALGO matched neither branch, `payoutUsd` went null, and every
     * BTC position showed no payout, no net figure and no cost breakdown at all.
     * Fail-safe rather than wrong, but on one of two markets a user could not see
     * what closing returned.
     *
     * ALGO is asset 0 on both markets and is priceable from market 1's signed
     * payload, so the caller supplies it. Omitted, the old behaviour stands:
     * withhold rather than guess.
     */
    algoPrice12?: bigint;
  },
): number | null {
  let total = 0;
  for (const o of outputs) {
    if (o.assetId === ctx.collateralAssetId) total += Number(o.amount) / 1e6;
    else if (o.assetId === ctx.indexAssetId) {
      total += (Number(o.amount) / 1e6) * (Number(ctx.indexPrice12) / 1e12);
    } else if (o.assetId === 0 && ctx.algoPrice12 !== undefined
      && ctx.algoPrice12 > BigInt(0)) {
      total += (Number(o.amount) / 1e6) * (Number(ctx.algoPrice12) / 1e12);
    } else return null;
  }
  return total;
}

/** Convenience: the Trading app's oracle target for a market. */
export const tradingOracleTarget = (marketId: number) => ({ appId: PEX_APPS.trading, marketId });
