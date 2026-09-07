import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { POOLS, DUST_POOLS } from "./pools";
import { fetchAggregateTvlUsd } from "./tvlAggregate";

const U = 3081853135;
const TINYMAN_POOLS = [...POOLS, ...DUST_POOLS].filter((p) => p.dex === "tinyman");
const PACT_POOLS = [...POOLS, ...DUST_POOLS].filter((p) => p.dex === "pact");

/** Synthetic LP asset id per hardcoded Tinyman pool — this is the canonical dedupe key. */
const lpIdFor = (addr: string) => 900_000_000 + TINYMAN_POOLS.findIndex((p) => p.ref === addr);

type Reply = { status?: number; json?: unknown; hang?: boolean; reject?: boolean };
type Router = (url: string) => Reply | null;

function mockFetch(route: Router) {
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input);
    const r = route(url);
    if (!r) return { ok: false, status: 404, json: async () => ({}) };
    if (r.reject) throw new Error("network down");
    if (r.hang) { await new Promise((res) => setTimeout(res, 10_000)); }
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => r.json ?? {} };
  });
}

/** Baseline: every hardcoded pool resolves to $100; LiquiHog returns nothing. */
function baselineRouter(over: Router = () => null): Router {
  return (url) => {
    const o = over(url);
    if (o) return o;
    if (url.includes("analytics.tinyman.org")) {
      const addr = url.split("/pools/")[1]?.replace(/\/$/, "") ?? "";
      return { json: { liquidity_in_usd: "100", liquidity_asset: { id: String(lpIdFor(addr)) } } };
    }
    if (url.includes("api.pact.fi")) return { json: { tvl_usd: "100" } };
    if (url.includes("hogswap-v1.liquihog.dev")) return { json: { pools: [] } };
    if (url.includes("mainnet-idx.algonode.cloud")) return { json: { applications: [] } };
    return null;
  };
}

const lhPool = (over: Record<string, unknown> = {}) => ({
  pool_id: 4_000_001,
  lp_asset_id: 4_000_001,
  dex_name: "STAMM",
  tvl_usd_micro: 180_640_000,
  tvl_confidence_bps: 9000,
  tvl_priced_sides: 2,
  tvl_rate_encoded: false,
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe("floor and discovery", () => {
  it("counts every hardcoded pool", async () => {
    mockFetch(baselineRouter());
    const r = await fetchAggregateTvlUsd();
    expect(r!.poolsCounted).toBe(TINYMAN_POOLS.length + PACT_POOLS.length);
    expect(r!.usdTotal).toBeCloseTo(100 * (TINYMAN_POOLS.length + PACT_POOLS.length), 6);
    expect(r!.floorUnresolved).toBe(0);
  });

  it("keeps the full floor even when LiquiHog omits everything (union, never replace)", async () => {
    mockFetch(baselineRouter());
    const r = await fetchAggregateTvlUsd();
    expect(r!.usdTotal).toBe(r!.floorUsd);
    expect(r!.fromDiscovery).toBe(0);
  });

  it("adds a LiquiHog-only pool (STAMM discovery)", async () => {
    mockFetch(baselineRouter((u) =>
      u.includes("liquihog") ? { json: { pools: [lhPool()] } } : null));
    const r = await fetchAggregateTvlUsd();
    expect(r!.fromDiscovery).toBe(1);
    expect(r!.usdTotal).toBeCloseTo(r!.floorUsd + 180.64, 4);
  });
});

describe("dedupe — the highest-probability bug", () => {
  it("counts a pool present as a hardcoded ADDRESS and a LiquiHog POOL_ID exactly once", async () => {
    const dupAddr = TINYMAN_POOLS[0].ref;
    const dupLp = lpIdFor(dupAddr);
    mockFetch(baselineRouter((u) =>
      u.includes("liquihog")
        ? { json: { pools: [lhPool({ pool_id: dupLp, lp_asset_id: dupLp, dex_name: "Tinyman v2", tvl_usd_micro: 99_999_000_000 })] } }
        : null));
    const r = await fetchAggregateTvlUsd();
    expect(r!.fromDiscovery).toBe(0);
    expect(r!.poolsCounted).toBe(TINYMAN_POOLS.length + PACT_POOLS.length);
    // our own $100 wins; LiquiHog's inflated value is not added and does not replace it
    expect(r!.usdTotal).toBe(r!.floorUsd);
  });
});

describe("unit conversion", () => {
  it("divides tvl_usd_micro by 1e6", async () => {
    mockFetch(baselineRouter((u) =>
      u.includes("liquihog") ? { json: { pools: [lhPool({ tvl_usd_micro: 543_210_000 })] } } : null));
    const r = await fetchAggregateTvlUsd();
    expect(r!.usdTotal - r!.floorUsd).toBeCloseTo(543.21, 4);
  });
});

describe("precedence", () => {
  it("uses LiquiHog only as a backstop when our own fetch failed", async () => {
    const addr = TINYMAN_POOLS[0].ref;
    const lp = lpIdFor(addr);
    mockFetch(baselineRouter((u) => {
      if (u.includes(addr)) return { status: 500 };
      if (u.includes("liquihog"))
        return { json: { pools: [lhPool({ pool_id: lp, lp_asset_id: lp, dex_name: "Tinyman v2", tvl_usd_micro: 250_000_000 })] } };
      return null;
    }));
    const r = await fetchAggregateTvlUsd();
    // failed direct fetch is backstopped, not dropped — this is the M1 improvement
    expect(r!.floorUnresolved).toBe(1);   // key unknowable after an HTTP failure
    expect(r!.fromDiscovery).toBe(1);     // ...but the value was backstopped, not lost
    expect(r!.usdTotal).toBeCloseTo(100 * (TINYMAN_POOLS.length + PACT_POOLS.length - 1) + 250, 4);
  });
});

describe("poison guards — all fail closed", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["NaN tvl", { tvl_usd_micro: "not-a-number" }],
    ["Infinity tvl", { tvl_usd_micro: Infinity }],
    ["negative tvl", { tvl_usd_micro: -5_000_000 }],
    ["missing tvl", { tvl_usd_micro: undefined }],
    ["rate_encoded true", { tvl_rate_encoded: true }],
    ["rate_encoded MISSING (fail closed)", { tvl_rate_encoded: undefined }],
    ["priced_sides 1", { tvl_priced_sides: 1 }],
    ["priced_sides missing", { tvl_priced_sides: undefined }],
    ["low confidence", { tvl_confidence_bps: 100 }],
    ["confidence missing", { tvl_confidence_bps: undefined }],
    ["non-numeric pool_id", { pool_id: "'; DROP" }],
    ["negative pool_id", { pool_id: -1 }],
    ["dominating pool", { tvl_usd_micro: 10_000_000_000_000 }],
  ];
  for (const [label, over] of cases) {
    it(`drops: ${label}`, async () => {
      mockFetch(baselineRouter((u) =>
        u.includes("liquihog") ? { json: { pools: [lhPool(over)] } } : null));
      const r = await fetchAggregateTvlUsd();
      expect(r!.usdTotal).toBe(r!.floorUsd);
      expect(r!.fromDiscovery).toBe(0);
      expect(r!.guardsFired.length).toBeGreaterThan(0);
    });
  }

  it("ignores malformed top-level LiquiHog payloads", async () => {
    for (const json of [{}, { pools: null }, { pools: "nope" }, { pools: [null, 7, "x"] }, []]) {
      mockFetch(baselineRouter((u) => (u.includes("liquihog") ? { json } : null)));
      const r = await fetchAggregateTvlUsd();
      expect(r!.usdTotal).toBe(r!.floorUsd);
    }
  });
});

describe("failure behaviour", () => {
  it("degrades to the floor when LiquiHog is down", async () => {
    for (const reply of [{ status: 500 }, { reject: true }, { json: "garbage" }] as Reply[]) {
      mockFetch(baselineRouter((u) => (u.includes("liquihog") ? reply : null)));
      const r = await fetchAggregateTvlUsd();
      expect(r!.usdTotal).toBe(r!.floorUsd);
    }
  });

  it("returns null only when every source fails", async () => {
    mockFetch(() => ({ reject: true }));
    expect(await fetchAggregateTvlUsd()).toBeNull();
  });

  it("never rejects, even when every fetch throws synchronously", async () => {
    vi.stubGlobal("fetch", () => { throw new Error("boom"); });
    await expect(fetchAggregateTvlUsd()).resolves.not.toThrow();
  });

  it("never rejects on a hostile indexer payload", async () => {
    mockFetch(baselineRouter((u) =>
      u.includes("algonode")
        ? { json: { applications: [null, { id: "x" }, { id: 1, params: { "global-state": "nope" } }] } }
        : null));
    await expect(fetchAggregateTvlUsd()).resolves.toBeTruthy();
  });
});

// ── architectural guards (ASA_TVL_SPEC.md §6) ───────────────────────────────────

const SRC = join(__dirname, "..");
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}
const FILES = walk(SRC);
const read = (f: string) => readFileSync(f, "utf8");
const importsOf = (f: string) =>
  [...read(f).matchAll(/from\s+["'](@\/[^"']+|\.[^"']+)["']/g)].map((m) => m[1]);

function resolve(spec: string, from: string): string | null {
  const base = spec.startsWith("@/") ? join(SRC, spec.slice(2)) : join(from, "..", spec);
  for (const c of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (FILES.includes(c)) return c;
  }
  return null;
}
function closure(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const s of importsOf(f)) {
      const r = resolve(s, f);
      if (r) stack.push(r);
    }
  }
  return seen;
}

describe("MagnetFi isolation (transitive, directional)", () => {
  const DISPLAY = ["lib/pools.ts", "lib/tokenStats.ts", "lib/tvlAggregate.ts"];
  const magnetfiFiles = FILES.filter(
    (f) => /lib\/magnetfi[^/]*\.ts$/.test(f) || f.includes(join("components", "magnetfi")),
  );

  it("finds MagnetFi modules to check", () => expect(magnetfiFiles.length).toBeGreaterThan(0));

  for (const f of magnetfiFiles) {
    it(`${f.slice(SRC.length + 1)} does not reach display TVL code`, () => {
      const reached = [...closure(f)].map((x) => x.slice(SRC.length + 1).replace(/\\/g, "/"));
      for (const d of DISPLAY) expect(reached).not.toContain(d);
    });
  }
});

describe("client-graph guard", () => {
  it("tvlAggregate is not reachable from any \"use client\" entry point", () => {
    const clientEntries = FILES.filter((f) => /^\s*["']use client["']/.test(read(f)));
    expect(clientEntries.length).toBeGreaterThan(0);
    for (const e of clientEntries) {
      const reached = [...closure(e)].map((x) => x.slice(SRC.length + 1).replace(/\\/g, "/"));
      expect(reached, `${e} pulls tvlAggregate into the client bundle`)
        .not.toContain("lib/tvlAggregate.ts");
    }
  });
});
