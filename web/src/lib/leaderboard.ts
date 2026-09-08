// Server-only top-100 ASA leaderboard by TVL. Powers the TVL Rank stat on /token.
//
// Convention: TWO-SIDED TVL — an asset's TVL is the full value of every pool containing it,
// matching fetchTotalTvlUsd() and the figure on /token. Per-asset figures therefore double
// count; NEVER sum the column for an ecosystem total. See ASA_TVL_SPEC.md.
//
// Not an oracle. Display only. No MagnetFi code path reads this.

const LIQUIHOG = "https://hogswap-v1.liquihog.dev";
const INDEXER = "https://mainnet-idx.algonode.cloud";
const PACT_WEIGHTED_FACTORY_ADDR =
  "H2XDAFUDTEPTN24HNUAZI6RCKQ2KDIIO45U767FEHGSGSEGCWWOK4QEIXM";

/** Venues that are NOT DEX liquidity pools. A dualstake mint contract holds staked/locked
 *  supply, not two-sided swappable liquidity, and cannot be withdrawn against like an LP
 *  position — so it does not belong on a board measuring DEX liquidity. Folks Lend and the
 *  xALGO/tALGO mint contracts are already dropped by the rate-encoded guard (their reserve
 *  fields hold an exchange rate); dualstake is not rate-encoded, so it needs naming here.
 *  Measured 2026-09-07: including these inflated ORA by 38% and COOP by 42%, and moved 75
 *  of the top 100. */
const NON_LP_VENUES = new Set([
  "dualstake mint",
  "xALGO mint/burn",
  "tALGO mint/burn",
  "Folks Lend",
]);

/** Eligibility floor, deliberately matched to Vestige's 80% model so rankings stay familiar
 *  to anyone who used it. 80% is also the measured point at which junk disappears: below it,
 *  entries like AlgoBrent (1 pool, 1 bps) reach the top 100.
 *  Raising it to 85% excluded the Meld RWA tokens — GOLD$ at 8306 bps across 48 pools and
 *  SILVER$ at 8149 across 40 — which are plainly legitimate, so 85% cost more than it bought.
 *  Also admits fGOLD$/fSILVER$, consistent with fALGO/fUSDC already ranking. */
const MIN_ASSET_CONFIDENCE_BPS = 8000;
const MIN_POOL_CONFIDENCE_BPS = 3000;
const MIN_POOLS = 2;
/** Pool floor, kept low so the eligible count (the rank denominator) reflects the real
 *  universe rather than an arbitrary cutoff. 10 ALGO excludes only empty/locked-minimum
 *  pools; a 100 ALGO floor halved the denominator (791 -> 396) without moving any rank. */
const MIN_POOL_TVL_ALGO_MICRO = 10_000_000;
const TIMEOUT_MS = 8000;
const UA = { "User-Agent": "Mozilla/5.0 (compatible; MagnetStrategies/1.0)" };

export const MAGNET_ASA_ID = 3081853135;

export type BoardRow = {
  rank: number;
  assetId: number;
  unit: string | null;
  name: string | null;
  tvlAlgo: number;
  tvlUsd: number;
  pools: number;
  confidenceBps: number;
};

export type Board = {
  asOfRound: number;
  algoUsd: number;
  /** Assets meeting the eligibility floor — the denominator for a rank. */
  eligible: number;
  top: BoardRow[];
  /** $U's row, even when it sits outside the top 100. */
  magnet: BoardRow | null;
};

async function getJson(url: string, revalidate: number): Promise<unknown | null> {
  try {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(TIMEOUT_MS), next: { revalidate } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}
const rec = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const posInt = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && Number.isInteger(n) && n > 0 ? n : null;
};

type Meta = { unit: string | null; name: string | null; dec: number; lp: boolean };
type Price = { algo: number; conf: number };

async function loadPrices(): Promise<{ prices: Map<number, Price>; algoUsd: number; round: number } | null> {
  const d = rec(await getJson(`${LIQUIHOG}/analytics/prices`, 120));
  const body = rec(d?.prices);
  const algoUsd = num(d?.algo_usd);
  if (!body || algoUsd === null || algoUsd <= 0) return null;
  const prices = new Map<number, Price>();
  for (const [k, v] of Object.entries(body)) {
    const id = num(k);
    const p = rec(v);
    const algo = num(p?.price_algo);
    const conf = num(p?.confidence_bps);
    if (id === null || algo === null || algo <= 0 || conf === null) continue;
    prices.set(id, { algo, conf });
  }
  return { prices, algoUsd, round: num(d?.as_of_round) ?? 0 };
}

async function loadMeta(): Promise<Map<number, Meta>> {
  const out = new Map<number, Meta>();
  let cursor: string | undefined;
  for (let page = 0; page < 12; page++) {
    const q = new URLSearchParams({ limit: "500" });
    if (cursor) q.set("cursor", cursor);
    const d = rec(await getJson(`${LIQUIHOG}/assets?${q}`, 600));
    const list = Array.isArray(d?.assets) ? (d.assets as unknown[]) : null;
    if (!list) break;
    for (const raw of list) {
      const a = rec(raw);
      const id = num(a?.asset_id);
      const dec = num(a?.decimals);
      if (id === null || dec === null || dec < 0) continue;
      out.set(id, {
        unit: typeof a?.unit_name === "string" ? a.unit_name : null,
        name: typeof a?.name === "string" ? a.name : null,
        dec,
        lp: a?.is_lp_token === true,
      });
    }
    cursor = typeof d?.next_cursor === "string" ? d.next_cursor : undefined;
    if (!cursor) break;
  }
  return out;
}

type RawPool = { a: number; b: number; tvlAlgo: number; lpAssetId: number | null };

async function loadPools(): Promise<{ pools: RawPool[]; round: number }> {
  const pools: RawPool[] = [];
  let cursor: string | undefined;
  let round = 0;
  for (let page = 0; page < 12; page++) {
    const q = new URLSearchParams({ limit: "500", min_tvl_algo_micro: String(MIN_POOL_TVL_ALGO_MICRO) });
    if (cursor) q.set("cursor", cursor);
    const d = rec(await getJson(`${LIQUIHOG}/pools?${q}`, 120));
    const list = Array.isArray(d?.pools) ? (d.pools as unknown[]) : null;
    if (!list) break;
    round = num(d?.as_of_round) ?? round;
    for (const raw of list) {
      const p = rec(raw);
      if (!p) continue;
      // Same guards as the $U aggregation, all failing closed: rate-encoded pools hold an
      // exchange rate rather than a balance, and single-sided pricing is circular.
      if (typeof p.dex_name !== "string" || NON_LP_VENUES.has(p.dex_name)) continue;
      if (p.tvl_rate_encoded !== false) continue;
      if (p.tvl_priced_sides !== 2) continue;
      const conf = num(p.tvl_confidence_bps);
      if (conf === null || conf < MIN_POOL_CONFIDENCE_BPS) continue;
      const tvl = num(p.tvl_algo_micro);
      const a = num(p.asset_a);
      const b = num(p.asset_b);
      if (tvl === null || tvl <= 0 || a === null || b === null) continue;
      pools.push({ a, b, tvlAlgo: tvl / 1e6, lpAssetId: posInt(p.lp_asset_id) });
    }
    cursor = typeof d?.next_cursor === "string" ? d.next_cursor : undefined;
    if (!cursor) break;
  }
  return { pools, round };
}

/** Pact managed-weighted pools — invisible to LiquiHog and Vestige because their reserves
 *  live in pool global state, not the pool account. Valued from reserves x price, requiring
 *  BOTH sides independently priced above the confidence floor. */
async function loadWeightedPools(prices: Map<number, Price>, meta: Map<number, Meta>): Promise<RawPool[]> {
  const out: RawPool[] = [];
  let next: string | undefined;
  for (let page = 0; page < 5; page++) {
    const q = new URLSearchParams({ creator: PACT_WEIGHTED_FACTORY_ADDR, limit: "1000" });
    if (next) q.set("next", next);
    const d = rec(await getJson(`${INDEXER}/v2/applications?${q}`, 300));
    const apps = Array.isArray(d?.applications) ? (d.applications as unknown[]) : null;
    if (!apps) break;
    for (const raw of apps) {
      const app = rec(raw);
      if (!app || app.deleted === true) continue;
      const params = rec(app.params);
      const gs = Array.isArray(params?.["global-state"]) ? (params["global-state"] as unknown[]) : [];
      const s: Record<string, number> = {};
      for (const kvRaw of gs) {
        const kv = rec(kvRaw);
        const val = rec(kv?.value);
        if (!kv || !val || val.type !== 2) continue;
        try {
          const key = Buffer.from(String(kv.key), "base64").toString("utf8");
          const n = num(val.uint);
          if (n !== null) s[key] = n;
        } catch { /* skip */ }
      }
      if (s.bootstrapped !== 1 || !s.reserve_a || !s.reserve_b) continue;
      const a = s.asset_a;
      const b = s.asset_b;
      const pa = prices.get(a);
      const pb = prices.get(b);
      const ma = meta.get(a);
      const mb = meta.get(b);
      if (!pa || !pb || !ma || !mb) continue;
      if (pa.conf < MIN_ASSET_CONFIDENCE_BPS || pb.conf < MIN_ASSET_CONFIDENCE_BPS) continue;
      const va = (s.reserve_a / 10 ** ma.dec) * pa.algo;
      const vb = (s.reserve_b / 10 ** mb.dec) * pb.algo;
      if (!Number.isFinite(va) || !Number.isFinite(vb) || va <= 0 || vb <= 0) continue;
      out.push({ a, b, tvlAlgo: va + vb, lpAssetId: posInt(s.lp_asset) });
    }
    next = typeof d?.["next-token"] === "string" ? (d["next-token"] as string) : undefined;
    if (!next) break;
  }
  return out;
}

/** Compute the board. Never throws; returns null if the data layer is unavailable. */
export async function fetchBoard(): Promise<Board | null> {
  try {
    const priced = await loadPrices();
    if (!priced) return null;
    const { prices, algoUsd } = priced;

    const [meta, poolsRes] = await Promise.all([loadMeta(), loadPools()]);
    const weighted = await loadWeightedPools(prices, meta);
    const pools = [...poolsRes.pools, ...weighted];
    if (pools.length === 0) return null;

    // LP tokens are excluded from the ranking. Derived from the pool set itself rather than
    // asset metadata, so a pool's LP token can never rank as if it were a traded asset.
    const lpTokens = new Set<number>();
    for (const p of pools) if (p.lpAssetId) lpTokens.add(p.lpAssetId);

    const tvl = new Map<number, number>();
    const count = new Map<number, number>();
    for (const p of pools) {
      for (const id of [p.a, p.b]) {
        if (lpTokens.has(id) || meta.get(id)?.lp) continue;
        tvl.set(id, (tvl.get(id) ?? 0) + p.tvlAlgo);   // two-sided: full pool value per side
        count.set(id, (count.get(id) ?? 0) + 1);
      }
    }

    const eligible = [...tvl.entries()]
      .filter(([id]) => {
        const conf = prices.get(id)?.conf ?? 0;
        return conf >= MIN_ASSET_CONFIDENCE_BPS && (count.get(id) ?? 0) >= MIN_POOLS;
      })
      .sort((x, y) => y[1] - x[1]);
    if (eligible.length === 0) return null;

    const row = (id: number, value: number, rank: number): BoardRow => ({
      rank,
      assetId: id,
      unit: meta.get(id)?.unit ?? null,
      name: meta.get(id)?.name ?? null,
      tvlAlgo: value,
      tvlUsd: value * algoUsd,
      pools: count.get(id) ?? 0,
      confidenceBps: prices.get(id)?.conf ?? 0,
    });

    const top = eligible.slice(0, 100).map(([id, v], i) => row(id, v, i + 1));
    const magnetIdx = eligible.findIndex(([id]) => id === MAGNET_ASA_ID);
    const magnet =
      magnetIdx >= 0 ? row(MAGNET_ASA_ID, eligible[magnetIdx][1], magnetIdx + 1) : null;

    return { asOfRound: poolsRes.round, algoUsd, eligible: eligible.length, top, magnet };
  } catch {
    return null;
  }
}
