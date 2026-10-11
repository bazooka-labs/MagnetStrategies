// Pool deep links.
//
// These broke silently once already. When Pact moved to its new contracts every
// `app.pact.fi/add-liquidity/<id>` link started returning 404 while the `ref`
// sitting next to it stayed correct — so the API reads kept working, the cards
// kept showing live TVL and APR, and only the buttons were dead. Nothing in the
// build or the tests noticed, because a hard-coded string is always "valid".
//
// Deriving the URL from `ref` removes the drift. These tests pin the derivation
// so a future edit to the shape has to be deliberate.
//
// What they deliberately do NOT do is hit the network. A test that fetched
// app.pact.fi would fail on a plane and on every CI runner without egress, and
// would turn an unrelated outage into a red build. The live check belongs in the
// record of the change, not in the suite — it is written up in the commit and in
// the comment beside `DEX_POOL_URL`.

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tokenIcon } from "@/components/magnetfi/v2/shared";
import { MUSD_POOLS, POOLS, combineMetrics, type Pool, type PoolMetrics } from "./pools";

const all: Pool[] = [...POOLS, ...MUSD_POOLS];
/** Every (pair, venue) pair — a pair on two DEXes yields two rows. */
const venues = all.flatMap((p) => p.venues.map((v) => ({ ...v, id: p.id })));

describe("pool deep links", () => {
  it("every venue has a link built from its own ref", () => {
    for (const v of venues) {
      expect(v.addLiquidityUrl, v.id).toContain(v.ref);
      expect(v.addLiquidityUrl, v.id).toMatch(/^https:\/\//);
    }
  });

  it("uses the current Pact path, not the retired add-liquidity one", () => {
    const pact = venues.filter((v) => v.dex === "pact");
    expect(pact.length).toBeGreaterThan(0);
    for (const v of pact) {
      expect(v.addLiquidityUrl, v.id).toBe(`https://app.pact.fi/pool/${v.ref}`);
      // The specific shape that 404s. Named so a revert is loud.
      expect(v.addLiquidityUrl, v.id).not.toContain("add-liquidity");
    }
  });

  it("uses the Tinyman pool path", () => {
    const tinyman = venues.filter((v) => v.dex === "tinyman");
    expect(tinyman.length).toBeGreaterThan(0);
    for (const v of tinyman) {
      expect(v.addLiquidityUrl, v.id).toBe(`https://app.tinyman.org/pool/${v.ref}`);
    }
  });

  it("keys a Pact pool by numeric id and a Tinyman pool by address", () => {
    // Crossing these would produce a plausible-looking URL that resolves to
    // nothing, which is exactly the failure this file exists to catch.
    for (const v of venues) {
      if (v.dex === "pact") expect(v.ref, v.id).toMatch(/^\d+$/);
      else expect(v.ref, v.id).toMatch(/^[A-Z2-7]{58}$/);
    }
  });

  it("has no duplicate pair ids or venue refs", () => {
    expect(new Set(all.map((p) => p.id)).size).toBe(all.length);
    // Across venues, not pairs: the same pool must never be listed twice, or
    // its liquidity is double counted in Total TVL.
    expect(new Set(venues.map((v) => v.ref)).size).toBe(venues.length);
  });

  it("gives a multi-venue pair one card with a link per DEX", () => {
    const multi = all.filter((p) => p.venues.length > 1);
    expect(multi.map((p) => p.id)).toContain("u-algo");
    for (const p of multi) {
      // One entry per DEX, so the breakdown cannot show the same venue twice.
      expect(new Set(p.venues.map((v) => v.dex)).size, p.id).toBe(p.venues.length);
    }
  });
});

describe("combining venues", () => {
  const m = (tvlUsd: number | null, totalApr: number | null): PoolMetrics =>
    ({ tvlUsd, feeApr: totalApr, farmApr: null, totalApr });

  it("passes a single venue through untouched", () => {
    const one = m(100, 5);
    expect(combineMetrics([one])).toBe(one);
  });

  it("weights APR by TVL rather than averaging", () => {
    // The live case on 2026-10-10: Tinyman $2,573 at 3.69%, Pact $2,112 at
    // 0.42%. A plain mean says 2.06%; what a dollar earns is 2.22%.
    const c = combineMetrics([m(2573, 3.69), m(2112, 0.42)]);
    expect(c.tvlUsd).toBe(4685);
    expect(c.totalApr).toBeCloseTo(2.22, 2);
    expect(c.totalApr).not.toBeCloseTo(2.06, 2);
  });

  it("gives an empty pool no vote on the headline APR", () => {
    // Otherwise a drained pool advertising 400% would dominate the pair.
    const c = combineMetrics([m(10_000, 5), m(0, 400)]);
    expect(c.totalApr).toBeCloseTo(5, 6);
  });

  it("falls back to a plain mean when no venue reports TVL", () => {
    // Two brand-new pools should still show their advertised rate, not nothing.
    const c = combineMetrics([m(null, 4), m(null, 6)]);
    expect(c.totalApr).toBeCloseTo(5, 6);
    expect(c.tvlUsd).toBeNull();
  });

  it("sums TVL even when one venue fails to report", () => {
    expect(combineMetrics([m(100, 5), m(null, null)]).tvlUsd).toBe(100);
  });

  it("leaves farmApr null unless a venue actually farms", () => {
    // A blended zero must not light up the Farming badge.
    expect(combineMetrics([m(100, 5), m(100, 5)]).farmApr).toBeNull();
    const farming = combineMetrics([
      { tvlUsd: 100, feeApr: 5, farmApr: 10, totalApr: 15 },
      { tvlUsd: 100, feeApr: 5, farmApr: null, totalApr: 5 },
    ]);
    expect(farming.farmApr).toBeCloseTo(10, 6);
  });
});

describe("pool token icons", () => {
  // A token with no entry falls back to a text chip. That is a deliberate
  // feature of TokenChip, not an error — which is exactly why adding a pool
  // and forgetting its logo shows something plausible and passes unnoticed.
  // FOLKS sat that way until 2026-10-04.
  const symbols = [...new Set([...POOLS, ...MUSD_POOLS].flatMap((p: Pool) => [
    ...p.pair.split("/").map((s) => s.trim()),
    p.partner,
  ]))];

  it("covers every token shown on a pool card", () => {
    const missing = symbols.filter((s) => tokenIcon(s) === null);
    expect(missing, `no icon mapped for: ${missing.join(", ")}`).toEqual([]);
  });

  it("maps each one to a file that actually exists", () => {
    // The map is strings, so a typo or a deleted file is a broken image at
    // runtime and nothing at build time.
    const broken = symbols.filter((s) => {
      const icon = tokenIcon(s);
      return icon !== null && !existsSync(`public${icon}`);
    });
    expect(broken, `icon path points at no file: ${broken.join(", ")}`).toEqual([]);
  });
});
