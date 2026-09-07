// $U liquidity pools showcased on /pools. Live fee + farm APRs are fetched server-side
// (see app/api/pools/route.ts): Tinyman by pool address, Pact by pool id. Farm APR
// appears automatically whenever a DEX runs an incentive program — no manual upkeep.

export type PoolDex = "tinyman" | "pact";

export type Pool = {
  id: string;      // internal key
  pair: string;    // display, e.g. "U / tALGO"
  partner: string; // the non-U token unit name
  dex: PoolDex;
  ref: string;     // tinyman → pool account address; pact → pool id
  addLiquidityUrl: string;
};

/** Live-fetched numbers merged onto an Pool. APRs are percentages (e.g. 36.78). */
export type PoolData = Pool & {
  tvlUsd: number | null;
  feeApr: number | null;
  farmApr: number | null;   // null when no active farm
  totalApr: number | null;
};

export const POOLS: Pool[] = [
  // ── Tinyman ──
  {
    id: "u-talgo", pair: "U / tALGO", partner: "tALGO", dex: "tinyman",
    ref: "AIR4CSC54U33WCX4JTMJA4X6PHBVG7OGX7XVV2MCACYSSDULZNJ2KNGRZI",
    addLiquidityUrl: "https://app.tinyman.org/pool/AIR4CSC54U33WCX4JTMJA4X6PHBVG7OGX7XVV2MCACYSSDULZNJ2KNGRZI",
  },
  {
    id: "u-mooj", pair: "U / MOOJ", partner: "MOOJ", dex: "tinyman",
    ref: "YLJXI33PTPUPCPVDEW77QCBCZAZY7LFEO3MYNL4OAG7T6JJAVMVSKCV52I",
    addLiquidityUrl: "https://app.tinyman.org/pool/YLJXI33PTPUPCPVDEW77QCBCZAZY7LFEO3MYNL4OAG7T6JJAVMVSKCV52I",
  },
  {
    id: "u-usdc", pair: "U / USDC", partner: "USDC", dex: "tinyman",
    ref: "ONUEZGER6ZTBW7IT2FNWQVSTXJJEMG4BK2YK25FTDKEBTDE72BKV7SJUSI",
    addLiquidityUrl: "https://app.tinyman.org/pool/ONUEZGER6ZTBW7IT2FNWQVSTXJJEMG4BK2YK25FTDKEBTDE72BKV7SJUSI",
  },
  // ── Pact ──
  {
    id: "u-alpha", pair: "U / ALPHA", partner: "ALPHA", dex: "pact",
    ref: "3693600164", addLiquidityUrl: "https://app.pact.fi/add-liquidity/3693600164",
  },
  {
    id: "u-compx", pair: "U / COMPX", partner: "COMPX", dex: "pact",
    ref: "3692558822", addLiquidityUrl: "https://app.pact.fi/add-liquidity/3692558822",
  },
  {
    id: "u-hay", pair: "U / HAY", partner: "HAY", dex: "pact",
    ref: "3692640639", addLiquidityUrl: "https://app.pact.fi/add-liquidity/3692640639",
  },
  {
    id: "u-folks", pair: "U / FOLKS", partner: "FOLKS", dex: "pact",
    ref: "3693574268", addLiquidityUrl: "https://app.pact.fi/add-liquidity/3693574268",
  },
];

export const DEX_LABEL: Record<PoolDex, string> = { tinyman: "Tinyman", pact: "Pact" };

// Live per-pool metrics, shared by /api/pools (per-pool cards) and the site-wide Total TVL
// stat. Summing these (rather than trusting a third-party asset-level aggregate) is what
// keeps Total TVL correct the moment a pool migrates to a new pool id — e.g. the Pact pools
// above, which moved to Pact's new platform and got new pool ids.
export type PoolMetrics = Pick<PoolData, "tvlUsd" | "feeApr" | "farmApr" | "totalApr">;
const EMPTY_METRICS: PoolMetrics = { tvlUsd: null, feeApr: null, farmApr: null, totalApr: null };

const TINYMAN_POOLS_API = "https://mainnet.analytics.tinyman.org/api/v1/pools";
const PACT_POOLS_API = "https://api.pact.fi/api/pools";
const UA = { "User-Agent": "Mozilla/5.0 (compatible; MagnetStrategies/1.0)" };
const pct = (v: unknown) => (v == null ? null : Number(v) * 100);

async function fetchTinymanMetrics(addr: string): Promise<PoolMetrics> {
  const r = await fetch(`${TINYMAN_POOLS_API}/${addr}/`, { headers: UA, next: { revalidate: 60 } });
  if (!r.ok) return EMPTY_METRICS;
  const p = await r.json();
  return {
    tvlUsd: Number(p.liquidity_in_usd) || 0,
    feeApr: pct(p.annual_percentage_rate),
    farmApr: pct(p.staking_total_annual_percentage_rate), // null when no farm
    totalApr: pct(p.total_annual_percentage_rate),
  };
}

async function fetchPactMetrics(id: string): Promise<PoolMetrics> {
  const r = await fetch(`${PACT_POOLS_API}/${id}`, { headers: UA, next: { revalidate: 60 } });
  if (!r.ok) return EMPTY_METRICS;
  const p = await r.json();
  const feeApr = pct(p.apr_7d);
  const totalApr = pct(p.apr_7d_all);
  // Pact folds farm rewards into apr_7d_all; the excess over the fee APR is the farm APR.
  const farmApr =
    feeApr != null && totalApr != null && totalApr - feeApr > 0.01 ? totalApr - feeApr : null;
  return { tvlUsd: Number(p.tvl_usd) || 0, feeApr, farmApr, totalApr };
}

export async function fetchPoolMetrics(pool: Pick<Pool, "dex" | "ref">): Promise<PoolMetrics> {
  try {
    return pool.dex === "tinyman" ? await fetchTinymanMetrics(pool.ref) : await fetchPactMetrics(pool.ref);
  } catch {
    return EMPTY_METRICS;
  }
}

// Real but dust-sized $U pools (each under $150 as of 2026-09-05) — found by querying
// Vestige's full pool index for every pool pairing $U (asset_1_id/asset_2_id = 3081853135)
// and filtering out empty pools (0 or the ~1000-unit locked-minimum LP supply). Folded into
// Total TVL for accuracy but deliberately left off /pools — not worth a card.
export const DUST_POOLS: Pick<Pool, "dex" | "ref">[] = [
  { dex: "tinyman", ref: "337NDU6Z65P2MYHMLFEXIFAACENAN2Q6PW2PDAS3QHNUR6YN7OLBOBIRNY" }, // U/WBTC
  { dex: "tinyman", ref: "32IGIQSVVKUTBNII2QVGXI4QMSCGI6HOI44KDLSFF6VFEJ45ANSWHPCQOU" }, // U/Finite
  { dex: "tinyman", ref: "642N7PH6LA7SHU4TH6WFABDXFBQCBURJMOPRYP2UG3ESOQDTIAG3C5RO4Q" }, // GAAL/U
  { dex: "tinyman", ref: "MBUZA6DBHL4OHFKCMWLQ5NGUVQ7FOZMBOF74BKL2IQU3AYFLXMNINGO2UM" }, // CORVID/U
  { dex: "tinyman", ref: "HRW6O43JJVSLP2FRFYJRTH5U4FUNSVZZBV5WRJFLTESYOIQAY6CDO73LXU" }, // Bytes/U
  { dex: "tinyman", ref: "FHPHRJ4ABBNUGKJWF3QIUIRKL7GEDKLO3WSWXR5ITJNIYBN3R3JLFMBNLY" }, // U/COMPX (separate Tinyman pool; not the Pact one above)
  { dex: "tinyman", ref: "5CV7UJ7KST2G4ZSBGRSDONQRGXTELVJBKOMNKPLKEJKI6CX5OHYJJW3BWM" }, // $RAPTOR/U
  { dex: "pact", ref: "3188310827" }, // U/HOG
];

/** Sum of live per-pool TVL across every tracked Tinyman + Pact pool, including dust pools not shown on /pools. Null only if every pool fetch failed. */
export async function fetchTotalTvlUsd(): Promise<number | null> {
  const metrics = await Promise.all([...POOLS, ...DUST_POOLS].map(fetchPoolMetrics));
  const values = metrics.map((m) => m.tvlUsd).filter((v): v is number => v != null);
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0);
}
