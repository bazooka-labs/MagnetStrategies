// Chart line labels: the property is UNIQUENESS, so that is what is tested.
//
// The old test for this asserted the source text of the expression that built
// the label (`const bothSides = held.length > 1;`). It passed while the rule
// was wrong, because the rule it described was only correct as long as the
// read path looked at USDC collateral alone.

import { describe, expect, it } from "vitest";
import { heldLineQualifiers, type HeldLineIdentity } from "@/lib/strategy/perps/positionLines";
import { PEX_ASSETS, POSITION_COLLATERAL_ASSETS } from "@/lib/strategy/pex/config";

const L = (side: "long" | "short", collateralAssetId: number): HeldLineIdentity =>
  ({ side, collateralAssetId });
const usdcLong = L("long", PEX_ASSETS.usdc);
const algoLong = L("long", PEX_ASSETS.algo);
const usdcShort = L("short", PEX_ASSETS.usdc);
const algoShort = L("short", PEX_ASSETS.algo);

/** Every position a single wallet can hold in ONE market, per the `p2:` key. */
const everything = [usdcLong, algoLong, usdcShort, algoShort];

describe("no two lines in a market can share a label", () => {
  /**
   * Exhaustive over the reachable state, not a few hand-picked cases: with two
   * collaterals and two sides there are 16 subsets, so there is no reason to
   * sample. This is the test that goes red if the collateral is dropped from
   * the qualifier.
   */
  it("holds for all 16 combinations of positions in one market", () => {
    for (let mask = 0; mask < 16; mask++) {
      const held = everything.filter((_, i) => mask & (1 << i));
      const qs = heldLineQualifiers(held);
      expect(qs).toHaveLength(held.length);
      expect(new Set(qs).size, `mask ${mask}: ${JSON.stringify(qs)}`).toBe(held.length);
    }
  });

  it("is red for the specific pair the ALGO collateral read made reachable", () => {
    // Two LONGS in one market, differing in nothing but collateral. Before the
    // read path widened this state was unreachable through our UI, and the
    // label rule that ignored collateral produced "long " twice.
    const qs = heldLineQualifiers([usdcLong, algoLong]);
    expect(qs).toEqual(["long USDC ", "long ALGO "]);
  });
});

describe("the qualifier stays as short as the collision allows", () => {
  it("is empty for a single position", () => {
    expect(heldLineQualifiers([usdcLong])).toEqual([""]);
    expect(heldLineQualifiers([algoShort])).toEqual([""]);
  });

  it("is empty for no positions", () => {
    expect(heldLineQualifiers([])).toEqual([]);
  });

  it("names the side alone when the sides differ", () => {
    // Collateral is not mentioned here even though it differs: side already
    // separates them, and the label is drawn in the chart's price gutter.
    expect(heldLineQualifiers([usdcLong, algoShort])).toEqual(["long ", "short "]);
    expect(heldLineQualifiers([usdcLong, usdcShort])).toEqual(["long ", "short "]);
  });

  it("adds collateral only to the side that actually collides", () => {
    const qs = heldLineQualifiers([usdcLong, algoLong, usdcShort]);
    expect(qs).toEqual(["long USDC ", "long ALGO ", "short "]);
  });

  it("interpolates into the chart's label without a double space", () => {
    // The trailing space belongs to the qualifier; `Your ${who}entry` is the
    // caller. An empty qualifier must not leave "Your  entry".
    for (const q of heldLineQualifiers([usdcLong])) expect(`Your ${q}entry`).toBe("Your entry");
    const [q] = heldLineQualifiers([usdcLong, usdcShort]);
    expect(`Your ${q}entry`).toBe("Your long entry");
  });
});

describe("the rule covers every collateral the read path can return", () => {
  it("names each one rather than falling back to its asset id", () => {
    // If a third collateral is ever added to POSITION_COLLATERAL_ASSETS, this
    // fails until `assetName` knows it — otherwise the chart would label a line
    // "Your long asset 1134696561 entry".
    for (const id of POSITION_COLLATERAL_ASSETS) {
      const [q] = heldLineQualifiers([L("long", id), L("long", -1)]);
      expect(q).not.toMatch(/asset \d/);
    }
  });
});
