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

describe("confidence gate is 80%, matching Vestige", () => {
  const withConf = (bps: number) =>
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = String(input);
      const json =
        url.includes("/analytics/prices")
          ? { algo_usd: 0.1, as_of_round: 1,
              prices: { [String(A)]: { price_algo: 1, confidence_bps: bps },
                        [String(B)]: { price_algo: 1, confidence_bps: 9500 } } }
        : url.includes("/assets") ? { assets: [asset(A, "RWA"), asset(B, "ALGO")] }
        : url.includes("/pools")
          ? { pools: [lhPool({ pool_id: 1 }), lhPool({ pool_id: 2, lp_asset_id: 9_000_002 })], as_of_round: 1 }
        : url.includes("algonode") ? { applications: [] }
        : {};
      return { ok: true, status: 200, json: async () => json };
    });

  // GOLD$ 8306 and SILVER$ 8149 were excluded by the old 8500 floor despite 48 and 40 pools.
  it.each([8306, 8149, 8000])("admits an asset at %i bps", async (bps) => {
    withConf(bps);
    const b = await fetchBoard();
    expect(b?.top.some((r) => r.assetId === A)).toBe(true);
  });

  it.each([7999, 6726, 10])("still excludes an asset at %i bps", async (bps) => {
    withConf(bps);
    const b = await fetchBoard();
    expect(b?.top.some((r) => r.assetId === A)).toBe(false);
  });
});

describe("Folks receipt tokens (fAssets) are excluded, governance token is not", () => {
  const FOLKS_GOV = 3203964481;

  function withAssets(assets: unknown[], pairId: number) {
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = String(input);
      const json =
        url.includes("/analytics/prices")
          ? { algo_usd: 0.1, as_of_round: 1,
              prices: { [String(pairId)]: { price_algo: 1, confidence_bps: 9500 },
                        [String(B)]: { price_algo: 1, confidence_bps: 9500 } } }
        : url.includes("/assets") ? { assets }
        : url.includes("/pools")
          ? { pools: [lhPool({ pool_id: 1, asset_a: pairId, asset_b: B }),
                      lhPool({ pool_id: 2, lp_asset_id: 9_000_002, asset_a: pairId, asset_b: B })],
              as_of_round: 1 }
        : url.includes("algonode") ? { applications: [] }
        : {};
      return { ok: true, status: 200, json: async () => json };
    });
  }
  const onBoard = async (id: number) =>
    (await fetchBoard())?.top.some((r) => r.assetId === id) ?? false;

  it.each([
    ["Folks V2 Algo", 971381860],
    ["Folks V2 USDC", 971384592],
    ["Folks V2 Meld Gold (g)", 1258524377],
    ["Folks V2 Meld Silver (g)", 1258524381],
    ["Folks V2 Wrapped BTC", 1067295154],
    ["Folks Algo", 686505742],
    ["Folks USDC", 686508050],
    ["Folks Tether USDt", 686509463],
    ["Folks Governance Algo", 794060802],
  ])("excludes %s", async (name, id) => {
    withAssets([asset(id, "fX", { name }), asset(B, "PAIR")], id);
    expect(await onBoard(id)).toBe(false);
  });

  it("KEEPS the FOLKS governance token", async () => {
    withAssets([asset(FOLKS_GOV, "FOLKS", { name: "Folks Finance" }), asset(B, "PAIR")], FOLKS_GOV);
    expect(await onBoard(FOLKS_GOV)).toBe(true);
  });

  it("keeps the governance token even if it were renamed to match the pattern", async () => {
    // exempt by asset id, not by name — a rename must not delist it
    withAssets([asset(FOLKS_GOV, "FOLKS", { name: "Folks V2 Something" }), asset(B, "PAIR")], FOLKS_GOV);
    expect(await onBoard(FOLKS_GOV)).toBe(true);
  });

  it("does not exclude unrelated names that merely mention folks", async () => {
    for (const [id, name] of [[557264326, "folks finance"], [2280345909, "Poor folks"], [1010645919, "Friday"]] as const) {
      withAssets([asset(id, "X", { name }), asset(B, "PAIR")], id);
      expect(await onBoard(id), name).toBe(true);
    }
  });
});
