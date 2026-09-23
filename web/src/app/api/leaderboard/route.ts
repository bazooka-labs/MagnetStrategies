import { NextResponse } from "next/server";
import { fetchBoard } from "@/lib/leaderboard";

// MUST execute per request. A route handler with no request-dependent input is statically
// PRERENDERED at build time and then served frozen — which silently pinned this board to the
// deploy's round for days (x-vercel-cache: PRERENDER, asOfRound 186k rounds behind head).
// `revalidate` alone does not save you here; the route has to be dynamic.
export const dynamic = "force-dynamic";
// The sweep is ~10 paged upstream requests; well under this, but the default would be tight.
export const maxDuration = 60;

export async function GET() {
  const board = await fetchBoard();
  if (!board) {
    return NextResponse.json(
      { error: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    { ...board, generatedAt: Date.now() },
    {
      headers: {
        // max-age=0 so a browser never serves its own copy (that was the "needs a hard
        // refresh" symptom); s-maxage lets the CDN hold one briefly to bound upstream load.
        // No stale-while-revalidate: serving stale is exactly what we are fixing.
        "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=0",
      },
    },
  );
}
