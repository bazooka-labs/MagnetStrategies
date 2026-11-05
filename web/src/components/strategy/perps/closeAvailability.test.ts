/**
 * Which positions the terminal offers to close.
 *
 * This guard exists because the opposite went unnoticed for two days. An ALGO
 * close was disabled on 2026-11-03 at 20:48, correctly at the time — the group
 * assertion refused it. The assertion was widened 90 minutes later in 35b988d,
 * and nobody came back for the button. A working exit stayed greyed out behind
 * a message telling the holder to close on PEX instead, which geoblocks them,
 * while ~197 ALGO sat in an open position.
 *
 * Nothing caught it because nothing tested it. The real fix for that class of
 * bug is not "remember to check" — it is this file.
 */

import { describe, expect, it } from "vitest";
import { POSITION_COLLATERAL_ASSETS, PEX_ASSETS } from "@/lib/strategy/pex/config";
import { closeUnavailable } from "./PositionsPanel";

describe("closing is offered for every collateral the terminal reads", () => {
  it("offers it for ALGO — the case that was wrongly disabled", () => {
    // Proven against MainNet by `algoclose.live.test.ts`, which builds,
    // asserts and simulates the real group on real bytes.
    expect(closeUnavailable(PEX_ASSETS.algo)).toBeNull();
  });

  it("offers it for USDC", () => {
    expect(closeUnavailable(PEX_ASSETS.usdc)).toBeNull();
  });

  it("offers it for EVERY asset the positions hook reads", () => {
    /**
     * The coupling that matters, stated directly.
     *
     * `usePerpsPositions` enumerates POSITION_COLLATERAL_ASSETS, so any asset
     * in that list can appear as a card. A card the panel will not close is a
     * holder with no exit — so the two lists have to move together, and this
     * fails the moment a collateral is added to the read path without a close
     * path to match.
     */
    for (const asset of POSITION_COLLATERAL_ASSETS) {
      expect(closeUnavailable(asset), `collateral ${asset}`).toBeNull();
    }
  });

  it("still refuses a collateral the terminal does not know", () => {
    // The gate keeps its original job: an unknown asset must not get an
    // enabled button that ends in a cryptic assertion failure.
    const unknown = 999_999_999;
    expect(POSITION_COLLATERAL_ASSETS).not.toContain(unknown);
    expect(closeUnavailable(unknown)).toMatch(/not supported/i);
  });

  it("no longer tells anyone to go and use PEX", () => {
    // PEX geoblocks US users, so that advice sent people to a door they
    // cannot open — about the one action that releases their funds.
    const msg = closeUnavailable(999_999_999) ?? "";
    expect(msg).not.toMatch(/PEX/i);
  });
});
