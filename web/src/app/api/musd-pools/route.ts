import { NextResponse } from "next/server";
import { MUSD_POOLS, fetchPoolData, type PoolData } from "@/lib/pools";

// force-dynamic for the same reason as /api/pools: without it this route is statically
// prerendered at build time and every viewer gets frozen APR/TVL figures.
export const dynamic = "force-dynamic";

export async function GET() {
  const pools: PoolData[] = await Promise.all(MUSD_POOLS.map(fetchPoolData));
  return NextResponse.json({ pools });
}
