/**
 * PEX liquidity provision — the arithmetic, with no network in it.
 *
 * See STRATEGY_SPEC.md. Three destinations for capital, and the numbers that
 * describe them. Everything here is pure so it can be tested against values
 * rather than mocked clients: the two things most likely to be wrong on this
 * page are a double-counted total and a fabricated APR, and neither needs a
 * chain to get wrong.
 */

import { PEX_APPS, PEX_ASSETS } from "./perps";

/** The three places capital can go. Destinations, not deposit methods. */
export type LiquidityDestinationId = "c-vault" | "algo-usd" | "btc-usd";

export const LIQUIDITY_DESTINATIONS: readonly LiquidityDestinationId[] =
  ["c-vault", "algo-usd", "btc-usd"] as const;

/**
 * Every destination glows purple.
 *
 * On the Finance page gold means "this collateral is not $U" — a different risk
 * family. Here all three hold the SAME collateral (ALGO + USDC), so gold would
 * assert a distinction that does not exist. A function rather than a constant
 * so the rule is testable per destination, and so adding a fourth destination
 * with a different collateral has an obvious place to diverge.
 */
export function destinationGlowKind(_id: LiquidityDestinationId): "magnet" {
  return "magnet";
}

/**
 * Markets whose pools this page exposes.
 *
 * BOTH are ALGO-long / USDC-short, read from `market_core` on chain
 * (`m2:` boxes, fields `long_asset_id` / `short_asset_id`). Market 2's index is
 * a synthetic BTC sentinel, so **BTC/USD holds no BTC** — a depositor backs BTC
 * exposure with ALGO and USDC. That is the most surprising fact on this page and
 * the easiest thing for someone to misread, so it is a field here rather than
 * copy in one component.
 */
export const PEX_LIQUIDITY_MARKETS = {
  "algo-usd": { marketId: 1, label: "ALGO/USD", synthetic: false },
  "btc-usd": { marketId: 2, label: "BTC/USD", synthetic: true },
} as const;

/** Every destination on this page holds the same two assets. */
export const LEG_ASSETS = {
  long: { assetId: 0, symbol: "ALGO", decimals: 6 },
  short: { assetId: PEX_ASSETS.usdc, symbol: "USDC", decimals: 6 },
} as const;

/**
 * Apps that LOOK like liquidity destinations and are not.
 *
 * `marketYieldVault` and `marketXAlgoYieldVault` carry 14 methods each and
 * **no deposit or withdraw among them**. They receive PEX's idle market cash
 * via `yield_send_to_vault_raw`, which is keeper-only — the same yield-recall
 * machinery the terminal's close path already handles. Exported so a test can
 * assert no deposit path ever references them; wiring one would take a user's
 * funds to an app that cannot return them through any public method.
 */
export const NOT_LIQUIDITY_DESTINATIONS: readonly number[] = [
  PEX_APPS.marketYieldVault,
  PEX_APPS.marketXAlgoYieldVault,
] as const;

/** The apps a deposit MAY target. Allow-list, so a new PEX app is refused by default. */
export const LIQUIDITY_DEPOSIT_TARGETS: readonly number[] = [
  PEX_APPS.cvaVault,
  PEX_APPS.adminOps,
  PEX_APPS.singleTokenOps,
] as const;

/**
 * Gate every deposit target through here.
 *
 * The deny list above was previously asserted only by a test that checked the
 * list contained the ids listed two lines above it in the same module — true by
 * construction, and it would have passed unchanged the day a deposit path wired
 * a yield vault. This function is the thing with teeth: it is allow-list first,
 * so an app PEX adds later is refused until someone decides it belongs, and it
 * names the yield vaults specifically because capital sent there cannot be
 * retrieved by any public method.
 */
export function assertDepositTarget(appId: number): void {
  if (NOT_LIQUIDITY_DESTINATIONS.includes(appId)) {
    throw new Error(
      `App ${appId} is a PEX yield vault, not a liquidity destination: it has no deposit `
      + "or withdraw method, so capital sent there could not be returned.");
  }
  if (!LIQUIDITY_DEPOSIT_TARGETS.includes(appId)) {
    throw new Error(`App ${appId} is not a known PEX liquidity destination.`);
  }
}

// ── composition ───────────────────────────────────────────────────────────────

export type PoolLegs = {
  /** ALGO, display units. */
  longAmount: number;
  /** USDC, display units. */
  shortAmount: number;
};

export type PoolValue = {
  longUsd: number;
  shortUsd: number;
  totalUsd: number;
  /** Long leg's share of pool value, 0..1. Null when the pool is empty. */
  longShare: number | null;
};

/** Pool value in USD. The short leg is USDC, so it is already dollars. */
export function poolValue(legs: PoolLegs, algoUsd: number): PoolValue {
  const longUsd = legs.longAmount * algoUsd;
  const shortUsd = legs.shortAmount;
  const totalUsd = longUsd + shortUsd;
  return {
    longUsd,
    shortUsd,
    totalUsd,
    longShare: totalUsd > 0 ? longUsd / totalUsd : null,
  };
}

/** NAV per share. Null when no shares exist — never 0, which reads as "worthless". */
/**
 * Pool value per share — NOT PEX's NAV per share.
 *
 * PEX's own LP NAV (`v2Quotes.js`, `v2LpNavContext`) is raw pool value plus lent
 * quantity, minus the position-impact pool, **plus trader losses and minus
 * trader profits** (capped by `max_pnl_factor_for_withdrawals_bps`), plus
 * pending borrowing. This is only the first term.
 *
 * So it is wrong by exactly the trader P&L that this page's own disclaimer says
 * dominates: market 1's traders were down $66.41 when last checked, making
 * PEX's figure ~1.1334 against this one's ~1.1063 — 2.4% low. **The sign
 * flips.** With traders up $200 this would read high, on the one stat a
 * depositor uses to judge whether LPs have been earning.
 *
 * Named `poolValuePerShare` deliberately: the honest fix is either to compute
 * PEX's full NAV or to label this as what it is, and labelling it is what we
 * did. Do not rename it back to NAV.
 */
export function poolValuePerShare(totalUsd: number, shareSupply: number): number | null {
  return shareSupply > 0 ? totalUsd / shareSupply : null;
}

// ── fee yield ─────────────────────────────────────────────────────────────────

/**
 * The fee APR, derived on chain — and why that is defensible.
 *
 * ── Correcting an earlier claim in this file ──
 * This said "PEX publishes no APR". Wrong. `v2Pool()` returns
 * `fee_apr_7d_bps`, `yield_apr_7d_bps` and `total_apr_7d_bps`, documented in
 * SDK 0.6.9's INTEGRATION_GUIDE. What IS true is that those come from a
 * backend the INTEGRATOR operates: "Bring your own backend… Do not point
 * `baseUrl` at a PEX-operated API" (BACKEND_INTEGRATION.md). Getting PEX's own
 * figures means indexing daily history ourselves — roadmap, not today.
 *
 * ── Why this derivation matches PEX's definition on THESE pools ──
 * PEX defines income APR as each income contribution divided by the pool
 * capital valued WHEN THAT INCOME WAS CREDITED, summed over the window and
 * annualised ×365/7 without compounding, and warns: "It is not seven-day
 * income divided by today's TVL."
 *
 * That warning is about a denominator that MOVED during the window. On these
 * pools it has not: all 27 LP capital events on PDexV2AdminOps fall between
 * 2026-09-02 and 2026-09-18, and there have been **none in the last 32 days**.
 * With constant capital, "income ÷ today's TVL" and "income ÷ capital at
 * credit time" are the same number. `capitalStableDays()` is how the page
 * checks that assumption still holds instead of trusting this comment.
 *
 * ── Which direction this errs ──
 * Across the full since-inception window capital was still arriving for the
 * first 16 days, so average capital was LOWER than today's; dividing by
 * today's TVL therefore **understates** the realised rate. It also omits
 * `yield_apr` — external-yield income PEX credits to the pool, which we do not
 * read — understating total income APR again. Both errors are conservative,
 * which is the right direction for a number meant to attract deposits.
 *
 * ── Why this is the fee component and NOT a return ──
 * An LP here is the counterparty to every trade, so
 *
 *     LP return = fees + trader P&L
 *
 * and the second term dominates and can be negative. Market 2 earned $2.56 of
 * fees over 50 days while its share price rose 13% — essentially all of that is
 * traders losing, and it can invert. Presenting the NAV-implied figure (~94%
 * annualised) as an APR would be the most misleading number on the site.
 *
 * Callers MUST label this as the fee component. `FeeYield.isReturn` is false
 * and exists to make that hard to forget.
 */
export const FEE_YIELD_DISCLAIMER =
  "Fee component only — your return is fees plus trader P&L, which is larger and can be negative.";

export type FeeYield = {
  /** Fees accrued since the pool opened, USD. */
  feesUsd: number;
  /**
   * What was actually computed, so a label cannot drift from the maths. PEX
   * prescribes "Fees + yield APR (past 7d)" for THEIR figure and forbids
   * labelling either value APY; ours is fee-only and since-inception, so it
   * must not borrow their wording.
   */
  basis: "fees-since-inception";
  /** Those fees as a fraction of pool value, 0..1. */
  periodFraction: number;
  /** Annualised, as a percentage. Null when it cannot be computed. */
  annualisedPct: number | null;
  days: number;
  /** Always false. This is not an expected return — see above. */
  isReturn: false;
};

/**
 * Annualise accrued fees.
 *
 * Deliberately simple interest, not compounded: the fees are a measured stock
 * over a known window, and compounding them would invent a reinvestment that
 * did not happen.
 *
 * Returns `annualisedPct: null` rather than 0 or Infinity when the inputs
 * cannot support a rate — an empty pool, a zero-length window, or a
 * non-finite input. A card must render "—" there, never "0.0% APR", which
 * reads as a measured result.
 */
export function feeYield(input: {
  /** Accrued fee amounts, in their own units. */
  longFeeAmount: number;
  shortFeeAmount: number;
  poolTotalUsd: number;
  algoUsd: number;
  days: number;
}): FeeYield {
  const { longFeeAmount, shortFeeAmount, poolTotalUsd, algoUsd, days } = input;
  const feesUsd = longFeeAmount * algoUsd + shortFeeAmount;
  const ok = Number.isFinite(feesUsd) && poolTotalUsd > 0 && days > 0;
  const periodFraction = ok ? feesUsd / poolTotalUsd : 0;
  return {
    feesUsd: Number.isFinite(feesUsd) ? feesUsd : 0,
    basis: "fees-since-inception",
    periodFraction,
    annualisedPct: ok ? periodFraction * (365 / days) * 100 : null,
    days,
    isReturn: false,
  };
}

/**
 * When liquidity provision actually began: the first `deposit_liquidity` call
 * on PDexV2AdminOps, round **64,643,818**, 2026-09-02T01:29:07Z. Market 2's
 * first deposit followed 55 seconds later in round 64,643,838.
 *
 * ⚠️ This was 2026-08-31T00:00Z until 2026-10-20, taken from the first
 * transaction on the markets app — which is the app's CREATION, not a deposit.
 * The apps were created 2026-08-31T14:55:26Z and sat with empty pools for
 * nearly two days. Dating fee accrual from then overstated the window by 2.06
 * days and so understated every rate on the page by ~4%.
 *
 * It is the exact deposit timestamp rather than midnight for the same reason:
 * fees cannot accrue before there is capital to charge against.
 */
export const PEX_POOLS_OPENED_MS = Date.UTC(2026, 8, 2, 1, 29, 7);

/**
 * Last time LP capital entered or left either pool: 2026-09-18T19:23Z, the
 * final of 27 such events.
 *
 * This is what licenses `feeYield`'s denominator (see above). If capital starts
 * moving again, a since-inception rate against today's TVL stops being
 * equivalent to PEX's definition and becomes an approximation — so the page
 * reports how long capital has been stable rather than burying the assumption
 * in a comment.
 */
export const LP_CAPITAL_LAST_CHANGED_MS = Date.UTC(2026, 8, 18, 19, 23);

/** How long the denominator has been trustworthy, in days. */
export function capitalStableDays(nowMs: number = Date.now()): number {
  return Math.max(0, (nowMs - LP_CAPITAL_LAST_CHANGED_MS) / 86_400_000);
}

export function poolAgeDays(nowMs: number = Date.now()): number {
  return Math.max(0, (nowMs - PEX_POOLS_OPENED_MS) / 86_400_000);
}

// ── the C-Vault, and the double-counting it causes ───────────────────────────

export type CvaAllocation = {
  marketId: number;
  /** LP shares the vault holds in that market's pool. */
  lpShareAmount: number;
  /** PEX's own mark of those shares, USD. */
  markUsd: number;
  targetWeightBps: number;
};

/**
 * What fraction of a market's pool the C-Vault owns.
 *
 * This is the input to the deduplication below: the vault's capital is not
 * beside the pools, it is inside them.
 */
export function cvaOwnershipFraction(
  alloc: CvaAllocation, poolShareSupply: number,
): number | null {
  return poolShareSupply > 0 ? alloc.lpShareAmount / poolShareSupply : null;
}

export type LiquidityTotals = {
  /** Every dollar backing open interest. The headline figure. */
  totalUsd: number;
  /** Held by the C-Vault on its depositors' behalf. */
  viaCvaUsd: number;
  /** Held by LPs who deposited into a market directly. */
  directUsd: number;
};

/**
 * Total capital backing open interest, WITHOUT double counting.
 *
 * ⚠️ The C-Vault's NAV is already inside the market pools — it holds LP shares
 * in both (42.3% of market 1 and 22.3% of market 2 when this was written). So
 * the total is the sum of the POOLS, and the vault's NAV is a *slice* of that
 * sum, not an addition to it.
 *
 * Summing pool values plus vault NAV overstates by a third (~$6,400 against a
 * true ~$4,786). That would be wrong on the single number this page exists to
 * make credible, which is why this function exists instead of a `+` at a call
 * site, and why it returns the breakdown rather than just the total — a caller
 * that wants to show the split cannot be tempted to re-derive it by adding.
 */
export function liquidityTotals(
  pools: readonly { totalUsd: number }[],
  cvaMarkUsd: number,
): LiquidityTotals {
  const totalUsd = pools.reduce((acc, p) => acc + p.totalUsd, 0);
  // Clamped: a stale mark could exceed the pools it is a slice of, and a
  // negative "direct" figure is nonsense rather than a small error.
  const viaCvaUsd = Math.min(Math.max(0, cvaMarkUsd), totalUsd);
  return { totalUsd, viaCvaUsd, directUsd: totalUsd - viaCvaUsd };
}

/** The C-Vault's blended fee yield: each market's rate at the vault's weight. */
export function blendedFeeYieldPct(
  parts: readonly { annualisedPct: number | null; weight: number }[],
): number | null {
  const usable = parts.filter((p) => p.annualisedPct !== null && p.weight > 0);
  const totalWeight = usable.reduce((a, p) => a + p.weight, 0);
  if (totalWeight <= 0) return null;
  return usable.reduce((a, p) => a + p.annualisedPct! * p.weight, 0) / totalWeight;
}
