/**
 * PEX liquidity provision — the arithmetic, with no network in it.
 *
 * See strategy/pools/SPEC.md. Three destinations for capital, and the numbers that
 * describe them. Everything here is pure so it can be tested against values
 * rather than mocked clients: the two things most likely to be wrong on this
 * page are a double-counted total and a fabricated APR, and neither needs a
 * chain to get wrong.
 */

import { PEX_APPS, PEX_ASSETS } from "@/lib/strategy/pex/config";

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

// ── fee yield: REMOVED 2026-10-21 ──
//
// A `feeYield()` / `blendedFeeYieldPct()` / `poolAgeDays()` /
// `capitalStableDays()` block lived here, deriving a fee APR from on-chain
// accrued fees. It is gone, not deprecated, because it was WRONG and its
// wrongness was invisible:
//
//     ALGO/USD   it read 15.3%   PEX's actual fee APR is 4.83%
//
// It annualized fees since inception against the current pool. Trading has
// slowed 4.1x ($1.088/day over the first 48.9 days, $0.268/day over the last
// seven), so an inception average overstates what a depositor earns today by
// 3.2x — and it omitted yield income, which on these pools is the larger half
// (6.39% against 4.83%). The comment here argued the figure "errs low", which
// was true of the historical realised rate and false of the current one, the
// only one that matters to someone deciding to deposit.
//
// Ultrade now publishes both the income APR and the pool return on R2; see
// `strategy/performance.ts`. The arithmetic is deleted rather than kept behind a
// warning so nobody can reach for it again.
//
// `MarketLiquidity.feesSinceInceptionUsd` keeps the cumulative fee total,
// which is a true stock and cannot be mistaken for a rate.

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
  parts: readonly { annualizedPct: number | null; weight: number }[],
): number | null {
  const usable = parts.filter((p) => p.annualizedPct !== null && p.weight > 0);
  const totalWeight = usable.reduce((a, p) => a + p.weight, 0);
  if (totalWeight <= 0) return null;
  return usable.reduce((a, p) => a + p.annualizedPct! * p.weight, 0) / totalWeight;
}
