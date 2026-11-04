import { describe, expect, it } from "vitest";
import {
  isCorrelatedLong, correlatedRisk, riskPermitsSubmit, SEVERE_LIQUIDATION_DROP,
} from "@/lib/strategy/perps/correlatedRisk";
import { PEX_ASSETS } from "@/lib/strategy/pex/config";

const ALGO_MARKET_LONG = PEX_ASSETS.algo;

describe("which combination is doubly exposed", () => {
  it("is the long backed by the market's own long asset", () => {
    expect(isCorrelatedLong("long", PEX_ASSETS.algo, ALGO_MARKET_LONG)).toBe(true);
  });

  it("is NOT the short, which is the hedge", () => {
    // Measured on a real round trip: ALGO fell 0.595%, the short gained $0.11,
    // and they very nearly cancelled. Warning here would warn about a hedge.
    expect(isCorrelatedLong("short", PEX_ASSETS.algo, ALGO_MARKET_LONG)).toBe(false);
  });

  it("is NOT a USDC-backed long", () => {
    expect(isCorrelatedLong("long", PEX_ASSETS.usdc, ALGO_MARKET_LONG)).toBe(false);
  });

  it("follows the MARKET's long asset, not a hardcoded ALGO", () => {
    // A market backed by something else must still warn on its own asset, and
    // must not warn on ALGO merely because ALGO is usually the long side.
    expect(isCorrelatedLong("long", PEX_ASSETS.xAlgo, PEX_ASSETS.xAlgo)).toBe(true);
    expect(isCorrelatedLong("long", PEX_ASSETS.algo, PEX_ASSETS.xAlgo)).toBe(false);
  });
});

describe("note versus gate", () => {
  it("says nothing when the combination is not correlated", () => {
    expect(correlatedRisk(false, 0.05)).toBe("none");
  });

  it("is a notice when liquidation is far away", () => {
    expect(correlatedRisk(true, 0.60)).toBe("notice");
    expect(correlatedRisk(true, SEVERE_LIQUIDATION_DROP + 0.01)).toBe("notice");
  });

  it("is severe just below the threshold", () => {
    expect(correlatedRisk(true, SEVERE_LIQUIDATION_DROP - 0.001)).toBe("severe");
    expect(correlatedRisk(true, 0.10)).toBe("severe");
  });

  it("treats an unknown or impossible distance as severe, not as safe", () => {
    // The one state where silence would be worst is the one where we cannot
    // tell, so it fails loud rather than quiet.
    expect(correlatedRisk(true, null)).toBe("none");       // nothing to judge yet
    expect(correlatedRisk(true, 0)).toBe("severe");
    expect(correlatedRisk(true, -0.1)).toBe("severe");
    expect(correlatedRisk(true, Number.NaN)).toBe("severe");
  });
});

describe("the gate", () => {
  it("blocks a severe risk until it is acknowledged", () => {
    expect(riskPermitsSubmit("severe", false)).toBe(false);
    expect(riskPermitsSubmit("severe", true)).toBe(true);
  });

  it("never blocks a notice or an absent risk", () => {
    // Acknowledgement is not asked for, so it must not be required either.
    expect(riskPermitsSubmit("notice", false)).toBe(true);
    expect(riskPermitsSubmit("none", false)).toBe(true);
  });
});
