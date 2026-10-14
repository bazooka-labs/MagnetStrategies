// $U liquidity pools showcased on /pools. Live fee + farm APRs are fetched server-side
// (see app/api/pools/route.ts): Tinyman by pool address, Pact by pool id. Farm APR
// appears automatically whenever a DEX runs an incentive program — no manual upkeep.

export type PoolDex = "tinyman" | "pact";

/** One pool on one DEX. A pair can live on several. */
export type Venue = {
  dex: PoolDex;
  ref: string;     // tinyman → pool account address; pact → pool id
  addLiquidityUrl: string;
};

export type Pool = {
  id: string;      // internal key
  pair: string;    // display, e.g. "U / tALGO"
  partner: string; // the non-U token unit name
  /**
   * Every DEX this pair trades on. Usually one.
   *
   * U/ALGO is the reason this is a list: the pair runs on Tinyman AND on a Pact
   * managed-weighted pool, and showing it twice would imply two different
   * products rather than one pair with two places to supply it.
   */
  venues: Venue[];
};

/**
 * Where a pool's "add liquidity" link points.
 *
 * Derived rather than written out per pool. These were hard-coded, and when
 * Pact moved to its new contracts every Pact link 404'd while the `ref` beside
 * it stayed correct — the API reads kept working, so only the buttons broke.
 * A URL and the id it is built from cannot drift apart if only one of them is
 * written down.
 *
 * Both DEXes happen to use the same shape today. That is a coincidence worth
 * keeping visible rather than collapsing into one string, because they are
 * independent products and either can move without the other.
 */
const DEX_POOL_URL: Record<PoolDex, (ref: string) => string> = {
  tinyman: (ref) => `https://app.tinyman.org/pool/${ref}`,
  // Was `/add-liquidity/${ref}`, which now 404s. Verified 2026-10-04: this
  // path server-renders the pool (≈136–253 kB carrying both asset ids),
  // where an unknown id returns a ~10 kB shell — so the check is the body,
  // not the status code, which is 200 either way.
  pact: (ref) => `https://app.pact.fi/pool/${ref}`,
};

type VenueDef = Omit<Venue, "addLiquidityUrl">;
type PoolDef = Omit<Pool, "venues"> & { venues: VenueDef[] };
const withUrl = (p: PoolDef): Pool => ({
  ...p,
  venues: p.venues.map((v) => ({ ...v, addLiquidityUrl: DEX_POOL_URL[v.dex](v.ref) })),
});

/** Live-fetched numbers merged onto a Pool. APRs are percentages (e.g. 36.78). */
export type PoolData = Pool & PoolMetrics & {
  /**
   * Per-venue figures behind the combined headline.
   *
   * Kept rather than collapsed, because combining can hide the number a
   * supplier actually needs. Measured 2026-10-10, U/ALGO paid 3.69% on Tinyman
   * and 0.42% on Pact — a card showing only the blended 2.22% would quietly
   * send liquidity to the worse venue.
   */
  venueData: (Venue & PoolMetrics)[];
};

export const POOLS: Pool[] = ([
  // ── Both DEXes ──
  {
    // The only multi-venue pair. Tinyman and a Pact MANAGED_WEIGHTED pool, both
    // 50/50 and both real: $2,573 and $2,112 on 2026-10-10. The Pact one is
    // invisible to the /api/pools listing (weighted pools are only reachable by
    // id, or via the factory creator — see leaderboard.ts), which is why it had
    // to be found through the factory rather than a search.
    id: "u-algo", pair: "U / ALGO", partner: "ALGO",
    venues: [
      { dex: "tinyman", ref: "35I7TSPBSYCEP276DHLZDTOP3W77GY76VOLBCAKWICVFJUOTQAMRR6QZA4" },
      { dex: "pact", ref: "3734973475" },
    ],
  },
  // ── Tinyman ──
  {
    id: "u-talgo", pair: "U / tALGO", partner: "tALGO",
    venues: [{ dex: "tinyman", ref: "AIR4CSC54U33WCX4JTMJA4X6PHBVG7OGX7XVV2MCACYSSDULZNJ2KNGRZI" }],
  },
  {
    id: "u-mooj", pair: "U / MOOJ", partner: "MOOJ",
    venues: [{ dex: "tinyman", ref: "YLJXI33PTPUPCPVDEW77QCBCZAZY7LFEO3MYNL4OAG7T6JJAVMVSKCV52I" }],
  },
  {
    id: "u-usdc", pair: "U / USDC", partner: "USDC",
    venues: [{ dex: "tinyman", ref: "ONUEZGER6ZTBW7IT2FNWQVSTXJJEMG4BK2YK25FTDKEBTDE72BKV7SJUSI" }],
  },
  // ── Pact ──
  { id: "u-alpha", pair: "U / ALPHA", partner: "ALPHA", venues: [{ dex: "pact", ref: "3693600164" }] },
  { id: "u-compx", pair: "U / COMPX", partner: "COMPX", venues: [{ dex: "pact", ref: "3692558822" }] },
  { id: "u-hay",   pair: "U / HAY",   partner: "HAY",   venues: [{ dex: "pact", ref: "3692640639" }] },
  { id: "u-folks", pair: "U / FOLKS", partner: "FOLKS", venues: [{ dex: "pact", ref: "3693574268" }] },
] satisfies PoolDef[]).map(withUrl);

// mUSD liquidity pools showcased on the mUSD token page. Same live fee/farm APR fetch as
// POOLS above (shared fetchPoolMetrics) via /api/musd-pools.
export const MUSD_POOLS: Pool[] = ([
  {
    id: "musd-usdc", pair: "mUSD / USDC", partner: "USDC",
    venues: [{ dex: "tinyman", ref: "QSV4G3BGTOWLXXF6XDUI35VAQZGHZIQH3ASIJLLSSPQNWYHG2UFBYTDXE4" }],
  },
] satisfies PoolDef[]).map(withUrl);

export const DEX_LABEL: Record<PoolDex, string> = { tinyman: "Tinyman", pact: "Pact" };

// Live per-pool metrics, shared by /api/pools (per-pool cards) and the site-wide Total TVL
// stat. Summing these (rather than trusting a third-party asset-level aggregate) is what
// keeps Total TVL correct the moment a pool migrates to a new pool id — e.g. the Pact pools
// above, which moved to Pact's new platform and got new pool ids.
export type PoolMetrics = {
  tvlUsd: number | null;
  feeApr: number | null;
  farmApr: number | null;   // null when no farm, or when the farm pays no measurable rate
  totalApr: number | null;
  /**
   * A farm is running on this pool, whether or not it has a rate to show.
   *
   * Separate from `farmApr != null` because the two genuinely differ. Pact
   * computes a farm's APR against what is staked, so a farm that is live and
   * funded but that nobody has staked into yet reports 0 — measured 2026-10-14,
   * three of the four live $U farms (U/ALGO, U/ALPHA, U/FOLKS) were in exactly
   * that state. Keying the Farming badge off the APR alone hid them, which is
   * the opposite of what a supplier needs to know: those are the pools where
   * staking captures the whole reward stream.
   */
  farmLive: boolean;
};
const EMPTY_METRICS: PoolMetrics = {
  tvlUsd: null, feeApr: null, farmApr: null, totalApr: null, farmLive: false,
};

const TINYMAN_POOLS_API = "https://mainnet.analytics.tinyman.org/api/v1/pools";
const PACT_POOLS_API = "https://api.pact.fi/api/pools";
const PACT_FACTORY_FARMS_API = "https://api.pact.fi/api/v1/factory-farms";
/**
 * Below this, in percentage points, a farm counts as paying nothing.
 *
 * Treats rounding dust as "no rate" so the headline APR is not nudged by noise,
 * while `farmLive` still reports that the farm is there.
 */
const FARM_APR_FLOOR = 0.01;
const UA = { "User-Agent": "Mozilla/5.0 (compatible; MagnetStrategies/1.0)" };
const pct = (v: unknown) => (v == null ? null : Number(v) * 100);

/**
 * Pact farms, by the pool id they reward.
 *
 * Pact has TWO farm tables and they are not interchangeable:
 *
 *   /api/v1/farms          — the 2022-era legacy farms. All 177 are `ended`.
 *   /api/v1/factory-farms  — the current farm factory. This is the live one.
 *
 * Reading the wrong one makes every current farm invisible, and so does the
 * per-pool endpoint this file uses for TVL and fee APR: measured 2026-10-14,
 * `/api/pools/{id}` returns `rewards: []` and `apr_7d_all === apr_7d` for all
 * six $U pools even though four of them are being farmed. Deriving the farm APR
 * as the excess of `apr_7d_all` over `apr_7d` therefore could only ever yield
 * zero, which is why farms never showed up here.
 *
 * `/api/v1/pools` does carry a joined `farmAprFraction`, but it is the APR
 * alone — it cannot say a farm EXISTS when that APR is 0, and it costs 8 paged
 * requests and ~3.7 MB because the list honours no filter (`poolIds`, `ids`,
 * `poolId`, `assetIds`, `tokenIds`, `search` and `hasFarm` were each tried and
 * all returned the same unfiltered first page). factory-farms is one unpaged
 * 74 kB request and carries the farm's status, so it is used instead.
 */
type PactFarm = { apr: number | null; live: boolean };
type PactFarmIndex = Map<string, PactFarm>;

type PactFactoryFarm = {
  status?: string;
  aprFraction?: number | string | null;
  pool?: { poolId?: string | number } | null;
};

async function loadPactFarmIndex(): Promise<PactFarmIndex> {
  const index: PactFarmIndex = new Map();
  const r = await fetch(`${PACT_FACTORY_FARMS_API}?chain=algorand-mainnet`, {
    headers: UA,
    next: { revalidate: 60 },
  });
  if (!r.ok) return index;
  const body: { data?: PactFactoryFarm[] } = await r.json();

  for (const farm of body?.data ?? []) {
    const poolId = farm?.pool?.poolId;
    // Single-asset farms reward a token rather than an LP position and have no
    // pool to attach to; they are not pools on this page.
    if (poolId == null || farm?.status !== "live") continue;
    const apr = pct(farm?.aprFraction);
    index.set(String(poolId), { apr: apr != null && apr > FARM_APR_FLOOR ? apr : null, live: true });
  }

  return index;
}

/**
 * The memoised index.
 *
 * A rejected or empty result is deliberately NOT held for the full window: an
 * upstream blip would otherwise strip the Farming badge off every Pact pool for
 * a minute, and a stale-but-correct farm figure beats a confidently absent one.
 */
let pactFarmIndexCache: { at: number; value: Promise<PactFarmIndex> } | null = null;
const PACT_FARM_INDEX_TTL_MS = 60_000;

function pactFarmIndex(): Promise<PactFarmIndex> {
  let entry = pactFarmIndexCache;
  if (!entry || Date.now() - entry.at >= PACT_FARM_INDEX_TTL_MS) {
    const started: { at: number; value: Promise<PactFarmIndex> } = {
      at: Date.now(),
      value: loadPactFarmIndex().then((index) => {
        // An empty index means it did not load; let the next read retry.
        if (!index.size && pactFarmIndexCache === started) pactFarmIndexCache = null;
        return index;
      }),
    };
    started.value.catch(() => {
      if (pactFarmIndexCache === started) pactFarmIndexCache = null;
    });
    pactFarmIndexCache = started;
    entry = started;
  }
  return entry.value.catch((): PactFarmIndex => new Map());
}

async function fetchTinymanMetrics(addr: string): Promise<PoolMetrics> {
  const r = await fetch(`${TINYMAN_POOLS_API}/${addr}/`, { headers: UA, next: { revalidate: 60 } });
  if (!r.ok) return EMPTY_METRICS;
  const p = await r.json();
  const farmApr = pct(p.staking_total_annual_percentage_rate); // null when no farm
  return {
    tvlUsd: Number(p.liquidity_in_usd) || 0,
    feeApr: pct(p.annual_percentage_rate),
    farmApr,
    totalApr: pct(p.total_annual_percentage_rate),
    // Tinyman reports a rate or nothing at all, so the rate IS the signal here.
    farmLive: farmApr != null && farmApr > FARM_APR_FLOOR,
  };
}

async function fetchPactMetrics(id: string): Promise<PoolMetrics> {
  // TVL and fee APR come from the per-pool endpoint; the farm APR only exists in
  // the v1 index (see PactFarmIndex). The index is fetched alongside rather than
  // after, so a pool card costs one round trip either way.
  const [r, farmIndex] = await Promise.all([
    fetch(`${PACT_POOLS_API}/${id}`, { headers: UA, next: { revalidate: 60 } }),
    pactFarmIndex(),
  ]);
  if (!r.ok) return EMPTY_METRICS;
  const p = await r.json();
  const farm = farmIndex.get(id);
  return {
    tvlUsd: Number(p.tvl_usd) || 0,
    ...resolvePactApr({
      feeApr: pct(p.apr_7d),
      reportedTotal: pct(p.apr_7d_all),
      indexedFarm: farm?.apr ?? null,
      farmLive: farm?.live ?? false,
    }),
  };
}

/**
 * Reconcile Pact's two farm signals into one fee/farm/total triple.
 *
 * Split out from the fetch so it can be tested without the network.
 *
 * `indexedFarm` is `farmAprFraction` from the v1 index, which Pact states
 * outright and which is therefore preferred. The `reportedTotal` excess is kept
 * as a fallback because on Pact's OLD pools `apr_7d_all` genuinely did fold farm
 * rewards in, and those pools carry no farm figure in the v1 index — dropping it
 * would have un-farmed them.
 *
 * The 0.01pp floor on both treats rounding dust as "no farm", so the Farming
 * badge does not light up for a farm that has stopped paying.
 */
export function resolvePactApr(input: {
  feeApr: number | null;
  reportedTotal: number | null;
  indexedFarm: number | null;
  farmLive?: boolean;
}): Omit<PoolMetrics, "tvlUsd"> {
  const { feeApr, reportedTotal, indexedFarm, farmLive = false } = input;

  const folded =
    feeApr != null && reportedTotal != null && reportedTotal - feeApr > FARM_APR_FLOOR
      ? reportedTotal - feeApr
      : null;
  const farmApr = indexedFarm != null && indexedFarm > FARM_APR_FLOOR ? indexedFarm : folded;

  // apr_7d_all does NOT include a factory farm, so the headline adds it back.
  // When the farm came from the fold, reportedTotal already contains it and
  // feeApr + farmApr reproduces it exactly.
  const totalApr = farmApr != null && feeApr != null ? feeApr + farmApr : reportedTotal;

  return { feeApr, farmApr, totalApr, farmLive: farmLive || farmApr != null };
}

export async function fetchPoolMetrics(venue: Pick<Venue, "dex" | "ref">): Promise<PoolMetrics> {
  try {
    return venue.dex === "tinyman" ? await fetchTinymanMetrics(venue.ref) : await fetchPactMetrics(venue.ref);
  } catch {
    return EMPTY_METRICS;
  }
}

/**
 * Blend several venues of one pair into a single headline.
 *
 * APRs are weighted by TVL, NOT averaged. A plain mean answers "what do these
 * pools advertise"; the weighted figure answers "what does a dollar of
 * liquidity in this pair actually earn", which is the only one a supplier can
 * act on. Measured 2026-10-10 the two differed by just 0.16pp because the two
 * U/ALGO pools happen to be similar in size — the gap grows with every dollar
 * that lands on one side, so the weighting is not decoration.
 *
 * A venue with null or zero TVL carries no weight: an empty pool advertising
 * 400% should not move the number. If no venue has TVL, fall back to a plain
 * mean so a pair of brand-new pools still shows their advertised rate rather
 * than nothing.
 */
export function combineMetrics(parts: PoolMetrics[]): PoolMetrics {
  if (parts.length === 1) return parts[0];

  const tvls = parts.map((m) => m.tvlUsd).filter((v): v is number => v != null);
  const tvlUsd = tvls.length ? tvls.reduce((a, b) => a + b, 0) : null;

  const blend = (key: "feeApr" | "farmApr" | "totalApr"): number | null => {
    const rows = parts
      .map((m) => ({ apr: m[key], w: m.tvlUsd ?? 0 }))
      .filter((r): r is { apr: number; w: number } => r.apr != null);
    if (!rows.length) return null;
    const weight = rows.reduce((a, r) => a + r.w, 0);
    if (weight <= 0) return rows.reduce((a, r) => a + r.apr, 0) / rows.length;
    return rows.reduce((a, r) => a + r.apr * r.w, 0) / weight;
  };

  // farmApr stays null unless some venue actually pays, so a blended zero does
  // not invent a rate. farmLive is a separate OR: a farm running on one venue of
  // a pair is still a farm a supplier can stake into, even with no rate yet.
  const farm = blend("farmApr");
  return {
    tvlUsd,
    feeApr: blend("feeApr"),
    farmApr: farm != null && farm > 0 ? farm : null,
    totalApr: blend("totalApr"),
    farmLive: parts.some((m) => m.farmLive),
  };
}

/** Everything the UI needs for one pair: the blend, plus the venues behind it. */
export async function fetchPoolData(pool: Pool): Promise<PoolData> {
  const venueData = await Promise.all(
    pool.venues.map(async (v) => ({ ...v, ...(await fetchPoolMetrics(v)) })),
  );
  return { ...pool, ...combineMetrics(venueData), venueData };
}

// Real but dust-sized $U pools (each under $150 as of 2026-09-05) — found by querying
// Vestige's full pool index for every pool pairing $U (asset_1_id/asset_2_id = 3081853135)
// and filtering out empty pools (0 or the ~1000-unit locked-minimum LP supply). Folded into
// Total TVL for accuracy but deliberately left off /pools — not worth a card.
export const DUST_POOLS: Pick<Venue, "dex" | "ref">[] = [
  { dex: "tinyman", ref: "337NDU6Z65P2MYHMLFEXIFAACENAN2Q6PW2PDAS3QHNUR6YN7OLBOBIRNY" }, // U/WBTC
  { dex: "tinyman", ref: "32IGIQSVVKUTBNII2QVGXI4QMSCGI6HOI44KDLSFF6VFEJ45ANSWHPCQOU" }, // U/Finite
  { dex: "tinyman", ref: "642N7PH6LA7SHU4TH6WFABDXFBQCBURJMOPRYP2UG3ESOQDTIAG3C5RO4Q" }, // GAAL/U
  { dex: "tinyman", ref: "MBUZA6DBHL4OHFKCMWLQ5NGUVQ7FOZMBOF74BKL2IQU3AYFLXMNINGO2UM" }, // CORVID/U
  { dex: "tinyman", ref: "HRW6O43JJVSLP2FRFYJRTH5U4FUNSVZZBV5WRJFLTESYOIQAY6CDO73LXU" }, // Bytes/U
  { dex: "tinyman", ref: "FHPHRJ4ABBNUGKJWF3QIUIRKL7GEDKLO3WSWXR5ITJNIYBN3R3JLFMBNLY" }, // U/COMPX (separate Tinyman pool; not the Pact one above)
  { dex: "tinyman", ref: "5CV7UJ7KST2G4ZSBGRSDONQRGXTELVJBKOMNKPLKEJKI6CX5OHYJJW3BWM" }, // $RAPTOR/U
  { dex: "pact", ref: "3188310827" }, // U/HOG
];

/**
 * Every individual pool we track, flattened across pairs and including dust.
 *
 * The canonical list for anything that counts or values POOLS: a multi-venue
 * pair contributes one entry per DEX, so iterating `POOLS` instead would count
 * only whichever venue happened to be first.
 */
export const ALL_VENUES: Pick<Venue, "dex" | "ref">[] = [
  ...POOLS.flatMap((p) => p.venues),
  ...DUST_POOLS,
];

/** Sum of live per-pool TVL across every tracked Tinyman + Pact pool, including dust pools not shown on /pools. Null only if every pool fetch failed. */
export async function fetchTotalTvlUsd(): Promise<number | null> {
  // Flattened to VENUES: a multi-venue pair has one entry per pool, so U/ALGO
  // contributes both its Tinyman and its Pact liquidity. Iterating POOLS here
  // would have counted only whichever venue happened to be first.
  const metrics = await Promise.all(ALL_VENUES.map(fetchPoolMetrics));
  const values = metrics.map((m) => m.tvlUsd).filter((v): v is number => v != null);
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0);
}
