import { assetName } from "@/lib/strategy/pex/config";

/**
 * How a held position's chart lines are NAMED, extracted so the rule can be
 * tested against its own property instead of against PerpsView's source text.
 *
 * ── The property ────────────────────────────────────────────────────────────
 * Two lines drawn in one market must never carry the same label. That is the
 * whole job. A chart showing "Your entry" twice, at two prices, tells the
 * reader nothing about which position is which.
 *
 * ── Why it is not simply "always name everything" ───────────────────────────
 * The label is drawn on the price axis beside the level, where there is room
 * for a few words. "Your long USDC entry" on a chart holding ONE position
 * spends that room saying nothing — there is nothing to tell it apart from.
 * So the qualifier grows only as far as the collision requires:
 *
 *   one position           ->  "Your entry"
 *   long + short           ->  "Your long entry"
 *   two longs, USDC/ALGO   ->  "Your long USDC entry"
 *
 * ── Why collateral belongs in it at all ─────────────────────────────────────
 * `p2:` keys a position by `marketId ‖ collateralAssetId ‖ side ‖ owner`, so
 * (market, side) was never unique at PEX — only in our reads, which used to
 * look at USDC alone. Widening them to both collaterals made the duplicate
 * label reachable, which is why this grew a third case rather than two.
 */
export type HeldLineIdentity = {
  side: "long" | "short";
  collateralAssetId: number;
};

/**
 * The qualifier for each held line, positionally. Includes its own trailing
 * space when non-empty, so callers interpolate it directly into `Your ${q}entry`.
 */
export function heldLineQualifiers(held: readonly HeldLineIdentity[]): string[] {
  if (held.length < 2) return held.map(() => "");
  return held.map((l) => {
    const sameSide = held.filter((o) => o.side === l.side).length;
    return sameSide > 1
      ? `${l.side} ${assetName(l.collateralAssetId)} `
      : `${l.side} `;
  });
}
