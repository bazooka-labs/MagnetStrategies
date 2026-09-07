import { NextResponse } from "next/server";
import { fetchBoard } from "@/lib/leaderboard";

// The board is a ~14-request sweep, so cache it hard. LiquiHog runs 3-5 rounds behind chain
// head, but pooled TVL does not move meaningfully minute to minute — 5 minutes is plenty.
export const revalidate = 300;
// The sweep is ~10 paged requests; well under this, but the default would be tight.
export const maxDuration = 60;

export async function GET() {
  const board = await fetchBoard();
  if (!board) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  return NextResponse.json(board, {
    headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" },
  });
}
