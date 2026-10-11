import { NextResponse } from "next/server";
import { POOLS, fetchPoolData, type PoolData } from "@/lib/pools";

// Cache the upstream reads for 60s (server-side; dodges browser CORS + rate limits).
// force-dynamic is required: without it this route is statically prerendered at build time
// and every viewer gets the APR/TVL figures frozen at the last deploy. The upstream reads
// stay cached by fetchPoolData' own `next: { revalidate: 60 }`, so cost is unchanged.
export const dynamic = "force-dynamic";

export async function GET() {
  const pools: PoolData[] = await Promise.all(POOLS.map(fetchPoolData));
  return NextResponse.json({ pools });
}
