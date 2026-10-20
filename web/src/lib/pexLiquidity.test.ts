/**
 * The two numbers on the Strategy page that can be wrong without anyone noticing.
 *
 * STRATEGY_SPEC.md §10. A double-counted total and a fabricated APR both render
 * perfectly plausibly, so they are bound here on values rather than left to a
 * reviewer spotting a `+`.
 */
import { describe, expect, it } from "vitest";
import {
  LEG_ASSETS, LIQUIDITY_DESTINATIONS, NOT_LIQUIDITY_DESTINATIONS, PEX_LIQUIDITY_MARKETS,
  LP_CAPITAL_LAST_CHANGED_MS, PEX_POOLS_OPENED_MS,
  assertDepositTarget, capitalStableDays, destinationGlowKind,
  blendedFeeYieldPct, cvaOwnershipFraction, feeYield, liquidityTotals,
  poolAgeDays, poolValue, poolValuePerShare,
} from "./pexLiquidity";
import { PEX_APPS, PEX_ASSETS } from "./perps";

/** Live snapshot, 2026-10-20 — see STRATEGY_SPEC.md §11. */
const ALGO = 0.1134;
const M1 = { longAmount: 5_717.05, shortAmount: 1_952.05, shares: 2_350.4244,
             longFee: 0.6532, shortFee: 53.1041 };
const M2 = { longAmount: 6_700.49, shortAmount: 1_425.57, shares: 1_934.2846,
             longFee: 0.4476, shortFee: 2.5136 };
const CVA = { m1MarkUsd: 1_137.64, m1Shares: 993.907, m2MarkUsd: 487.58, m2Shares: 431.1383 };

describe("the deduplication rule", () => {
  it("does NOT add the C-Vault's NAV to the pools it already sits inside", () => {
    // The whole point. The vault holds LP shares in both markets, so its NAV is
    // a slice of the pool total, not an addition. Summing gives ~$6,400 against
    // a true ~$4,786 — wrong by a third on the page's headline figure.
    const p1 = poolValue(M1, ALGO);
    const p2 = poolValue(M2, ALGO);
    const cvaNav = CVA.m1MarkUsd + CVA.m2MarkUsd;
    const t = liquidityTotals([p1, p2], cvaNav);

    expect(t.totalUsd).toBeCloseTo(p1.totalUsd + p2.totalUsd, 6);
    expect(t.totalUsd).not.toBeCloseTo(p1.totalUsd + p2.totalUsd + cvaNav, 2);
    expect(t.totalUsd).toBeGreaterThan(4_700);
    expect(t.totalUsd).toBeLessThan(4_900);
  });

  it("splits the total into vault-held and direct, which must sum back", () => {
    const t = liquidityTotals([{ totalUsd: 2_600 }, { totalUsd: 2_185 }], 1_625.22);
    expect(t.viaCvaUsd + t.directUsd).toBeCloseTo(t.totalUsd, 9);
    expect(t.directUsd).toBeCloseTo(4_785 - 1_625.22, 0);
  });

  it("never reports more vault-held capital than exists in the pools", () => {
    // A stale mark can exceed the pools it is a slice of. A negative "direct"
    // figure is nonsense, not a rounding error.
    const t = liquidityTotals([{ totalUsd: 1_000 }], 9_999);
    expect(t.viaCvaUsd).toBe(1_000);
    expect(t.directUsd).toBe(0);
  });

  it("handles an empty book without inventing capital", () => {
    const t = liquidityTotals([], 0);
    expect(t).toEqual({ totalUsd: 0, viaCvaUsd: 0, directUsd: 0 });
  });

  it("measures the vault's slice of each pool", () => {
    expect(cvaOwnershipFraction(
      { marketId: 1, lpShareAmount: CVA.m1Shares, markUsd: CVA.m1MarkUsd, targetWeightBps: 7000 },
      M1.shares)!).toBeCloseTo(0.4229, 3);
    expect(cvaOwnershipFraction(
      { marketId: 2, lpShareAmount: CVA.m2Shares, markUsd: CVA.m2MarkUsd, targetWeightBps: 3000 },
      M2.shares)!).toBeCloseTo(0.2229, 3);
  });

  it("has no opinion on ownership of a pool with no shares", () => {
    expect(cvaOwnershipFraction(
      { marketId: 1, lpShareAmount: 0, markUsd: 0, targetWeightBps: 0 }, 0)).toBeNull();
  });
});

describe("fee yield is the fee component, and says so", () => {
  it("reproduces the measured rates for both pools", () => {
    const days = 50.3;
    const y1 = feeYield({ longFeeAmount: M1.longFee, shortFeeAmount: M1.shortFee,
                          poolTotalUsd: poolValue(M1, ALGO).totalUsd, algoUsd: ALGO, days });
    const y2 = feeYield({ longFeeAmount: M2.longFee, shortFeeAmount: M2.shortFee,
                          poolTotalUsd: poolValue(M2, ALGO).totalUsd, algoUsd: ALGO, days });
    expect(y1.feesUsd).toBeCloseTo(53.18, 1);
    expect(y1.annualisedPct!).toBeCloseTo(14.8, 0);
    expect(y2.feesUsd).toBeCloseTo(2.56, 1);
    expect(y2.annualisedPct!).toBeCloseTo(0.85, 1);
  });

  it("is flagged as not-a-return, structurally", () => {
    // `isReturn: false` exists so a card cannot label this an expected return
    // without contradicting the value it is rendering.
    const y = feeYield({ longFeeAmount: 1, shortFeeAmount: 1, poolTotalUsd: 100, algoUsd: 1, days: 1 });
    expect(y.isReturn).toBe(false);
  });

  it("returns null rather than 0% when no rate can be computed", () => {
    // "0.0% APR" reads as a measured result. "—" reads as absent, which is true.
    for (const bad of [
      { poolTotalUsd: 0, days: 50 },
      { poolTotalUsd: 100, days: 0 },
      { poolTotalUsd: -5, days: 50 },
    ]) {
      const y = feeYield({ longFeeAmount: 1, shortFeeAmount: 1, algoUsd: ALGO, ...bad });
      expect(y.annualisedPct, JSON.stringify(bad)).toBeNull();
    }
  });

  it("reports zero fees as a real zero, not as unknown", () => {
    // A live pool that has genuinely earned nothing is a fact worth showing.
    const y = feeYield({ longFeeAmount: 0, shortFeeAmount: 0, poolTotalUsd: 1_000, algoUsd: ALGO, days: 30 });
    expect(y.annualisedPct).toBe(0);
    expect(y.feesUsd).toBe(0);
  });

  it("does not propagate a non-finite price into a rendered rate", () => {
    const y = feeYield({ longFeeAmount: 1, shortFeeAmount: 1, poolTotalUsd: 100, algoUsd: Number.NaN, days: 30 });
    expect(y.annualisedPct).toBeNull();
    expect(Number.isFinite(y.feesUsd)).toBe(true);
  });

  it("blends the vault's rate at its own weights, skipping unusable legs", () => {
    expect(blendedFeeYieldPct([
      { annualisedPct: 14.84, weight: 0.7 }, { annualisedPct: 0.85, weight: 0.3 },
    ])!).toBeCloseTo(10.64, 1);
    // A market whose rate is unknown must not be silently counted as 0%.
    expect(blendedFeeYieldPct([
      { annualisedPct: 20, weight: 0.5 }, { annualisedPct: null, weight: 0.5 },
    ])!).toBeCloseTo(20, 6);
    expect(blendedFeeYieldPct([{ annualisedPct: null, weight: 1 }])).toBeNull();
    expect(blendedFeeYieldPct([])).toBeNull();
  });

  it("counts days from the first deposit, not from app creation", () => {
    /**
     * Pinned to the CHAIN FACT, not to the constant.
     *
     * The previous version of this test asserted poolAgeDays against
     * `Date.UTC(2026, 7, 31)` — the same value the implementation used — so it
     * was self-confirming and passed happily while the date was wrong by two
     * days. The constant was taken from the first transaction on the markets
     * app, which is the app's CREATION; the pools were empty for nearly two
     * more days, and fees cannot accrue against capital that is not there.
     *
     * 2026-09-02T01:29:07Z is round 64,643,818, the first ever
     * `deposit_liquidity` call on PDexV2AdminOps (18 such calls exist; this is
     * the earliest). Changing the constant without changing the chain must
     * fail here.
     */
    const FIRST_DEPOSIT = Date.UTC(2026, 8, 2, 1, 29, 7);
    expect(poolAgeDays(FIRST_DEPOSIT)).toBe(0);

    // App creation was 2026-08-31T14:55:26Z. Dating from there would have the
    // pools already live for ~1.6 days before anyone had deposited.
    expect(poolAgeDays(Date.UTC(2026, 7, 31, 14, 55, 26))).toBe(0);

    // One day after the first deposit is one day of accrual, not three.
    expect(poolAgeDays(FIRST_DEPOSIT + 86_400_000)).toBeCloseTo(1, 6);

    // A clock behind the opening date must not produce negative days, which
    // would flip the sign of every rate on the page.
    expect(poolAgeDays(Date.UTC(2026, 0, 1))).toBe(0);
  });
});

describe("what the page may and may not touch", () => {
  it("knows both markets are ALGO-long / USDC-short", () => {
    // So no card can claim a USDC-only deposit for the direct-LP route.
    expect(LEG_ASSETS.long.symbol).toBe("ALGO");
    expect(LEG_ASSETS.long.assetId).toBe(0);
    expect(LEG_ASSETS.short.symbol).toBe("USDC");
    expect(LEG_ASSETS.short.assetId).toBe(PEX_ASSETS.usdc);
  });

  it("marks BTC/USD as synthetic — it holds no BTC", () => {
    expect(PEX_LIQUIDITY_MARKETS["btc-usd"].synthetic).toBe(true);
    expect(PEX_LIQUIDITY_MARKETS["algo-usd"].synthetic).toBe(false);
  });

  it("refuses a yield vault as a deposit target", () => {
    /**
     * This replaces a vacuous test.
     *
     * The old version asserted that NOT_LIQUIDITY_DESTINATIONS contained the
     * two ids listed two lines above it in the same module — true by
     * construction, referenced by nothing, and it would have passed unchanged
     * the day a deposit path wired one of them. `assertDepositTarget` is the
     * guard a deposit path must actually call, so this binds behaviour.
     */
    for (const app of [PEX_APPS.marketYieldVault, PEX_APPS.marketXAlgoYieldVault]) {
      expect(() => assertDepositTarget(app)).toThrow(/yield vault/);
      expect(NOT_LIQUIDITY_DESTINATIONS).toContain(app);
    }
  });

  it("accepts the three real destinations", () => {
    for (const app of [PEX_APPS.cvaVault, PEX_APPS.adminOps, PEX_APPS.singleTokenOps]) {
      expect(() => assertDepositTarget(app)).not.toThrow();
      expect(NOT_LIQUIDITY_DESTINATIONS).not.toContain(app);
    }
  });

  it("refuses an unknown app by default rather than allowing it", () => {
    // Allow-list first: a PEX app added later is refused until someone decides
    // it belongs, instead of being permitted because nobody denied it.
    expect(() => assertDepositTarget(PEX_APPS.trading)).toThrow(/not a known/);
    expect(() => assertDepositTarget(999_999_999)).toThrow(/not a known/);
  });

  it("glows purple for every destination, with none left unmapped", () => {
    // STRATEGY_SPEC.md §10 item 6. All three hold the same collateral, so a
    // gold card would assert a risk distinction that does not exist.
    expect(LIQUIDITY_DESTINATIONS).toHaveLength(3);
    for (const id of LIQUIDITY_DESTINATIONS) {
      expect(destinationGlowKind(id), id).toBe("magnet");
    }
  });
});

describe("composition and share price", () => {
  it("splits pool value between the legs", () => {
    const p = poolValue(M1, ALGO);
    expect(p.shortUsd).toBeCloseTo(1_952.05, 2);
    expect(p.longUsd).toBeCloseTo(5_717.05 * ALGO, 4);
    expect(p.longShare!).toBeCloseTo(0.249, 2);
  });

  it("has no composition for an empty pool", () => {
    expect(poolValue({ longAmount: 0, shortAmount: 0 }, ALGO).longShare).toBeNull();
  });

  it("reproduces both pool-value-per-share figures", () => {
    // NOT PEX's NAV per share: this omits trader P&L. See poolValuePerShare.
    expect(poolValuePerShare(poolValue(M1, ALGO).totalUsd, M1.shares)!).toBeCloseTo(1.1064, 3);
    expect(poolValuePerShare(poolValue(M2, ALGO).totalUsd, M2.shares)!).toBeCloseTo(1.1299, 3);
  });

  it("returns null, not 0, when no shares exist", () => {
    // 0 would render as a worthless share rather than an absent one.
    expect(poolValuePerShare(1_000, 0)).toBeNull();
  });
});

describe("the denominator assumption the fee APR rests on", () => {
  it("knows when LP capital last moved", () => {
    // PEX: "It is not seven-day income divided by today's TVL" — a warning
    // about a denominator that MOVED during the window. All 27 LP capital
    // events on PDexV2AdminOps fall between 2026-09-02 and 2026-09-18, the
    // last at 19:23Z. With capital constant since, the two definitions agree.
    expect(LP_CAPITAL_LAST_CHANGED_MS).toBe(Date.UTC(2026, 8, 18, 19, 23));
    // It must be AFTER the first deposit, or the window makes no sense.
    expect(LP_CAPITAL_LAST_CHANGED_MS).toBeGreaterThan(PEX_POOLS_OPENED_MS);
  });

  it("reports stability in days, clamped at zero", () => {
    expect(capitalStableDays(LP_CAPITAL_LAST_CHANGED_MS)).toBe(0);
    expect(capitalStableDays(LP_CAPITAL_LAST_CHANGED_MS + 32 * 86_400_000)).toBeCloseTo(32, 6);
    // A clock before the last event must not read as negative stability.
    expect(capitalStableDays(Date.UTC(2026, 0, 1))).toBe(0);
  });

  it("records the basis on every computed yield", () => {
    // So a card cannot label this "fees + yield APR" (PEX's wording for their
    // figure, which includes external yield ours omits) or "APY", which PEX
    // explicitly forbids for either value.
    const y = feeYield({ longFeeAmount: 1, shortFeeAmount: 1, poolTotalUsd: 100, algoUsd: 1, days: 7 });
    expect(y.basis).toBe("fees-since-inception");
  });
});
