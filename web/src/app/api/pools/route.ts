import { NextResponse } from "next/server";
import { POOLS, type PoolData } from "@/lib/pools";

// Cache the upstream reads for 60s (server-side; dodges browser CORS + rate limits).
export const revalidate = 60;

const TINYMAN = "https://mainnet.analytics.tinyman.org/api/v1/pools";
const PACT = "https://api.pact.fi/api/pools";

const UA = { "User-Agent": "Mozilla/5.0 (compatible; MagnetStrategies/1.0)" };
const pct = (v: unknown) => (v == null ? null : Number(v) * 100);

type Metrics = Pick<PoolData, "tvlUsd" | "feeApr" | "farmApr" | "totalApr">;
const EMPTY: Metrics = { tvlUsd: null, feeApr: null, farmApr: null, totalApr: null };

async function fetchTinyman(addr: string): Promise<Metrics> {
  const r = await fetch(`${TINYMAN}/${addr}/`, { headers: UA, next: { revalidate: 60 } });
  if (!r.ok) return EMPTY;
  const p = await r.json();
  return {
    tvlUsd: Number(p.liquidity_in_usd) || 0,
    feeApr: pct(p.annual_percentage_rate),
    farmApr: pct(p.staking_total_annual_percentage_rate), // null when no farm
    totalApr: pct(p.total_annual_percentage_rate),
  };
}

async function fetchPact(id: string): Promise<Metrics> {
  const r = await fetch(`${PACT}/${id}`, { headers: UA, next: { revalidate: 60 } });
  if (!r.ok) return EMPTY;
  const p = await r.json();
  const feeApr = pct(p.apr_7d);
  const totalApr = pct(p.apr_7d_all);
  // Pact folds farm rewards into apr_7d_all; the excess over the fee APR is the farm APR.
  const farmApr =
    feeApr != null && totalApr != null && totalApr - feeApr > 0.01 ? totalApr - feeApr : null;
  return { tvlUsd: Number(p.tvl_usd) || 0, feeApr, farmApr, totalApr };
}

export async function GET() {
  const pools: PoolData[] = await Promise.all(
    POOLS.map(async (pool) => {
      try {
        const m = pool.dex === "tinyman" ? await fetchTinyman(pool.ref) : await fetchPact(pool.ref);
        return { ...pool, ...m };
      } catch {
        return { ...pool, ...EMPTY };
      }
    }),
  );
  return NextResponse.json({ pools });
}
