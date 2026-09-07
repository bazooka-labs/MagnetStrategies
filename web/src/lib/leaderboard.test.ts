import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchBoard, MAGNET_ASA_ID } from "./leaderboard";

const A = 111, B = 222, C = 333;

const lhPool = (o: Record<string, unknown>) => ({
  pool_id: 1, lp_asset_id: 9_000_000, dex_name: "Tinyman v2",
  asset_a: A, asset_b: B, tvl_algo_micro: 100_000_000,
  tvl_confidence_bps: 9000, tvl_priced_sides: 2, tvl_rate_encoded: false, ...o,
});
const asset = (id: number, unit: string, o: Record<string, unknown> = {}) => ({
  asset_id: id, unit_name: unit, name: unit, decimals: 6, is_lp_token: false, ...o,
});

function mock(pools: unknown[], assets: unknown[] = []) {
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input);
    const json =
      url.includes("/analytics/prices")
        ? { algo_usd: 0.1, as_of_round: 1,
            prices: Object.fromEntries([A, B, C, MAGNET_ASA_ID].map((id) =>
              [String(id), { price_algo: 1, confidence_bps: 9500 }])) }
      : url.includes("/assets")
        ? { assets: assets.length ? assets : [A, B, C, MAGNET_ASA_ID].map((id) => asset(id, `T${id}`)) }
      : url.includes("/pools") ? { pools, as_of_round: 1 }
      : url.includes("algonode") ? { applications: [] }
      : {};
    return { ok: true, status: 200, json: async () => json };
  });
}
const tvlOf = (b: Awaited<ReturnType<typeof fetchBoard>>, id: number) =>
  b?.top.find((r) => r.assetId === id)?.tvlAlgo ?? 0;

afterEach(() => vi.unstubAllGlobals());

describe("non-LP venues are excluded", () => {
  for (const venue of ["dualstake mint", "xALGO mint/burn", "tALGO mint/burn", "Folks Lend"]) {
    it(`drops "${venue}"`, async () => {
      // two real pools so A/B stay eligible, plus one mint contract that must not count
      mock([
        lhPool({ pool_id: 1 }),
        lhPool({ pool_id: 2, lp_asset_id: 9_000_002 }),
        lhPool({ pool_id: 3, lp_asset_id: 9_000_003, dex_name: venue, tvl_algo_micro: 5_000_000_000 }),
      ]);
      const b = await fetchBoard();
      expect(b).not.toBeNull();
      // 2 x 100 ALGO counted; the 5,000 ALGO mint contract contributes nothing
      expect(tvlOf(b, A)).toBeCloseTo(200, 6);
      expect(tvlOf(b, B)).toBeCloseTo(200, 6);
    });
  }

  it("an unknown venue name still counts (allowlist would silently drop new DEXes)", async () => {
    mock([lhPool({ pool_id: 1, dex_name: "SomeNewDex" }), lhPool({ pool_id: 2, lp_asset_id: 9_000_002, dex_name: "SomeNewDex" })]);
    expect(tvlOf(await fetchBoard(), A)).toBeCloseTo(200, 6);
  });

  it("drops a pool with a missing dex_name (fails closed)", async () => {
    mock([lhPool({ pool_id: 1 }), lhPool({ pool_id: 2, lp_asset_id: 9_000_002 }),
          lhPool({ pool_id: 3, lp_asset_id: 9_000_003, dex_name: undefined, tvl_algo_micro: 5_000_000_000 })]);
    expect(tvlOf(await fetchBoard(), A)).toBeCloseTo(200, 6);
  });
});

describe("board basics", () => {
  it("excludes LP tokens using lp_asset_id from the pool set", async () => {
    mock([lhPool({ pool_id: 1, asset_a: A, asset_b: 9_000_000 }),
          lhPool({ pool_id: 2, lp_asset_id: 9_000_000, asset_a: A, asset_b: B })]);
    const b = await fetchBoard();
    expect(b?.top.some((r) => r.assetId === 9_000_000)).toBe(false);
  });

  it("requires at least 2 pools", async () => {
    mock([lhPool({ pool_id: 1, asset_a: A, asset_b: B }),
          lhPool({ pool_id: 2, lp_asset_id: 9_000_002, asset_a: A, asset_b: C })]);
    const b = await fetchBoard();
    expect(b?.top.some((r) => r.assetId === A)).toBe(true);   // 2 pools
    expect(b?.top.some((r) => r.assetId === B)).toBe(false);  // 1 pool
  });

  it("returns null rather than throwing when the data layer is down", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 500, json: async () => ({}) }));
    await expect(fetchBoard()).resolves.toBeNull();
  });

  it("never rejects on hostile payloads", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, json: async () => ({ pools: [null, 1, "x"], assets: "no", prices: null }) }));
    await expect(fetchBoard()).resolves.not.toThrow();
  });
});
