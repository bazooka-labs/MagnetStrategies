// The 24h strip above the chart.
//
// `fetchDayStats` takes its fetch, so unlike most of the card this is testable
// for real rather than by reading the source.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fetchDayStats } from "./perpsChart";

// Coinbase rows are [time, low, high, open, close, volume], NEWEST FIRST.
const rows = [
  [3000, 10, 30, 20, 25, 1],  // newest
  [2000,  5, 40, 12, 20, 1],
  [1000,  8, 22, 11, 12, 1],  // oldest
];
const okFetch = (async () => new Response(JSON.stringify(rows))) as unknown as typeof fetch;

describe("fetchDayStats", () => {
  it("takes the extremes across the whole window", async () => {
    const d = await fetchDayStats(1, okFetch);
    expect(d.high).toBe(40);
    expect(d.low).toBe(5);
  });

  it("opens at the OLDEST row and closes at the newest", async () => {
    // The rows arrive newest-first. Reading open from rows[0] would measure the
    // change over the last hour and label it 24h.
    const d = await fetchDayStats(1, okFetch);
    expect(d.open).toBe(11);
    expect(d.close).toBe(25);
  });

  it("skips malformed rows rather than poisoning the extremes", async () => {
    const dirty = [[3000, 10, 30, 20, 25, 1], ["x"], [2000, null, 40, 12, 20, 1], [1000, 8, 22, 11, 12, 1]];
    const d = await fetchDayStats(1, (async () => new Response(JSON.stringify(dirty))) as unknown as typeof fetch);
    expect(d.high).toBe(30);
    expect(d.low).toBe(8);
  });

  it("throws rather than returning a flat zero", async () => {
    // An empty window must not render as a market sitting at $0.
    await expect(fetchDayStats(1, (async () => new Response("[]")) as unknown as typeof fetch)).rejects.toThrow();
    await expect(fetchDayStats(1, (async () => new Response("null")) as unknown as typeof fetch)).rejects.toThrow();
    await expect(fetchDayStats(999, okFetch)).rejects.toThrow();
  });

  it("asks for a ROLLING 24 hours, not the calendar day", async () => {
    // A daily candle resets at 00:00 UTC, so at 00:30 its high and low describe
    // thirty minutes under a label that says 24h.
    let url = "";
    await fetchDayStats(1, (async (u: string) => { url = u; return new Response(JSON.stringify(rows)); }) as unknown as typeof fetch);
    expect(url).toContain("granularity=3600");
    const start = Date.parse(new URL(url).searchParams.get("start")!);
    const end = Date.parse(new URL(url).searchParams.get("end")!);
    expect(Math.round((end - start) / 3_600_000)).toBe(24);
  });
});

describe("the strip and the card cannot disagree", () => {
  const panel = readFileSync("src/components/strategy/perps/PerpsChartPanel.tsx", "utf8");

  it("takes the live price from the card rather than polling again", () => {
    expect(panel).toContain("const live = indexUsd ?? day?.close ?? null;");
    expect(panel).not.toMatch(/usePerpsMarket|getOraclePayload/);
  });

  it("measures the change against the figure it displays", () => {
    // Computed from `day.close` while showing the oracle index, the percentage
    // and the price would tell different stories on the same row.
    expect(panel).toContain("((live - day.open) / day.open) * 100");
  });
});
