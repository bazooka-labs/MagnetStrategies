/**
 * The two numbers on the Strategy page that can be wrong without anyone noticing.
 *
 * strategy/pools/SPEC.md §10. A double-counted total and a fabricated APR both render
 * perfectly plausibly, so they are bound here on values rather than left to a
 * reviewer spotting a `+`.
 */
import { describe, expect, it } from "vitest";
import {
  LEG_ASSETS, LIQUIDITY_DESTINATIONS, NOT_LIQUIDITY_DESTINATIONS, PEX_LIQUIDITY_MARKETS,
  assertDepositTarget, cvaOwnershipFraction, destinationGlowKind, liquidityTotals,
  poolValue, poolValuePerShare,
} from "./totals";
import { PEX_APPS, PEX_ASSETS } from "../perps";

/** Live snapshot, 2026-10-20 — see strategy/pools/SPEC.md §11. */
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
    // strategy/pools/SPEC.md §10 item 6. All three hold the same collateral, so a
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

