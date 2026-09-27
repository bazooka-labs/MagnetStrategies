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

import { quoteV2OpenPosition } from "@pdex/sdk";
import { quoteV2DecreaseOrder } from "@pdex/sdk";
import { V2_ORDER_KIND } from "@pdex/sdk";
import {
  CROSS_MARGIN_BPS,
  DEFAULT_SLIPPAGE_BPS,
  MAX_TAKE_PROFIT_MULTIPLE,
  PEX_APPS,
  POSITION_BUILDER_FEE_BPS,
} from "./perps";
import { USD_SCALE, type MarketState } from "./perpsReads";
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
export function confirmCeiling(
  input: Omit<QuoteInput, "notionalUsd">,
  opts: { maxSteps?: number } = {},
): { notionalUsd: number; quote: OpenQuote } | null {
  const maxSteps = opts.maxSteps ?? 12;
  const d = input.oracle.decoded;
  const bar = solveBar(input.state, input.side, input.collateralUsd, input.oracle.indexPrice12, {
    builderFeeBps: input.builderFeeBps,
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
    if (quote.ok) return { notionalUsd: candidate, quote };
    candidate = floor + (candidate - floor) * 0.7;
  }
  const last = quoteOpen({ ...input, notionalUsd: floor });
  return last.ok ? { notionalUsd: floor, quote: last } : null;
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

export function quoteTakeProfitCrossed(input: {
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
    orderKind: V2_ORDER_KIND.DECREASE_TAKE_PROFIT,
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

/** Convenience: the Trading app's oracle target for a market. */
export const tradingOracleTarget = (marketId: number) => ({ appId: PEX_APPS.trading, marketId });
