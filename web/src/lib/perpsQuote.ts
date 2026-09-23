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
import { DEFAULT_SLIPPAGE_BPS, PEX_APPS, POSITION_BUILDER_FEE_BPS } from "./perps";
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
 * Acceptable price from an execution price and a tolerance.
 * A long is willing to pay up to X more; a short to receive down to X less.
 */
export function acceptableFromExecution(executionPrice12: bigint, side: Side, slippageBps: number): bigint {
  const bps = BigInt(Math.round(slippageBps));
  const ten_k = BigInt(10_000);
  return side === "long"
    ? (executionPrice12 * (ten_k + bps)) / ten_k
    : (executionPrice12 * (ten_k - bps)) / ten_k;
}

function shape(raw: Record<string, unknown>, side: Side, collateralUsd: number): OpenQuote {
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
  return shape(real, side, collateralUsd);
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
 * Valid take-profit prices, Price12. A TP sits on the profitable side of entry:
 * above it for a long, between zero and it for a short.
 */
export function takeProfitBounds(quote: OpenQuote): { minPrice12: bigint; maxPrice12: bigint | null } {
  return quote.side === "long"
    ? { minPrice12: quote.entryPrice12 + BigInt(1), maxPrice12: null }
    : { minPrice12: BigInt(1), maxPrice12: quote.entryPrice12 - BigInt(1) };
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
