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
import {
  MUSD_POOLS,
  POOLS,
  combineMetrics,
  resolvePactApr,
  type Pool,
  type PoolMetrics,
} from "./pools";

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
    ({ tvlUsd, feeApr: totalApr, farmApr: null, totalApr, farmLive: false });

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
  });

  it("dilutes a farm across the venues that do NOT have one", () => {
    // This assertion used to expect 10 — it encoded the bug rather than the
    // intent, which is why the bug shipped. Half the pair's liquidity earns a
    // 10% farm and half earns none, so a dollar in the pair earns 5%.
    const farming = combineMetrics([
      { tvlUsd: 100, feeApr: 5, farmApr: 10, totalApr: 15, farmLive: true },
      { tvlUsd: 100, feeApr: 5, farmApr: null, totalApr: 5, farmLive: false },
    ]);
    expect(farming.farmApr).toBeCloseTo(5, 6);
  });

  it("keeps fee + farm equal to the headline total", () => {
    // The invariant the card displays, and the one that would have caught the
    // U/ALGO error: it read Fee 3.18 + Farm 7.45 against a Total of 6.53,
    // because the farm was averaged over only the farming venue's TVL while the
    // total was averaged over both. Live shape, uneven TVL on purpose — equal
    // weights hide a weighting bug.
    const c = combineMetrics([
      { tvlUsd: 2478.45, feeApr: 3.1493, farmApr: null, totalApr: 3.1493, farmLive: false },
      { tvlUsd: 2019.3, feeApr: 3.2228, farmApr: 7.4528, totalApr: 10.6756, farmLive: true },
    ]);
    expect(c.feeApr! + c.farmApr!).toBeCloseTo(c.totalApr!, 6);
    expect(c.farmApr).toBeCloseTo(3.3458, 3);
  });

  it("carries farmLive over from any one venue", () => {
    // A farm running on the Pact side of a pair is still stakeable even if the
    // Tinyman side has none and the blended rate is nothing.
    const c = combineMetrics([
      { tvlUsd: 100, feeApr: 5, farmApr: null, totalApr: 5, farmLive: true },
      { tvlUsd: 100, feeApr: 5, farmApr: null, totalApr: 5, farmLive: false },
    ]);
    expect(c.farmLive).toBe(true);
    expect(c.farmApr).toBeNull();
  });
});

describe("Pact farm APR", () => {
  // Pact reports a farm two different ways depending on how old the pool is.
  //
  // Measured 2026-10-14: `/api/pools/{id}` — the endpoint the cards read for TVL
  // and fee APR — returns `rewards: []` and `apr_7d_all === apr_7d` for all six
  // $U pools even though FOUR of them are being farmed (U/COMPX, U/ALGO,
  // U/ALPHA, U/FOLKS, all paying POW out of Pact's farm factory). So the
  // "excess of apr_7d_all over apr_7d" rule that used to derive farmApr can only
  // ever yield zero on these pools, and every Pact farm was invisible.
  const r = resolvePactApr;

  it("takes the farm Pact states outright in its v1 index", () => {
    // The live U/COMPX case: 32.88% fees, 0.92% farm, and a legacy endpoint
    // that reports no farm at all.
    const out = r({ feeApr: 32.88, reportedTotal: 32.88, indexedFarm: 0.92 });
    expect(out.farmApr).toBeCloseTo(0.92, 6);
    expect(out.totalApr).toBeCloseTo(33.8, 6);
  });

  it("reports no farm when neither source shows one", () => {
    const out = r({ feeApr: 5.76, reportedTotal: 5.76, indexedFarm: 0 });
    expect(out.farmApr).toBeNull();
    expect(out.farmLive).toBe(false);
    expect(out.totalApr).toBeCloseTo(5.76, 6);
  });

  it("flags a live farm that has no rate yet", () => {
    // The live U/ALGO, U/ALPHA and U/FOLKS case on 2026-10-14: the farm is
    // funded and running, but Pact computes APR against what is staked and
    // nothing is staked, so it reports 0. The pool must still read as farming —
    // an unstaked farm is the one worth staking into.
    const out = r({ feeApr: 1.43, reportedTotal: 1.43, indexedFarm: 0, farmLive: true });
    expect(out.farmLive).toBe(true);
    expect(out.farmApr).toBeNull();
    // No rate means nothing to add, so the headline stays the fee APR rather
    // than inventing a farm contribution.
    expect(out.totalApr).toBeCloseTo(1.43, 6);
  });

  it("counts a rate as farming even if the status flag never arrived", () => {
    const out = r({ feeApr: 4, reportedTotal: 14, indexedFarm: null });
    expect(out.farmLive).toBe(true);
  });

  it("still finds a farm folded into the legacy total", () => {
    // Pact's older pools are absent from the v1 index, so the fold is the only
    // signal they have. Dropping it would have un-farmed them.
    const out = r({ feeApr: 4, reportedTotal: 14, indexedFarm: null });
    expect(out.farmApr).toBeCloseTo(10, 6);
    expect(out.totalApr).toBeCloseTo(14, 6);
  });

  it("does not double-count a farm reported by both sources", () => {
    // The indexed figure wins, and the total is rebuilt from fee + farm rather
    // than added on top of a legacy total that already contained it.
    const out = r({ feeApr: 4, reportedTotal: 14, indexedFarm: 10 });
    expect(out.farmApr).toBeCloseTo(10, 6);
    expect(out.totalApr).toBeCloseTo(14, 6);
  });

  it("treats rounding dust as no farm", () => {
    // Otherwise the Farming badge lights up on a farm that has stopped paying.
    expect(r({ feeApr: 5, reportedTotal: 5.005, indexedFarm: 0.001 }).farmApr).toBeNull();
  });

  it("keeps the legacy total when the fee APR is missing", () => {
    // With no feeApr there is nothing to add a farm to, so the upstream figure
    // is passed through rather than invented.
    const out = r({ feeApr: null, reportedTotal: 9, indexedFarm: 3 });
    expect(out.totalApr).toBeCloseTo(9, 6);
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

  /**
   * Tokens knowingly shipping without an icon.
   *
   * An EXPLICIT list, not a softened assertion. The whole point of the test
   * below is that a forgotten logo renders as something plausible and passes
   * unnoticed — so the fix for a deliberate omission is to name it, with the
   * reason and the thing that removes it, rather than to let the check go
   * quiet for every future pool as well.
   *
   * `uALGO` (asset 3760411000, `magnetALGO`) — added 2026-11-04 with the Myth
   * Finance pool. The ASA carries no logo: its `url` points at a Myth Finance
   * page rather than an image, and Pera held no record. Verification with
   * Pera is in progress and the art is expected within the week, at which
   * point this entry comes out rather than being left to rot.
   */
  /*
    Empty, and that is the point of the staleness check below.

    uALGO sat here from 2026-11-04 while magnetALGO waited on Pera
    verification. It verified on 2026-11-05 and the logo is now vendored at
    /tokens/ualgo.png, so the exception had to go — the test two blocks down
    fails if a symbol listed here turns out to have an icon after all, which
    is what stopped this becoming a permanent "known missing".
  */
  const KNOWN_ICONLESS = new Set<string>([]);

  it("covers every token shown on a pool card", () => {
    const missing = symbols.filter((s) => tokenIcon(s) === null && !KNOWN_ICONLESS.has(s));
    expect(missing, `no icon mapped for: ${missing.join(", ")}`).toEqual([]);
  });

  it("keeps the exception list honest", () => {
    // An entry that has since GAINED an icon must be deleted, or the list
    // quietly becomes a place where checks go to die.
    const stale = [...KNOWN_ICONLESS].filter((s) => tokenIcon(s) !== null);
    expect(stale, `these now have icons and should leave KNOWN_ICONLESS: ${stale.join(", ")}`)
      .toEqual([]);
    // And an entry for a token no pool shows is equally dead.
    const unused = [...KNOWN_ICONLESS].filter((s) => !symbols.includes(s));
    expect(unused, `not shown on any pool card: ${unused.join(", ")}`).toEqual([]);
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

/**
 * The liquid-staking pools, asserted against the REAL data.
 *
 * `LpPoolsGlow.test.tsx` renders the card from its own fixture, so it proves
 * the component honours the flag and proves nothing about which pools carry
 * it. Deleting `accent` and `liquidStaking` from the tALGO entry survived
 * that suite untouched — the exact change this was all for.
 */
describe("liquid-staking pools", () => {
  /** Both verified on chain 2026-11-07 — see the `liquidStaking` doc. */
  const EXPECTED = ["u-talgo", "u-ualgo"];

  it("flags exactly the two ALGO liquid-staking pairs", () => {
    const flagged = all.filter((p) => p.liquidStaking).map((p) => p.id).sort();
    expect(flagged).toEqual(EXPECTED);
  });

  it("gives both of them the gold accent", () => {
    // The pair the user sees: same kind of pool, same glow. tALGO was purple
    // and unbadged until 2026-11-07 while uALGO was gold, which made two
    // pools of one kind read as two different kinds.
    for (const id of EXPECTED) {
      const p = all.find((x) => x.id === id)!;
      expect(p, `${id} missing from POOLS`).toBeDefined();
      expect(p.accent, `${id} should be gold`).toBe("gold");
    }
  });

  it("does not flag plain ALGO", () => {
    // U/ALGO is the native asset, not a staking derivative. If the badge
    // ever lands on it the distinction it draws is gone.
    expect(all.find((p) => p.id === "u-algo")!.liquidStaking).toBeUndefined();
    expect(all.find((p) => p.id === "u-algo")!.accent).toBeUndefined();
  });

  it("keeps gold for liquid staking only, so the glow means one thing", () => {
    // Gold marks the ALGO-family outsider. Today that set and the
    // liquid-staking set are identical; if a future pool is gold for some
    // other reason this fails and the legend needs rewording, because it
    // tells the reader gold means staked ALGO.
    const gold = all.filter((p) => p.accent === "gold").map((p) => p.id).sort();
    expect(gold).toEqual(EXPECTED);
  });
});
