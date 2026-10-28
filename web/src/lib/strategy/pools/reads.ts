/**
 * Chain reads for the Strategy page.
 *
 * Boxes only — no PEX API call anywhere, matching the terminal's posture (its
 * manifest is vendored and hash-pinned, and the one third-party HTTP response in
 * its signing path is signature-verified). A liquidity page that fetched pool
 * sizes from an endpoint would be trusting a number it is asking people to
 * deposit against.
 *
 * Market core and pool reads are reused from perpsReads rather than
 * reimplemented; only the two box families the terminal never needed are new.
 */

import algosdk from "algosdk";
import { PEX_APPS, PEX_ASSETS } from "@/lib/strategy/pex/config";
import { readMarketCore, readMarketPool, readMarketRisk, readOpenInterest } from "@/lib/strategy/pex/reads";
import {
  LEG_ASSETS, PEX_LIQUIDITY_MARKETS, type CvaAllocation, type LiquidityDestinationId,
  cvaOwnershipFraction, liquidityTotals,
  poolValue, poolValuePerShare, type PoolValue,
} from "./totals";

const MICRO = 1_000_000;
const micro = (v: bigint) => Number(v) / MICRO;

/** Box key: prefix + a uint64, or prefix + a 32-byte address. */
function key(prefix: string, tail: number | string): Uint8Array {
  const head = new TextEncoder().encode(prefix);
  const rest = typeof tail === "number"
    ? algosdk.encodeUint64(BigInt(tail))
    : algosdk.decodeAddress(tail).publicKey;
  return new Uint8Array([...head, ...rest]);
}

/**
 * Decode the first `n` uint64 words of a box.
 *
 * Tolerates a LONGER box (PEX appending a field is forward-compatible) and
 * refuses a shorter one with a message that names the problem. Without the
 * guard a shortened layout threw `RangeError: Offset is outside the bounds of
 * the DataView`, which `isNotFound` does not match, which failed the whole page
 * read with an opaque error — the same reasoning as `decodeWords` in
 * perpsReads.
 */
const WORDS = (v: Uint8Array, n: number, what: string): bigint[] => {
  if (v.byteLength < n * 8) {
    throw new Error(
      `${what}: box has ${Math.floor(v.byteLength / 8)} words, layout expects ${n} — `
      + "pinned layout is stale against the deployed contract");
  }
  const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
  return Array.from({ length: n }, (_, i) => dv.getBigUint64(i * 8));
};

const isNotFound = (e: unknown) =>
  !!e && typeof e === "object" && "status" in e && (e as { status: number }).status === 404;

// ── the C-Vault ───────────────────────────────────────────────────────────────

/**
 * `gm2:` — the vault's LP position in one market.
 *
 * This is the box that makes the deduplication necessary: `lp_share_amount` is
 * shares of that market's pool, so the vault's capital is INSIDE the pool, not
 * beside it.
 */
export async function readCvaAllocation(
  algod: algosdk.Algodv2, marketId: number,
): Promise<CvaAllocation | null> {
  try {
    const box = await algod.getApplicationBoxByName(PEX_APPS.cvaVault, key("gm2:", marketId)).do();
    const w = WORDS(box.value, 11, "cva_market_allocation");
    return {
      marketId: Number(w[0]),
      lpShareAmount: micro(w[2]),
      markUsd: micro(w[3]),
      targetWeightBps: Number(w[6]),
    };
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/** `gu2:` — one depositor's vault shares. Null when they have never deposited. */
export async function readCvaUserShares(
  algod: algosdk.Algodv2, address: string,
): Promise<number | null> {
  try {
    const box = await algod.getApplicationBoxByName(PEX_APPS.cvaVault, key("gu2:", address)).do();
    return micro(WORDS(box.value, 5, "cva_user_state")[0]);
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/** `ml2:` box name. Key is marketId THEN address. */
export const lpStateBoxName = (marketId: number, address: string) =>
  new Uint8Array([
    ...new TextEncoder().encode("ml2:"),
    ...algosdk.encodeUint64(BigInt(marketId)),
    ...algosdk.decodeAddress(address).publicKey,
  ]);

/**
 * `ml2:` — one LP's position in one market.
 *
 * Two words, confirmed against the deployed bytecode AND a live box:
 *
 *     word 0  share_amount   micro
 *     word 1  updated_at     unix seconds
 *
 * `updated_at` is not decoration — the Markets app asserts
 * `LatestTimestamp >= updated_at + 3600` before it will let shares out
 * (`markets.teal:2824-2831`, `:3149-3156`), so this word IS the withdrawal
 * cooldown. It is read here rather than in the preflight because this is the
 * module that owns box layout.
 */
export type LpState = { shares: number; updatedAtSec: number };

export async function readLpState(
  algod: algosdk.Algodv2, marketId: number, address: string,
): Promise<LpState | null> {
  try {
    const box = await algod
      .getApplicationBoxByName(PEX_APPS.markets, lpStateBoxName(marketId, address)).do();
    const w = WORDS(box.value, 2, "lp_state");
    return { shares: micro(w[0]), updatedAtSec: Number(w[1]) };
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/** Shares only. Null when this wallet has never provided to this market. */
export async function readLpShares(
  algod: algosdk.Algodv2, marketId: number, address: string,
): Promise<number | null> {
  const st = await readLpState(algod, marketId, address);
  return st === null ? null : st.shares;
}

// ── assembled view ────────────────────────────────────────────────────────────

/**
 * How full a market is.
 *
 * `max_open_interest_long/short` are **admin-set risk parameters**, not
 * pool-derived — word 4/5 of `market_risk`. Depositing does not raise them.
 * Market 1 was at $2,195.60 of $2,200.00 when this was written, so a depositor
 * who could not see this would have had no way to know the market was full.
 */
export type OiStatus = {
  longUsd: number;
  capLongUsd: number;
  /** 0..1 of the cap in use. Null when no cap is set. */
  utilisation: number | null;
};

export type MarketLiquidity = {
  id: Extract<LiquidityDestinationId, "algo-usd" | "btc-usd">;
  marketId: number;
  label: string;
  synthetic: boolean;
  legs: { longAmount: number; shortAmount: number };
  value: PoolValue;
  shareSupply: number;
  /** Pool value ÷ shares — NOT PEX's NAV, which includes trader P&L. */
  poolValuePerShare: number | null;
  /**
   * Cumulative trading fees the pool has earned since it opened, USD.
   *
   * A STOCK, not a rate. The rate that used to live here annualised this
   * against the current pool and read 15.3% where PEX's actual fee APR is
   * 4.83% — trading has slowed 4.1x since inception, so an inception average
   * is not what a depositor would earn today. The APR now comes from PEX's
   * published feed (pexPerformance.ts); this stays because "the pool has
   * earned $53 since it opened" is true and worth knowing, and no arithmetic
   * here can turn it back into a misleading rate.
   */
  feesSinceInceptionUsd: number;
  /** The viewer's shares, null when not connected or never deposited. */
  yourShares: number | null;
  /** True when both legs really are ALGO/USDC, read from chain not assumed. */
  legsVerified: boolean;
  /** True when the index asset is the synthetic sentinel — read, not hardcoded. */
  syntheticVerified: boolean;
  oi: OiStatus;
};

export type StrategyLiquidity = {
  markets: MarketLiquidity[];
  cva: {
    navUsd: number | null;
    allocations: CvaAllocation[];
    totalMarkets: number;
    yourShares: number | null;
    /**
     * Shares outstanding, and the price the CONTRACT prices them at.
     *
     * Deliberately the vault's own `total_nav_usd / total_cva_shares` globals
     * rather than `navUsd` above, which we derive live from the pools. The two
     * agree closely (chain-derived $1.1907 against the contract's $1.1907 when
     * last checked, and against PEX's published share price of $1.190755), but
     * they are not the same quantity: the contract's is what a withdrawal is
     * actually priced against, and it is the one the withdraw form already
     * uses. A card that valued a position differently from the form that
     * spends it would be reporting a discrepancy we invented.
     *
     * Null when the globals could not be read, never 0 — "no shares exist" and
     * "we could not read it" are the same pixels meaning opposite things.
     */
    totalShares: number | null;
    navPerShare: number | null;
    /** The user's position in dollars, at the contract's own share price. */
    yourUsd: number | null;
  };
  totals: ReturnType<typeof liquidityTotals>;
  algoUsd: number;
};

/**
 * Everything the page shows, in one pass.
 *
 * `address` optional: the page reads without a wallet, and a position is simply
 * absent rather than the page refusing to render.
 */
export async function readStrategyLiquidity(
  algod: algosdk.Algodv2, algoUsd: number, address?: string | null,
): Promise<StrategyLiquidity> {
  const ids = ["algo-usd", "btc-usd"] as const;

  const markets = await Promise.all(ids.map(async (id): Promise<MarketLiquidity> => {
    const { marketId, label, synthetic } = PEX_LIQUIDITY_MARKETS[id];
    const [core, pool, risk, oi, yourShares] = await Promise.all([
      readMarketCore(algod, marketId),
      readMarketPool(algod, marketId),
      readMarketRisk(algod, marketId),
      readOpenInterest(algod, marketId),
      address ? readLpShares(algod, marketId, address) : Promise.resolve(null),
    ]);
    const legs = {
      longAmount: micro(pool.long_pool_amount),
      shortAmount: micro(pool.short_pool_amount),
    };
    const value = poolValue(legs, algoUsd);
    return {
      id, marketId, label, synthetic, legs, value,
      shareSupply: micro(pool.market_share_supply),
      poolValuePerShare: poolValuePerShare(value.totalUsd, micro(pool.market_share_supply)),
      feesSinceInceptionUsd:
        micro(pool.long_fee_amount) * algoUsd + micro(pool.short_fee_amount),
      yourShares,
      oi: (() => {
        const longUsd = micro(oi.long_oi_usd_with_long_collateral)
          + micro(oi.long_oi_usd_with_short_collateral);
        const capLongUsd = micro(risk.max_open_interest_long);
        return {
          longUsd, capLongUsd,
          utilisation: capLongUsd > 0 ? longUsd / capLongUsd : null,
        };
      })(),
      // Read, not trusted: if PEX ever lists a market whose legs are not
      // ALGO/USDC, the card must stop claiming they are rather than keep
      // rendering a composition bar that does not describe the pool.
      legsVerified: Number(core.long_asset_id) === LEG_ASSETS.long.assetId
        && Number(core.short_asset_id) === LEG_ASSETS.short.assetId,
      // "There is no BTC in this pool" is the page's most surprising honesty
      // claim, and it was the one claim taken from a hardcoded table while the
      // data to verify it sat unread in `core`. The sentinel is PEX_ASSETS.btcIndex.
      syntheticVerified: Number(core.index_asset_id) === PEX_ASSETS.btcIndex,
    };
  }));

  const allocations = (await Promise.all(
    ids.map((id) => readCvaAllocation(algod, PEX_LIQUIDITY_MARKETS[id].marketId)),
  )).filter((a): a is CvaAllocation => a !== null);

  // Null, not 0, when no allocation box could be read. PEX deletes a `gm2:`
  // box when it rebalances fully out of a market, so "$0" and "we could not
  // read it" are the same pixels meaning opposite things.
  /**
   * Vault NAV derived LIVE from share ratios, not from PEX's stored mark.
   *
   * `last_mark_value_usd` only moves on a deposit or rebalance — the vault's
   * own `max_nav_age_rounds` is 5, i.e. PEX itself refuses to transact on a
   * mark this old, and ours was ~54 minutes stale when checked. Rendering it
   * beside a live-derived "42% C-VAULT" badge put two bases for one quantity
   * on screen, visibly disagreeing ($1,138 next to 42% of $2,600 ≈ $1,100).
   *
   * One basis: the vault's shares over the pool's supply, times the pool's
   * value. It agrees with the badge, with the pool totals, and with the dedup
   * split by construction — and it is as fresh as the pool read.
   *
   * ⚠️ This premise holds only while the vault's capital is entirely IN the
   * pools. `idle_long_amount`/`idle_short_amount` on the vault are both 0
   * today; non-zero idle cash would be NAV outside any pool, and both this and
   * `liquidityTotals`' "the vault is a slice" assumption would need revisiting.
   */
  /**
   * The vault's own share accounting, straight off its globals.
   *
   * Read here rather than derived, and tolerant of failure: the page's job is
   * the pools, and a vault global we cannot read should cost the three share
   * stats, not the whole render. `readCvaVaultState` throws deliberately on a
   * renamed global (a stale pinned layout), and that throw belongs to the
   * signing path, not to a card.
   */
  const [shareState, yourShares] = await Promise.all([
    readCvaShareState(algod),
    address ? readCvaUserShares(algod, address) : Promise.resolve(null),
  ]);

  const byMarketPre = new Map(markets.map((m) => [m.marketId, m]));
  const navUsd = allocations.length > 0
    ? allocations.reduce((acc, alloc) => {
        const mk = byMarketPre.get(alloc.marketId);
        if (!mk || mk.shareSupply <= 0) return acc;
        return acc + (alloc.lpShareAmount / mk.shareSupply) * mk.value.totalUsd;
      }, 0)
    : null;
  return {
    markets,
    cva: {
      navUsd,
      allocations,
      // Weighted by what the vault actually holds, not by its target weights —
      // targets are an intent, holdings are the position earning the fees.
      // No blended rate here any more: PEX publishes the vault's own APR under
      // its own key, following the vault's historical ownership and counting
      // idle capital in the denominator — neither of which a blend of ours
      // could do.
      totalMarkets: allocations.length,
      yourShares: yourShares,
      totalShares: shareState?.totalShares ?? null,
      navPerShare: shareState?.navPerShare ?? null,
      yourUsd: yourShares !== null && shareState ? yourShares * shareState.navPerShare : null,
    },
    totals: liquidityTotals(markets.map((m) => m.value), navUsd ?? 0),
    algoUsd,
  };
}

/**
 * The vault's share supply and the price its own contract puts on a share.
 *
 * ── Why this reads the globals directly ──
 * `readCvaVaultState` in preflight.ts reads the same app and THROWS when a
 * pinned global is missing, because every gate it feeds would otherwise read
 * as "fine" against a layout that moved. That is correct for the signing path
 * and wrong here: these three numbers are displayed, never signed against, and
 * a vault rename should blank three stats rather than break the page. So this
 * returns null where that one throws.
 *
 * Both globals are in micro-units (1e6), confirmed against the chain:
 * total_nav_usd 1667725953 and total_cva_shares 1400654055 give $1,667.73
 * over 1,400.654 shares = $1.190677 — which agrees with the share price PEX
 * publishes in its own performance bundle ($1.190755, a few hours older).
 */
async function readCvaShareState(
  algod: algosdk.Algodv2,
): Promise<{ totalShares: number; navPerShare: number } | null> {
  try {
    const app = await algod.getApplicationByID(PEX_APPS.cvaVault).do();
    let navMicro: number | null = null;
    let shareMicro: number | null = null;
    for (const kv of app.params.globalState ?? []) {
      const k = Buffer.from(kv.key as unknown as Uint8Array).toString("utf8");
      if (k === "total_nav_usd") navMicro = Number(kv.value?.uint ?? 0);
      if (k === "total_cva_shares") shareMicro = Number(kv.value?.uint ?? 0);
    }
    if (navMicro === null || shareMicro === null) return null;
    const totalShares = shareMicro / 1e6;
    // A vault with no shares has no share price. Returning 0 would value every
    // position at zero rather than declining to value it.
    if (totalShares <= 0) return null;
    return { totalShares, navPerShare: navMicro / 1e6 / totalShares };
  } catch {
    return null;
  }
}

/** The vault's slice of one market, for display beside that market's card. */
export const cvaShareOfMarket = (
  l: StrategyLiquidity, marketId: number,
): number | null => {
  const alloc = l.cva.allocations.find((a) => a.marketId === marketId);
  const market = l.markets.find((m) => m.marketId === marketId);
  return alloc && market ? cvaOwnershipFraction(alloc, market.shareSupply) : null;
};
