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

  it("follows the MARKET's index asset, not a hardcoded ALGO", () => {
    // A market tracking something else must warn on its own asset, and must
    // not warn on ALGO merely because ALGO is usually the collateral.
    expect(isCorrelatedLong("long", PEX_ASSETS.xAlgo, PEX_ASSETS.xAlgo)).toBe(true);
    expect(isCorrelatedLong("long", PEX_ASSETS.algo, PEX_ASSETS.xAlgo)).toBe(false);
  });

  it("does NOT flag a BTC long backed by ALGO", () => {
    /**
     * The case that caught a real error. Market 2 is BTC/USD but is BACKED
     * with ALGO and USDC, so its `long_asset_id` is ALGO. Keying off the long
     * asset flagged a BTC long posted with ALGO collateral as doubly exposed
     * — blocking it behind the acknowledgement and telling the user their
     * collateral falls with the price, which is false. BTC and ALGO are
     * different assets.
     *
     * The index asset is what the position tracks, and on market 2 it is the
     * synthetic BTC id, so this is correctly not correlated.
     */
    const BTC_INDEX = PEX_ASSETS.btcIndex;
    expect(isCorrelatedLong("long", PEX_ASSETS.algo, BTC_INDEX)).toBe(false);
    // ...while the ALGO market, where index and long coincide, still warns.
    expect(isCorrelatedLong("long", PEX_ASSETS.algo, PEX_ASSETS.algo)).toBe(true);
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

  it("treats an unmeasurable distance as severe, not as safe", () => {
    /**
     * This used to accept `null` as "none", and that made the gate FAIL OPEN
     * in production: when the USDC counterfactual quote failed, a correlated
     * long went through with no warning and no checkbox. Review found it.
     *
     * The caller only reports `correlated` once it has a real quote for the
     * trade, so a null distance here means the COMPARISON failed — which is
     * not a reason to go quiet.
     */
    expect(correlatedRisk(true, null)).toBe("severe");
    expect(correlatedRisk(true, 0)).toBe("severe");
    expect(correlatedRisk(true, -0.1)).toBe("severe");
    expect(correlatedRisk(true, Number.NaN)).toBe("severe");
  });

  it("still says nothing when the combination is not correlated at all", () => {
    expect(correlatedRisk(false, null)).toBe("none");
    expect(correlatedRisk(false, 0.01)).toBe("none");
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
