// Perps — risk-bar solver.
//
// Turns live market state into the two ends of the risk bar. Both ends are
// SOLVED; neither is a constant. See strategy/perps/SPEC.md, "One ceiling expression —
// five constraints, not three".
//
// This module is deliberately pure: no network, no algod. Feed it a MarketState
// and it returns numbers. That makes it testable against the SDK's own quote,
// which is the only thing that decides whether an open actually succeeds.
//
// IMPORTANT: the closed form is a *pre-filter*, not the gate. It exists so the
// bar renders without a round trip per pixel. The right end must still be
// confirmed by a live quote returning ok === true before it is enabled —
// dynamic_min_position_size_usd, position_quantization and impact_consumes_size
// all sit on this path and none of them are modelled here.

import {
  LAUNCH_NOTIONAL_CEILING_USD,
  OI_HEADROOM_SHARE,
  POSITION_BUILDER_FEE_BPS,
} from "./perps";
import {
  MATH_FACTOR_SCALE,
  USD_SCALE,
  oiHeadroomUsd,
  sideOiUsd,
  type MarketCore,
  type MarketRisk,
  type MarketState,
} from "./perpsReads";

export type Side = "long" | "short";

/** Which term set the ceiling. Surfaced to the user — "why is my limit this?" */
export type BindingConstraint =
  | "margin"
  | "collateral"
  | "oi_headroom"
  | "reserves"
  | "launch_cap";

export type SolvedBar = {
  side: Side;
  /** Collateral the solve was run for, in dollars. */
  collateralUsd: number;
  /** Smallest openable notional, dollars. */
  minNotionalUsd: number;
  /** Largest openable notional, dollars, before the confirming quote. */
  maxNotionalUsd: number;
  minLeverage: number;
  maxLeverage: number;
  binding: BindingConstraint;
  /** Every ceiling term, for display and for debugging a surprising bar. */
  terms: Record<BindingConstraint, number>;
  /** False when the floor exceeds the ceiling — render the side as closed. */
  open: boolean;
  /** Set when !open: why the side is unavailable, in user-facing words. */
  closedReason?: string;
};

const num = (raw: bigint): number => Number(raw) / Number(USD_SCALE);

/**
 * Fee fraction charged on NOTIONAL at open: protocol open fee + our builder fee.
 * Both are deducted FROM collateral, which is why they enter the ceiling at all.
 */
export function openFeeFraction(risk: MarketRisk, builderFeeBps = POSITION_BUILDER_FEE_BPS): number {
  return (Number(risk.open_fee_bps) + builderFeeBps) / 10_000;
}

/**
 * `k` for the dynamic branch: the per-side factor normalised so that
 * `dynamicBps ≈ sideOiAfter_dollars * k`.
 *
 * `dynamicBps = sideOiAfter * factor / 1e12` with sideOiAfter in 1e6 USD, so
 * k = factor / 1e6. ALGO/USD is 1.0; BTC/USD is ~0.641. Getting this wrong in
 * the high direction returns initial_margin_breach at the ceiling.
 */
export function dynamicK(state: MarketState, side: Side): number {
  const factor = side === "long"
    ? state.doi.dynamic_oi_margin_long_factor_scaled
    : state.doi.dynamic_oi_margin_short_factor_scaled;
  return Number(factor) / (Number(MATH_FACTOR_SCALE) / Number(USD_SCALE));
}

/**
 * Margin ceiling — the harder of the two branches.
 *
 * baseline   N <= C / (IM0 + f)
 * dynamic    N^2 + N*(OI0 + 10000*f/k) - 10000*C/k = 0
 *
 * The dynamic branch is a fixed point: dynamicBps is computed on side OI
 * INCLUDING this order, so the margin requirement depends on the size it is
 * gating. Solving it as a quadratic is exact; iterating is not needed.
 *
 * min(both) is correct because effectiveBps = max(baseline, dynamic), so both
 * constraints must hold simultaneously.
 */
export function marginCeilingUsd(state: MarketState, side: Side, collateralUsd: number, builderFeeBps?: number): number {
  const f = openFeeFraction(state.risk, builderFeeBps);
  const im0 = Number(state.risk.initial_margin_bps) / 10_000;
  const baseline = collateralUsd / (im0 + f);

  const k = dynamicK(state, side);
  if (!(k > 0)) return baseline; // dynamic branch inactive

  const oi0 = num(sideOiUsd(state.oi, side));
  const b = oi0 + (10_000 * f) / k;
  // Discriminant is positive for every C > 0, so the root is always usable.
  const dynamic = (-b + Math.sqrt(b * b + (40_000 * collateralUsd) / k)) / 2;

  return Math.min(baseline, dynamic);
}

/**
 * The minimum-COLLATERAL rule is a ceiling on NOTIONAL.
 *
 * quoteV2OpenPosition computes collateralValueAfter = C - (openFee + builderFee)
 * and only then tests it against min_collateral_usd. Fees scale with notional,
 * so a large enough size eats the collateral below the floor:
 *
 *   N <= (C - min_collateral_usd) / f
 *
 * At C == min_collateral_usd this is zero and NOTHING opens — which is exactly
 * what a "MAX" button on a $5 wallet produces. Never drop this term.
 */
export function collateralCeilingUsd(state: MarketState, collateralUsd: number, builderFeeBps?: number): number {
  const f = openFeeFraction(state.risk, builderFeeBps);
  const minCollateral = num(state.risk.min_collateral_usd);
  if (collateralUsd <= minCollateral) return 0;
  return (collateralUsd - minCollateral) / f;
}

/**
 * Smallest collateral that can open anything at all, in dollars.
 * Below this the collateral ceiling sits under the position floor.
 */
export function minimumCollateralUsd(state: MarketState, core: MarketCore, indexPrice12: bigint, builderFeeBps?: number): number {
  const f = openFeeFraction(state.risk, builderFeeBps);
  return num(state.risk.min_collateral_usd) + f * floorNotionalUsd(state, core, indexPrice12);
}

/**
 * Position floor: the larger of the configured minimum and the quantization
 * minimum implied by the market's conversion scale and the current price.
 *
 * dynamicMin = ceil(indexPrice * 10000 / (conversionScale * MAX_QUANTIZATION_BPS))
 * with MAX_QUANTIZATION_BPS == 1. On ALGO/USD the conversion scale is 1e16, so
 * this lands far below min_position_size_usd — but it is price-dependent and
 * admin-mutable, so it is computed rather than assumed away.
 */
export function floorNotionalUsd(state: MarketState, core: MarketCore, indexPrice12: bigint): number {
  const scale = core.position_conversion_scale;
  const dynamicMinRaw = scale > BigInt(0)
    ? (indexPrice12 * BigInt(10_000) + scale - BigInt(1)) / scale
    : BigInt(0);
  const effective = dynamicMinRaw > state.risk.min_position_size_usd
    ? dynamicMinRaw
    : state.risk.min_position_size_usd;
  return num(effective);
}

/**
 * Price impact charged on this open, in bps of notional.
 *
 * With both impact exponents at 1 this reduces to a flat position_impact_factor_bps
 * for any open that worsens the imbalance, capped at max_position_impact_bps.
 * It is NOT symmetric: favourable-side impact is paid out of position_impact_pool_qty,
 * which is currently about a dollar, so it is treated as zero here.
 *
 * This is a COST line, not a ceiling. It only becomes a gate when acceptablePrice
 * is anchored to the index instead of the quoted execution price — see
 * assertExecutionAnchored below.
 */
export function impactBps(state: MarketState, side: Side): number {
  const factor = Number(state.risk.position_impact_factor_bps);
  const cap = Number(state.risk.max_position_impact_bps);
  const long = num(sideOiUsd(state.oi, "long"));
  const short = num(sideOiUsd(state.oi, "short"));
  const worsens = side === "long" ? long >= short : short >= long;
  return worsens ? Math.min(factor, cap) : 0;
}

/**
 * Slippage feasibility.
 *
 * Impact is charged BEFORE the slippage test. Because impact is flat in size,
 * an index-anchored acceptablePrice is all-or-nothing: if impact exceeds the
 * tolerance the side is unopenable at EVERY size, which renders as a bar whose
 * every point rejects. Today a 55 bps impact against a 50 bps tolerance closes
 * the ALGO/USD short side entirely.
 *
 * The fix is to anchor acceptablePrice to the quoted execution price and treat
 * the user's slippage as tolerance on top of impact. This function exists to
 * make the wrong anchoring fail loudly rather than silently produce a dead bar.
 */
export function slippageFeasible(state: MarketState, side: Side, slippageBps: number, anchor: "execution" | "index"): boolean {
  if (anchor === "execution") return true;
  return impactBps(state, side) <= slippageBps;
}

/**
 * Reserve ceiling — `checkReserves`, the constraint that binds after the OI cap.
 *
 * Not binding today, and added before it is. `max_open_interest` went from $960
 * to $1,500 on 2026-09-23 while the long reserve bound sits near $4,250: the gap
 * is now under 3x and closes every time PEX raises the cap against observed
 * liquidity. Adding the term after it starts binding would mean shipping a bar
 * whose right end rejects — the exact failure the ceiling section exists to
 * prevent.
 *
 * The two sides are NOT symmetric, and reading them as symmetric is how this
 * term gets silently wrong:
 *
 *   long   reserve_factor_long_bps  x (long OI TOKENS revalued at index price)
 *   short  reserve_factor_short_bps x (short OI in USD)
 *
 * So the long side is marked to market continuously while the short side is
 * carried at notional. A long's own contribution is `N x index/execution`, which
 * EXCEEDS N whenever impact is favourable — so using N directly would overstate
 * the ceiling. The impact cap bounds that ratio, and the bound is used.
 */
export function reserveCeilingUsd(
  state: MarketState,
  side: Side,
  prices: { indexPrice12: bigint; longPrice12: bigint; shortPrice12: bigint },
): number {
  const ORACLE_SCALE = Number(BigInt(1_000_000_000_000));
  const singleToken = state.core.long_asset_id === state.core.short_asset_id;

  const longPoolUsd = (Number(state.pool.long_pool_amount) * Number(prices.longPrice12)) / ORACLE_SCALE;
  const shortPoolUsd = singleToken
    ? longPoolUsd
    : (Number(state.pool.short_pool_amount) * Number(prices.shortPrice12)) / ORACLE_SCALE;

  if (side === "short") {
    const factor = Number(state.risk.reserve_factor_short_bps) / 10_000;
    if (factor <= 0) return Number.POSITIVE_INFINITY;
    const usedUsd = Number(sideOiUsd(state.oi, "short")) / Number(USD_SCALE);
    const capUsd = (shortPoolUsd / Number(USD_SCALE)) / factor;
    return Math.max(0, capUsd - usedUsd);
  }

  const factor = Number(state.risk.reserve_factor_long_bps) / 10_000;
  if (factor <= 0) return Number.POSITIVE_INFINITY;
  const tokens = Number(state.oi.long_oi_tokens_with_long_collateral + state.oi.long_oi_tokens_with_short_collateral);
  const markedUsd = (tokens * Number(prices.indexPrice12)) / Number(state.core.position_conversion_scale) / Number(USD_SCALE);
  const capUsd = (longPoolUsd / Number(USD_SCALE)) / factor;
  const headroomUsd = Math.max(0, capUsd - markedUsd);
  // A long adds N x index/execution of marked value, not N. Bound that ratio by
  // the maximum favourable impact so the term errs toward a smaller ceiling.
  const worstRatio = 1 + Number(state.risk.max_position_impact_bps) / 10_000;
  return headroomUsd / worstRatio;
}

/** Solve both ends of the risk bar. */
export function solveBar(
  state: MarketState,
  side: Side,
  collateralUsd: number,
  indexPrice12: bigint,
  opts: {
    builderFeeBps?: number;
    launchCapUsd?: number;
    headroomShare?: number;
    /** Omit and the reserve term is skipped — see solveBar's note. */
    prices?: { indexPrice12: bigint; longPrice12: bigint; shortPrice12: bigint };
  } = {},
): SolvedBar {
  const launchCap = opts.launchCapUsd ?? LAUNCH_NOTIONAL_CEILING_USD;
  const headroomShare = opts.headroomShare ?? OI_HEADROOM_SHARE;

  const terms: Record<BindingConstraint, number> = {
    margin: marginCeilingUsd(state, side, collateralUsd, opts.builderFeeBps),
    collateral: collateralCeilingUsd(state, collateralUsd, opts.builderFeeBps),
    oi_headroom: num(oiHeadroomUsd(state.risk, state.oi, side)) * headroomShare,
    // Skipped without prices rather than approximated: the long side needs the
    // index price to mark its OI, and a guessed mark would make this term wrong
    // in the overstating direction. Callers with an oracle payload pass prices.
    reserves: opts.prices ? reserveCeilingUsd(state, side, opts.prices) : Number.POSITIVE_INFINITY,
    launch_cap: launchCap,
  };

  let binding: BindingConstraint = "margin";
  for (const key of Object.keys(terms) as BindingConstraint[]) {
    if (terms[key] < terms[binding]) binding = key;
  }
  const maxNotionalUsd = terms[binding];
  const minNotionalUsd = floorNotionalUsd(state, state.core, indexPrice12);

  const open = maxNotionalUsd >= minNotionalUsd && collateralUsd > 0;
  let closedReason: string | undefined;
  if (!open) {
    closedReason = binding === "collateral"
      ? "Amount is too small once fees are taken out."
      : binding === "oi_headroom"
        ? "This market is at its size limit right now."
        : binding === "margin"
          ? "Not enough margin for the smallest position."
          : binding === "reserves"
            ? "This market is at its size limit right now."
            : "Below the minimum position size.";
  }

  return {
    side,
    collateralUsd,
    minNotionalUsd,
    maxNotionalUsd,
    minLeverage: collateralUsd > 0 ? minNotionalUsd / collateralUsd : 0,
    maxLeverage: collateralUsd > 0 ? maxNotionalUsd / collateralUsd : 0,
    binding,
    terms,
    open,
    closedReason,
  };
}

/**
 * Map a 0..1 risk-bar position to a notional.
 *
 * Linear in NOTIONAL, not in leverage: the bar is a size selector, and the user
 * reads the liquidation price, not the multiple. Clamped to the solved range so
 * a stale bar position can never produce a size outside it.
 */
export function notionalAtBarPosition(bar: SolvedBar, t: number): number {
  if (!bar.open) return 0;
  const clamped = Math.min(1, Math.max(0, t));
  return bar.minNotionalUsd + (bar.maxNotionalUsd - bar.minNotionalUsd) * clamped;
}

/**
 * Step the ceiling down by one UI tick before offering it.
 *
 * The closed form is conservative but not exhaustive, and the confirming quote
 * costs a round trip. Backing off one tick means the common case confirms first
 * try instead of walking down from a rejection in front of the user.
 */
export function steppedCeilingUsd(bar: SolvedBar, ticks = 100): number {
  if (!bar.open) return 0;
  const step = (bar.maxNotionalUsd - bar.minNotionalUsd) / ticks;
  return Math.max(bar.minNotionalUsd, bar.maxNotionalUsd - step);
}
