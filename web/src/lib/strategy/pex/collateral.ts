import { PEX_ASSETS } from "@/lib/strategy/pex/config";

/**
 * Converting between collateral in ASSET units and collateral in USD.
 *
 * ── The fact this module exists for ─────────────────────────────────────────
 * A position's `collateral_amount` is denominated in the COLLATERAL ASSET, not
 * in USD. Measured on MainNet 2026-11-03, market 1, the two live long positions
 * under different collateral:
 *
 *   collateral asset 0         collateral_amount 210.873916   size_usd   20.0235
 *   collateral asset 31566704  collateral_amount 566.816347   size_usd 1805.50
 *
 * 210.87 is ALGO, and it agrees with the market's own
 * `collateral_sum_long_token_for_longs`. It is not $210.87 of anything.
 *
 * ── Why that was invisible until now ────────────────────────────────────────
 * Everything in this codebase treated the two as interchangeable, and for USDC
 * they ARE: one µUSDC is one µUSD, so `BigInt(Math.round(usd * 1e6))` is both
 * the dollar figure and the transfer amount. The equality is a property of
 * USDC, not of collateral, and it silently became an assumption.
 *
 * Against ALGO at $0.0935 the two differ by ~10.7x. Every place that conflated
 * them — the quote's `collateralAmount`, the builder's transfer leg, the
 * group assertion's leverage ratio — is wrong by that factor.
 *
 * ── Asset units are authoritative ───────────────────────────────────────────
 * The direction matters. What the user transfers and what the box stores are
 * both in asset units; USD is derived from a price that moves. So asset units
 * are the number carried through the write path, and USD is computed for
 * display and for the comparisons that are genuinely dollar-denominated (the
 * $5 minimum, leverage). Deriving in the other direction would mean the amount
 * actually signed depended on when the conversion ran.
 */

/** Micro-units per whole unit, for both USD and every asset we handle. */
const MICRO = BigInt(1_000_000);
/** Price12 fixed-point scale, as PEX publishes prices. */
const PRICE12 = BigInt(1_000_000_000_000);

export class UnpricedCollateralError extends Error {
  constructor(assetId: number) {
    super(`No price available for collateral asset ${assetId}.`);
    this.name = "UnpricedCollateralError";
  }
}

/**
 * What one whole unit of the collateral asset is worth, as Price12.
 *
 * USDC is pinned to exactly 1.0 rather than read from an oracle. PEX prices
 * markets, not stablecoins, so there is no USDC/USD feed to read — and
 * inventing one would make the $5 minimum wobble against a peg this protocol
 * does not take a view on. The contract makes the same assumption.
 */
function price12For(assetId: number, algoPrice12?: bigint | null): bigint {
  if (assetId === PEX_ASSETS.usdc) return PRICE12;
  if (assetId === PEX_ASSETS.algo) {
    if (algoPrice12 == null || algoPrice12 <= BigInt(0)) throw new UnpricedCollateralError(assetId);
    return algoPrice12;
  }
  // Never a guess. An unknown collateral asset reaching here is a bug, and
  // valuing it at anything at all would hide that behind a plausible number.
  throw new UnpricedCollateralError(assetId);
}

/** True when µ-asset and µUSD are the same number, so no conversion is needed. */
export function isUsdDenominated(assetId: number): boolean {
  return assetId === PEX_ASSETS.usdc;
}

/**
 * Asset micro-units → µUSD.
 *
 * Exact for USDC — it returns the input untouched rather than multiplying and
 * dividing by the same scale, so the common path cannot drift by a rounding
 * unit.
 */
export function collateralUsdMicro(
  assetId: number, amountMicro: bigint, algoPrice12?: bigint | null,
): bigint {
  if (isUsdDenominated(assetId)) return amountMicro;
  return (amountMicro * price12For(assetId, algoPrice12)) / PRICE12;
}

/**
 * µUSD → asset micro-units.
 *
 * Used for the controls that are naturally stated in dollars (a $5 floor) when
 * the amount being compared is in ALGO. Not used to compute what gets signed:
 * see the module note on direction.
 */
export function collateralAmountMicro(
  assetId: number, usdMicro: bigint, algoPrice12?: bigint | null,
): bigint {
  if (isUsdDenominated(assetId)) return usdMicro;
  return (usdMicro * PRICE12) / price12For(assetId, algoPrice12);
}

/** Asset micro-units → whole USD, for display and for leverage arithmetic. */
export function collateralUsd(
  assetId: number, amountMicro: bigint, algoPrice12?: bigint | null,
): number {
  return Number(collateralUsdMicro(assetId, amountMicro, algoPrice12)) / Number(MICRO);
}
