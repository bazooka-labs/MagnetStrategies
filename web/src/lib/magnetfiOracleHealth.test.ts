// Oracle health, as the admin panel computes it.
//
// Written after 2026-10-07: the U/tALGO feed stopped at 16:04Z and nobody knew
// for six and a half hours, during which borrowing and all three liquidation
// paths were reverting on that pool.

import { describe, expect, it, vi } from "vitest";
import algosdk from "algosdk";
import { getOracleHealth } from "./magnetfiReads";
import { ACTIVE_POOL_WIRING } from "./magnetfi";

const POOLS = Object.entries(ACTIVE_POOL_WIRING);
const [FIRST_ID, FIRST] = POOLS[0];

const key = (prefix: string, poolId: number) =>
  Buffer.concat([Buffer.from(prefix), Buffer.from(algosdk.encodeUint64(BigInt(poolId)))])
    .toString("base64");

/** An algod whose oracle app returns exactly these per-pool values. */
function fakeAlgod(per: Record<number, { price?: number; anchor?: number; ts?: number }>) {
  const gs: { key: string; value: { type: number; uint: number } }[] = [];
  for (const [pid, v] of Object.entries(per)) {
    const id = Number(pid);
    if (v.price !== undefined) gs.push({ key: key("lp_price_", id), value: { type: 2, uint: v.price } });
    if (v.anchor !== undefined) gs.push({ key: key("lp_anchor_", id), value: { type: 2, uint: v.anchor } });
    if (v.ts !== undefined) gs.push({ key: key("lp_ts_", id), value: { type: 2, uint: v.ts } });
  }
  return { getApplicationByID: () => ({ do: async () => ({ params: { globalState: gs } }) }) } as unknown as algosdk.Algodv2;
}

const NOW = 1_800_000_000;
const at = (secsAgo: number) => NOW - secsAgo;
const withClock = async <T,>(fn: () => Promise<T>): Promise<T> => {
  vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
  try { return await fn(); } finally { vi.restoreAllMocks(); }
};
const only = (rows: Awaited<ReturnType<typeof getOracleHealth>>) =>
  rows.find((r) => r.id === FIRST_ID)!;

describe("staleness levels track the vault's own window", () => {
  it("is ok while fresh", async () => {
    const r = await withClock(() => getOracleHealth(fakeAlgod({
      [FIRST.poolId]: { price: 900_000, anchor: 870_000, ts: at(120) } })));
    expect(only(r).level).toBe("ok");
  });

  it("warns at half the window, before anything breaks", async () => {
    const r = await withClock(() => getOracleHealth(fakeAlgod({
      [FIRST.poolId]: { price: 900_000, anchor: 870_000, ts: at(901) } })));
    expect(only(r).level).toBe("warn");
  });

  it("is critical once the vault is actually refusing", async () => {
    // 1800s is ORACLE_FRESHNESS in vault/contract.py. Past it, borrowing and
    // ALL THREE liquidation paths revert.
    const r = await withClock(() => getOracleHealth(fakeAlgod({
      [FIRST.poolId]: { price: 900_000, anchor: 870_000, ts: at(1801) } })));
    expect(only(r).level).toBe("critical");
  });

  it("does not call a pool that never posted stale", async () => {
    // ts === 0 means add_pool has not run. Reporting that as a six-hour outage
    // is how an alert stops being believed.
    const r = await withClock(() => getOracleHealth(fakeAlgod({
      [FIRST.poolId]: { price: 0, anchor: 0, ts: 0 } })));
    expect(only(r).level).toBe("ok");
    expect(only(r).ts).toBe(0);
  });
});

describe("the band is the leading indicator", () => {
  it("computes ±25% around the anchor", async () => {
    const r = await withClock(() => getOracleHealth(fakeAlgod({
      [FIRST.poolId]: { price: 900_000, anchor: 800_000, ts: at(60) } })));
    const p = only(r);
    expect(p.bandLow).toBeCloseTo(0.6, 6);    // 800_000 × 0.75
    expect(p.bandHigh).toBeCloseTo(1.0, 6);   // 800_000 × 1.25
  });

  it("measures room from the price, not from the anchor", async () => {
    // What matters is how far the PRICE may still move before a post reverts.
    const r = await withClock(() => getOracleHealth(fakeAlgod({
      [FIRST.poolId]: { price: 1_000_000, anchor: 1_000_000, ts: at(60) } })));
    const p = only(r);
    expect(p.roomUpPct).toBeCloseTo(25, 4);
    expect(p.roomDownPct).toBeCloseTo(25, 4);
  });

  it("flags a price closing on its ceiling BEFORE it freezes", async () => {
    // The state U/tALGO was in for hours with nothing on screen saying so.
    const r = await withClock(() => getOracleHealth(fakeAlgod({
      [FIRST.poolId]: { price: 1_240_000, anchor: 1_000_000, ts: at(60) } })));
    const p = only(r);
    expect(p.level).toBe("ok");        // still posting
    expect(p.nearBand).toBe(true);     // but about to stop
    expect(p.roomUpPct!).toBeLessThan(5);
  });

  it("reports no band when no anchor is set", async () => {
    // anchor 0 disables the on-chain guard; claiming a band would be inventing one.
    const r = await withClock(() => getOracleHealth(fakeAlgod({
      [FIRST.poolId]: { price: 900_000, anchor: 0, ts: at(60) } })));
    const p = only(r);
    expect(p.bandLow).toBeNull();
    expect(p.roomUpPct).toBeNull();
    expect(p.nearBand).toBe(false);
  });
});

describe("pools are reported independently", () => {
  it("one dead feed does not hide behind a healthy one", async () => {
    // 2026-10-07 exactly: one pool posting every five minutes, the other
    // untouched for hours.
    if (POOLS.length < 2) return;
    const [, second] = POOLS[1];
    const r = await withClock(() => getOracleHealth(fakeAlgod({
      [FIRST.poolId]: { price: 900_000, anchor: 870_000, ts: at(23_000) },
      [second.poolId]: { price: 2_480_000, anchor: 2_400_000, ts: at(180) },
    })));
    expect(r.find((x) => x.poolId === FIRST.poolId)!.level).toBe("critical");
    expect(r.find((x) => x.poolId === second.poolId)!.level).toBe("ok");
  });
});
