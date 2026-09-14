import { NextResponse } from "next/server";
import { POOLS, fetchPoolMetrics, type PoolData } from "@/lib/pools";

// Cache the upstream reads for 60s (server-side; dodges browser CORS + rate limits).
// force-dynamic is required: without it this route is statically prerendered at build time
// and every viewer gets the APR/TVL figures frozen at the last deploy. The upstream reads
// stay cached by fetchPoolMetrics' own `next: { revalidate: 60 }`, so cost is unchanged.
export const dynamic = "force-dynamic";

export async function GET() {
  const pools: PoolData[] = await Promise.all(
    POOLS.map(async (pool) => ({ ...pool, ...(await fetchPoolMetrics(pool)) })),
  );
  return NextResponse.json({ pools });
}
