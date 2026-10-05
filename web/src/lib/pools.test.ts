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

import { describe, expect, it } from "vitest";
import { MUSD_POOLS, POOLS, type Pool } from "./pools";

const all: Pool[] = [...POOLS, ...MUSD_POOLS];

describe("pool deep links", () => {
  it("every pool has a link built from its own ref", () => {
    for (const p of all) {
      expect(p.addLiquidityUrl, p.id).toContain(p.ref);
      expect(p.addLiquidityUrl, p.id).toMatch(/^https:\/\//);
    }
  });

  it("uses the current Pact path, not the retired add-liquidity one", () => {
    const pact = all.filter((p) => p.dex === "pact");
    expect(pact.length).toBeGreaterThan(0);
    for (const p of pact) {
      expect(p.addLiquidityUrl, p.id).toBe(`https://app.pact.fi/pool/${p.ref}`);
      // The specific shape that 404s. Named so a revert is loud.
      expect(p.addLiquidityUrl, p.id).not.toContain("add-liquidity");
    }
  });

  it("uses the Tinyman pool path", () => {
    const tinyman = all.filter((p) => p.dex === "tinyman");
    expect(tinyman.length).toBeGreaterThan(0);
    for (const p of tinyman) {
      expect(p.addLiquidityUrl, p.id).toBe(`https://app.tinyman.org/pool/${p.ref}`);
    }
  });

  it("keys a Pact pool by numeric id and a Tinyman pool by address", () => {
    // Crossing these would produce a plausible-looking URL that resolves to
    // nothing, which is exactly the failure this file exists to catch.
    for (const p of all) {
      if (p.dex === "pact") expect(p.ref, p.id).toMatch(/^\d+$/);
      else expect(p.ref, p.id).toMatch(/^[A-Z2-7]{58}$/);
    }
  });

  it("has no duplicate ids or refs", () => {
    expect(new Set(all.map((p) => p.id)).size).toBe(all.length);
    expect(new Set(all.map((p) => p.ref)).size).toBe(all.length);
  });
});
