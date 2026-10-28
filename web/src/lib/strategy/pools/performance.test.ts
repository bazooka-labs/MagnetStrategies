/**
 * PEX's pool statistics bundle, parsed against a REAL captured response.
 *
 * The fixture is the live mainnet bundle from 2026-10-21T00:00Z
 * (`__fixtures__/performance.sample.json`, 50 KB), not a hand-written
 * sample — so these pin the shape Ultrade actually publishes rather than the
 * shape I assumed. Every rule asserted here is one PEX states in SDK 0.6.9/
 * 0.6.10's INTEGRATION_GUIDE, because the expensive mistakes on this data are
 * display mistakes, not parse errors.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PerformanceBundleError, benchmarkLabel, cvaKey, marketKey, parsePerformanceBundle,
} from "./performance";

const RAW = JSON.parse(
  readFileSync("src/lib/strategy/__fixtures__/performance.sample.json", "utf8")) as unknown;
/** Inside the fixture's 36h validity, so `stale` is false unless a test says otherwise. */
const FRESH = 1792550100;

describe("the real bundle parses to the real numbers", () => {
  const b = parsePerformanceBundle(RAW, FRESH);

  it("reads ALGO/USD's income APR as fee + yield", () => {
    // 483 + 639 = 1122 bps. The yield half is LARGER than the fee half, and
    // our on-chain derivation omitted it entirely while still reading 3.2x
    // high at 15.3% — because it annualized fees since inception and trading
    // has slowed 4.1x since.
    const i = b.byKey[marketKey(1)].income!;
    expect(i.feePct).toBeCloseTo(4.83, 2);
    expect(i.yieldPct).toBeCloseTo(6.39, 2);
    expect(i.totalPct).toBeCloseTo(11.22, 2);
    expect(i.totalPct).toBeCloseTo(i.feePct + i.yieldPct, 6);
  });

  it("reads BTC/USD earning yield on zero trading", () => {
    // Fee APR is exactly 0 — no trading, consistent with its $0 open interest
    // — but it still earns 6.14% on idle capital. A page showing only fees
    // would call this pool worthless, which it is not.
    const i = b.byKey[marketKey(2)].income!;
    expect(i.feePct).toBe(0);
    expect(i.yieldPct).toBeCloseTo(6.14, 2);
    expect(i.totalPct).toBeCloseTo(6.14, 2);
  });

  it("reads the C-Vault under its own key shape", () => {
    const i = b.byKey[cvaKey(3690309167)].income!;
    expect(i.totalPct).toBeCloseTo(9.08, 2);
  });

  it("converts bps by 100, not 10,000", () => {
    // PEX: "divide by 100 to display a percentage: 1250 means 12.5%."
    // Dividing by 10,000 would render 11.22% as 0.11%.
    expect(b.byKey[marketKey(1)].income!.totalPct).toBeGreaterThan(1);
  });

  it("reads the 30d return and the benchmark comparison", () => {
    const r = b.byKey[marketKey(1)].ret!;
    expect(r.period).toBe("30d");
    expect(r.productPct).toBeCloseTo(1.19, 2);
    expect(r.holdPct).toBeCloseTo(0.39, 2);
    expect(r.vsHoldingPoints).toBeCloseTo(0.80, 2);
    expect(r.points).toBe(30);
    expect(r.benchmarkKind).toBe("geometric_mean_50_50");
  });

  it("reads a pool that LOST to the benchmark", () => {
    // market 2 is -0.84pp over 30d. If this ever reads positive by accident,
    // the page is flattering a pool that underperformed holding the assets.
    expect(b.byKey[marketKey(2)].ret!.vsHoldingPoints).toBeCloseTo(-0.84, 2);
  });

  it("switches period on request", () => {
    const seven = parsePerformanceBundle(RAW, FRESH, "7d");
    const r = seven.byKey[marketKey(1)].ret!;
    expect(r.period).toBe("7d");
    expect(r.points).toBe(7);
    expect(r.vsHoldingPoints).toBeCloseTo(4.11, 2);
  });

  it("carries the APR window and coverage, not just the rate", () => {
    const i = b.byKey[marketKey(1)].income!;
    expect(i.windowEnd - i.windowStart).toBe(7 * 86_400);
    expect(i.missingEvents).toBe(0);
  });
});

describe("unavailable is never zero", () => {
  const sub = (patch: (p: Record<string, unknown>) => void) => {
    const copy = JSON.parse(JSON.stringify(RAW)) as Record<string, unknown>;
    patch((copy.payloads as Record<string, Record<string, unknown>>)["market-1"]);
    return parsePerformanceBundle(copy, FRESH);
  };

  it("drops the APR when status is not ready", () => {
    // PEX: "missing/non-ready values mean unavailable, not 0%."
    const b = sub((p) => { (p.income_apr as Record<string, unknown>).apr_status = "pending"; });
    expect(b.byKey[marketKey(1)].income).toBeNull();
  });

  it("drops the APR on an unrecognised basis", () => {
    // "Display APR only when … basis is historical_capital_v1."
    const b = sub((p) => { (p.income_apr as Record<string, unknown>).apr_basis = "something_v2"; });
    expect(b.byKey[marketKey(1)].income).toBeNull();
  });

  it("surfaces insufficient_history as a reason, not a 0% return", () => {
    const b = sub((p) => {
      (p.performance as Record<string, unknown>)["30d"] = { reason: "insufficient_history" };
    });
    expect(b.byKey[marketKey(1)].ret).toBeNull();
    expect(b.byKey[marketKey(1)].retUnavailableReason).toBe("insufficient_history");
  });

  it("honours a reason even when points and a summary are present", () => {
    /**
     * This is the version with teeth.
     *
     * The test above passes whether or not the parser checks `reason`, because
     * its fixture has no points and the `points < 2` guard catches it anyway —
     * so removing the reason check left it green. PEX says
     * `insufficient_history` and `no_valid_completed_samples` are valid
     * RESULTS to display as such; if a degraded response ever carries both a
     * reason and a full series, the reason wins and we show nothing rather
     * than a number PEX declined to stand behind.
     */
    const copy = JSON.parse(JSON.stringify(RAW)) as Record<string, unknown>;
    const perf = (copy.payloads as Record<string, Record<string, unknown>>)["market-1"]
      .performance as Record<string, Record<string, unknown>>;
    perf["30d"].reason = "no_valid_completed_samples";
    // Points and summary left intact — 30 real observations still sitting there.
    expect((perf["30d"].points as unknown[]).length).toBe(30);
    const b = parsePerformanceBundle(copy, FRESH);
    expect(b.byKey[marketKey(1)].ret).toBeNull();
    expect(b.byKey[marketKey(1)].retUnavailableReason).toBe("no_valid_completed_samples");
  });

  it("refuses a single data point", () => {
    // "fewer than two points exist -> show Insufficient history, not the
    // placeholder zero returns as 0% performance."
    const b = sub((p) => {
      (p.performance as Record<string, unknown>)["30d"] = {
        summary: { product_return_bps: 0, hold_return_bps: 0, vs_holding_bps: 0 },
        benchmark: { kind: "geometric_mean_50_50" }, points: [{ timestamp: 1 }],
      };
    });
    expect(b.byKey[marketKey(1)].ret).toBeNull();
    expect(b.byKey[marketKey(1)].retUnavailableReason).toBe("insufficient_history");
  });

  it("flags history gaps rather than drawing them as continuous", () => {
    const copy = JSON.parse(JSON.stringify(RAW)) as Record<string, unknown>;
    const perf = (copy.payloads as Record<string, Record<string, unknown>>)["market-1"]
      .performance as Record<string, Record<string, unknown>>;
    (perf["30d"].points as Record<string, unknown>[])[5].gap_before = true;
    expect(parsePerformanceBundle(copy, FRESH).byKey[marketKey(1)].ret!.hasGaps).toBe(true);
  });
});

describe("envelope checks — the only integrity this feed has", () => {
  const mutate = (patch: Record<string, unknown>) =>
    parsePerformanceBundle({ ...(RAW as object), ...patch }, FRESH);

  it("refuses a bundle for another network", () => {
    // Unsigned, so a testnet bundle served at the mainnet key is otherwise
    // undetectable — and would put testnet yields on a mainnet page.
    expect(() => mutate({ network: "testnet" })).toThrow(PerformanceBundleError);
  });

  it("refuses an unexpected bundle type", () => {
    expect(() => mutate({ type: "something_else" })).toThrow(PerformanceBundleError);
  });

  it("refuses a bundle whose self-declared path is wrong", () => {
    expect(() => mutate({ current_path: "v2/pool-performance/testnet/current.json" }))
      .toThrow(PerformanceBundleError);
  });

  it("refuses a non-object", () => {
    for (const bad of [null, undefined, 42, "json"]) {
      expect(() => parsePerformanceBundle(bad, FRESH)).toThrow(PerformanceBundleError);
    }
  });

  it("marks an expired bundle stale instead of throwing or hiding it", () => {
    // PEX: "an expired valid object returns stale: true so it can be displayed
    // with its date and an explicit stale label."
    const b = parsePerformanceBundle(RAW, 1792670401);
    expect(b.stale).toBe(true);
    expect(b.byKey[marketKey(1)].income).not.toBeNull();
  });

  it("is not stale inside its 36h window", () => {
    expect(parsePerformanceBundle(RAW, FRESH).stale).toBe(false);
  });
});

describe("the benchmark is labelled for what it is", () => {
  it("never calls the geometric benchmark buy-and-hold", () => {
    // PEX: "It is NOT a literal buy-and-hold 50/50 basket" — if one asset
    // doubles and the other is flat it gains ~41.42% where the basket gains 50%.
    expect(benchmarkLabel("geometric_mean_50_50")).toBe("vs 50/50 geometric benchmark");
    expect(benchmarkLabel("geometric_mean_50_50")).not.toMatch(/holding/);
  });

  it("uses plain holding wording for a single-asset benchmark", () => {
    expect(benchmarkLabel("single_asset")).toBe("vs holding");
  });
});
