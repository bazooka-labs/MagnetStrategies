// Server-only $U TVL aggregation.
//
// DO NOT import this from pools.ts or any "use client" module. app/pools/page.tsx is a
// client component importing the runtime value DEX_LABEL from pools.ts, so pools.ts is in
// the client graph; anything it pulls in ships to browsers. This module is imported only
// by lib/tokenStats.ts (server). See ASA_TVL_SPEC.md §6.
//
// CONTRACT: fetchAggregateTvlUsd() never throws. /token is prerendered at build with no
// try/catch around fetchTVL() (app/token/page.tsx), so a throw here fails `next build`
// and would block shipping unrelated MagnetFi fixes.
//
// This module reads third-party HTTP APIs for DISPLAY ONLY. It is not an oracle and is not
// reachable from any MagnetFi code path.

import algosdk from "algosdk";
import { POOLS, DUST_POOLS, type Pool } from "@/lib/pools";

/** Off = shadow mode: aggregate is computed and logged, but the displayed TVL is unchanged.
 *  A module constant, not an env var, so flipping it is a reviewable code change and cannot
 *  redeploy the borrower-facing MagnetFi UI as a side effect. */
export const AGGREGATE_TVL_ENABLED = false;

const MAGNET_ASA_ID = 3081853135;
const LIQUIHOG = "https://hogswap-v1.liquihog.dev";
const TINYMAN = "https://mainnet.analytics.tinyman.org/api/v1/pools";
const PACT = "https://api.pact.fi/api/pools";
const INDEXER = "https://mainnet-idx.algonode.cloud";

// Application address of Pact's managed-weighted factory (app 3656084442). Reserves for
// these pools live in each pool's global state, NOT the pool account — the account holds
// only the LP token — which is why escrow-balance indexers (Vestige, LiquiHog) read them
// as empty. We enumerate them here, but value them via Pact's own API rather than our own
// reserve math, so no hand-rolled formula can be gamed by a permissionless pool.
const PACT_WEIGHTED_FACTORY_ADDR =
  "H2XDAFUDTEPTN24HNUAZI6RCKQ2KDIIO45U767FEHGSGSEGCWWOK4QEIXM";

// Aligned with the leaderboard's 80% floor so one confidence policy governs the product.
const MIN_CONFIDENCE_BPS = 8000;
const TIMEOUT_MS = 5000;
const UA = { "User-Agent": "Mozilla/5.0 (compatible; MagnetStrategies/1.0)" };

/** Canonical pool key. Tinyman pools are keyed by LP asset id (== LiquiHog's pool_id,
 *  verified for u-talgo/u-usdc/u-mooj); Pact pools by pool app id. */
type PoolKey = string;
const tinymanKey = (lpAssetId: number): PoolKey => `tm:${lpAssetId}`;
const pactKey = (poolId: number | string): PoolKey => `pact:${poolId}`;
const otherKey = (poolId: number): PoolKey => `lh:${poolId}`;

export type AggregateResult = {
  usdTotal: number;
  /** Sum of the hardcoded pools we valued with our own direct fetches. */
  floorUsd: number;
  /** Distinct pools contributing a value. */
  poolsCounted: number;
  /** Hardcoded pools our own fetch could not value. Some may still be counted via
   *  discovery: a failed Tinyman fetch loses the response that carries liquidity_asset.id,
   *  so its canonical key is unknowable and it cannot be matched against a discovered pool.
   *  Treat a non-zero value as "we fell back somewhere", not as "TVL is incomplete". */
  floorUnresolved: number;
  /** Pools whose value came from discovery (LiquiHog or the Pact weighted factory) rather
   *  than our own direct fetch. */
  fromDiscovery: number;
  guardsFired: string[];
};

// ── plumbing ────────────────────────────────────────────────────────────────────

async function getJson(url: string, revalidate: number): Promise<unknown | null> {
  try {
    const r = await fetch(url, {
      headers: UA,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      next: { revalidate },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

const rec = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Finite, non-negative number or null. Never coerces garbage to a contributing 0. */
function money(v: unknown): number | null {
  if (typeof v === "string" && v.trim() === "") return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function positiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ── source A: our own direct fetches (authoritative) ────────────────────────────

type Direct = { key: PoolKey; usd: number | null };

async function directTinyman(addr: string): Promise<Direct | null> {
  // Guard the address before interpolation — a numeric regex never fires here.
  if (!algosdk.isValidAddress(addr)) return null;
  const d = rec(await getJson(`${TINYMAN}/${addr}/`, 60));
  if (!d) return null;
  const lp = positiveInt(rec(d.liquidity_asset)?.id);
  if (lp === null) return null;
  return { key: tinymanKey(lp), usd: money(d.liquidity_in_usd) };
}

async function directPact(ref: string): Promise<Direct | null> {
  const id = positiveInt(ref);
  if (id === null) return null;
  const d = rec(await getJson(`${PACT}/${id}`, 60));
  return { key: pactKey(id), usd: d ? money(d.tvl_usd) : null };
}

const directFor = (p: Pick<Pool, "dex" | "ref">): Promise<Direct | null> =>
  p.dex === "tinyman" ? directTinyman(p.ref) : directPact(p.ref);

// ── source B: LiquiHog discovery + backstop values ──────────────────────────────

type Discovered = { key: PoolKey; usd: number; dex: string };

/** Every guard fails CLOSED on a missing or malformed field. */
function acceptLiquiHogPool(p: Record<string, unknown>, capUsd: number, fired: string[]): Discovered | null {
  const poolId = positiveInt(p.pool_id);
  if (poolId === null) { fired.push("pool_id"); return null; }

  // Reserve fields hold an exchange rate, not a balance, on rate-encoded pools. Absence of
  // this field is what produced 1.7 trillion ALGO in testing — require present AND false.
  if (p.tvl_rate_encoded !== false) { fired.push(`rate_encoded:${poolId}`); return null; }

  // Single-sided pricing values the unknown leg off the pool itself — circular.
  if (p.tvl_priced_sides !== 2) { fired.push(`priced_sides:${poolId}`); return null; }

  const conf = money(p.tvl_confidence_bps);
  if (conf === null || conf < MIN_CONFIDENCE_BPS) { fired.push(`confidence:${poolId}`); return null; }

  const micro = money(p.tvl_usd_micro);
  if (micro === null) { fired.push(`tvl_missing:${poolId}`); return null; }
  const usd = micro / 1e6;

  if (usd > capUsd) { fired.push(`cap:${poolId}`); return null; }

  const dex = typeof p.dex_name === "string" ? p.dex_name : "unknown";
  const lpAssetId = positiveInt(p.lp_asset_id);
  // Tinyman pools key on LP asset id so they dedupe against the hardcoded address entries.
  const key = dex.startsWith("Tinyman")
    ? tinymanKey(lpAssetId ?? poolId)
    : dex.startsWith("Pact")
      ? pactKey(poolId)
      : otherKey(poolId);
  return { key, usd, dex };
}

async function discoverLiquiHog(capUsd: number, fired: string[]): Promise<Discovered[]> {
  const d = rec(await getJson(`${LIQUIHOG}/assets/${MAGNET_ASA_ID}/pools`, 60));
  const list = Array.isArray(d?.pools) ? (d.pools as unknown[]) : null;
  if (!list) return [];
  const out: Discovered[] = [];
  for (const raw of list) {
    const p = rec(raw);
    if (!p) continue;
    const ok = acceptLiquiHogPool(p, capUsd, fired);
    if (ok) out.push(ok);
  }
  return out;
}

// ── source C: Pact managed-weighted discovery (invisible to LiquiHog/Vestige) ────

function decodeGlobalState(app: Record<string, unknown>): Record<string, number> {
  const params = rec(app.params);
  const gs = Array.isArray(params?.["global-state"]) ? (params["global-state"] as unknown[]) : [];
  const out: Record<string, number> = {};
  for (const raw of gs) {
    const kv = rec(raw);
    const value = rec(kv?.value);
    if (!kv || !value || value.type !== 2) continue;
    try {
      const key = Buffer.from(String(kv.key), "base64").toString("utf8");
      const n = money(value.uint);
      if (n !== null) out[key] = n;
    } catch { /* skip undecodable key */ }
  }
  return out;
}

/** Returns Pact pool app ids for bootstrapped, non-empty weighted pools containing $U.
 *  Paginated — an un-paginated limit=1000 silently truncates, i.e. understates. */
async function discoverPactWeightedIds(): Promise<number[]> {
  const ids: number[] = [];
  let next: string | undefined;
  for (let page = 0; page < 10; page++) {
    const q = new URLSearchParams({ creator: PACT_WEIGHTED_FACTORY_ADDR, limit: "1000" });
    if (next) q.set("next", next);
    const d = rec(await getJson(`${INDEXER}/v2/applications?${q}`, 300));
    const apps = Array.isArray(d?.applications) ? (d.applications as unknown[]) : null;
    if (!apps) break;
    for (const raw of apps) {
      const app = rec(raw);
      const id = positiveInt(app?.id);
      if (!app || id === null || app.deleted === true) continue;
      const s = decodeGlobalState(app);
      if (s.bootstrapped !== 1) continue;
      if (!s.reserve_a || !s.reserve_b) continue;
      if (s.asset_a !== MAGNET_ASA_ID && s.asset_b !== MAGNET_ASA_ID) continue;
      ids.push(id);
    }
    next = typeof d?.["next-token"] === "string" ? (d["next-token"] as string) : undefined;
    if (!next) break;
  }
  return ids;
}

// ── union ───────────────────────────────────────────────────────────────────────

/** Aggregate $U TVL in USD. Never throws. Returns null only if nothing could be valued. */
export async function fetchAggregateTvlUsd(): Promise<AggregateResult | null> {
  try {
    const guardsFired: string[] = [];
    const floorPools: Pick<Pool, "dex" | "ref">[] = [...POOLS, ...DUST_POOLS];

    // 1. Hardcoded floor via our own direct fetches — authoritative.
    const directs = await Promise.all(floorPools.map((p) => directFor(p).catch(() => null)));
    const values = new Map<PoolKey, number>();
    const known = new Set<PoolKey>();
    let floorUsd = 0;
    let floorUnresolved = 0;

    for (const d of directs) {
      // A null result means the fetch failed before we could learn the pool's canonical key.
      if (!d) { floorUnresolved++; continue; }
      known.add(d.key);
      if (d.usd === null) { floorUnresolved++; continue; }
      values.set(d.key, d.usd);
      floorUsd += d.usd;
    }

    // Per-pool cap: no single DISCOVERED pool may exceed the entire known floor. An earlier
    // 40%-of-floor cap was wrong — measured 2026-09-06, the largest legitimate $U pool
    // (u-talgo, Tinyman 3163770927) is ~48% of the floor on its own, so 40% rejected a real
    // pool. It was harmless only because our own direct fetch had already valued it; had that
    // fetch failed, the cap would have discarded a $20.9k backstop and understated TVL.
    const capUsd = Math.max(floorUsd, 1_000);

    // 2. Discovery. Failures here degrade to the floor; they never reduce it.
    const [lh, weightedIds] = await Promise.all([
      discoverLiquiHog(capUsd, guardsFired).catch(() => [] as Discovered[]),
      discoverPactWeightedIds().catch(() => [] as number[]),
    ]);

    let fromDiscovery = 0;

    // 2a. LiquiHog: adds unseen pools, and backstops pools our own fetch could not value.
    for (const p of lh) {
      if (values.has(p.key)) continue;              // precedence: our own value wins
      known.add(p.key);
      values.set(p.key, p.usd);
      fromDiscovery++;
    }

    // 2b. Pact weighted pools, valued via Pact's own API (not our own reserve math).
    const weightedNew = weightedIds.filter((id) => !values.has(pactKey(id)));
    const weighted = await Promise.all(weightedNew.map((id) => directPact(String(id)).catch(() => null)));
    for (const w of weighted) {
      if (!w || w.usd === null) continue;
      if (w.usd > capUsd) { guardsFired.push(`cap:${w.key}`); continue; }
      if (values.has(w.key)) continue;
      known.add(w.key);
      values.set(w.key, w.usd);
      fromDiscovery++;
    }

    if (values.size === 0) return null;

    let usdTotal = 0;
    for (const v of values.values()) usdTotal += v;

    return {
      usdTotal,
      floorUsd,
      poolsCounted: values.size,
      floorUnresolved,
      fromDiscovery,
      guardsFired,
    };
  } catch {
    return null;   // contract: never throw
  }
}
