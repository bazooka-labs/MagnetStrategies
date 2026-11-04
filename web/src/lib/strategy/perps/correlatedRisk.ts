/**
 * When collateral and position move together, and when to interrupt.
 *
 * ── The asymmetry this encodes ──────────────────────────────────────────────
 * A LONG backed by the market's own long asset is exposed twice: the position
 * loses as the price falls, and the collateral securing it is worth less at
 * the same moment. Liquidation therefore arrives sooner than the leverage
 * figure suggests.
 *
 * A SHORT backed by the same asset is the opposite — a legitimate
 * delta-neutral construction. Observed on a real round trip 2026-11-04: ALGO
 * fell 0.595%, a $20 short gained $0.11, and the two very nearly cancelled.
 * The holder was flat in ALGO terms but for fees. Warning about that would be
 * warning about a hedge.
 *
 * ── What this file deliberately does NOT do ─────────────────────────────────
 * It does not compute a liquidation price. The closed form from
 * `maintenance_margin_bps` (250, read live) is easy and would be a SECOND
 * opinion about liquidation, free to drift from the contract's own. The card
 * quotes the counterfactual from PEX instead and passes the two distances in.
 * This module only decides what to do about them.
 */

/**
 * How close to liquidation turns a note into a gate.
 *
 * Expressed as the fraction the price must fall, not as a leverage, because
 * the distance is the thing that hurts and it already folds in fees and price
 * impact. Below a quarter, an ordinary day in this market is a meaningful
 * fraction of the way there.
 *
 * Interrupting earlier would be worse, not safer: a warning raised over a 60%
 * move nobody will see teaches people to click past warnings, and then the
 * one that matters is clicked past too.
 */
export const SEVERE_LIQUIDATION_DROP = 0.25;

export type CorrelatedRisk = "none" | "notice" | "severe";

/**
 * Whether this combination is the doubly-exposed one.
 *
 * ── Against the INDEX asset, not the long asset ────────────────────────────
 * The index is what the position tracks. The long asset is what the pool is
 * backed with, and the two are only the same on an asset-backed market.
 *
 * An earlier version compared against the long asset and was wrong on
 * market 2: BTC/USD is backed with ALGO and USDC, so `long_asset_id` is ALGO
 * there too. A BTC long posted with ALGO collateral was flagged as doubly
 * exposed and could be BLOCKED behind the acknowledgement — but BTC and ALGO
 * are different assets, nothing about that position is correlated, and the
 * copy telling the user their collateral falls with the price was simply
 * false. Found in review.
 *
 * By ROLE rather than by asset id, so this keeps working if PEX lists a
 * market tracking something else.
 */
export function isCorrelatedLong(
  side: "long" | "short", collateralAssetId: number, marketIndexAssetId: number,
): boolean {
  return side === "long" && collateralAssetId === marketIndexAssetId;
}

/** What to show, given how far this position is from liquidation. */
export function correlatedRisk(
  correlated: boolean, dropToLiquidation: number | null,
): CorrelatedRisk {
  if (!correlated) return "none";
  /**
   * Correlated but unmeasurable is SEVERE, not silent.
   *
   * `null` reaches here when the counterfactual could not be quoted; the
   * caller has already established there is a real quote for the trade
   * itself. An earlier version returned "none" for this, which made the gate
   * FAIL OPEN: a failed comparison quote let a correlated long through
   * un-warned and un-gated. The one state where silence is worst was the one
   * that produced it.
   *
   * Zero, negative and NaN land here too: all mean the distance could not be
   * established, and none of them is a reason to say nothing.
   */
  if (dropToLiquidation === null
    || !Number.isFinite(dropToLiquidation) || dropToLiquidation <= 0) {
    return "severe";
  }
  return dropToLiquidation < SEVERE_LIQUIDATION_DROP ? "severe" : "notice";
}

/**
 * Whether the risk state permits submission.
 *
 * Separated from the card's other conditions so the rule can be read, and so
 * "severe requires an acknowledgement" cannot be lost in a boolean chain.
 */
export function riskPermitsSubmit(risk: CorrelatedRisk, acknowledged: boolean): boolean {
  return risk !== "severe" || acknowledged;
}
