/**
 * @vitest-environment jsdom
 *
 * Both hooks must look for BOTH collaterals.
 *
 * ── Why this is a test and not a comment ────────────────────────────────────
 * The narrowing is invisible from the UI. A wallet holding only USDC positions
 * — which is every wallet that has used our terminal — behaves identically
 * either way, so re-narrowing the read to `COLLATERAL_ASSET_ID` breaks nothing
 * a developer would notice, and the people it breaks it for are the ones
 * holding an ALGO-collateral position opened on PEX's own front end.
 *
 * It asserts the actual arguments the hooks pass to `readPosition`, so it
 * cannot be satisfied by a comment that mentions ALGO.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const readPosition = vi.fn();
const readOrders = vi.fn();
const getOraclePayload = vi.fn();

vi.mock("@/lib/strategy/pex/reads", () => ({
  readPosition: (...a: unknown[]) => readPosition(...a),
  readOrders: (...a: unknown[]) => readOrders(...a),
  readMarketState: vi.fn(),
  readMarketFunding: vi.fn(),
}));
vi.mock("@/lib/strategy/pex/oracle", () => ({
  getOraclePayload: (...a: unknown[]) => getOraclePayload(...a),
}));

import { usePerpsPositions } from "@/hooks/usePerpsPositions";
import { usePerpsOrders } from "@/hooks/usePerpsOrders";
import {
  ENABLED_MARKET_IDS, PEX_ASSETS, POSITION_COLLATERAL_ASSETS,
} from "@/lib/strategy/pex/config";

const OWNER = "MAGNETTESTADDRESSMAGNETTESTADDRESSMAGNETTESTADDRESSMAG";

/** The (market, collateral, side) triples asked for, as comparable strings. */
const requested = () =>
  new Set(readPosition.mock.calls.map((c) => `${c[2]}:${c[3]}:${c[4]}`));

const expected = () => {
  const out = new Set<string>();
  for (const m of ENABLED_MARKET_IDS) {
    for (const c of POSITION_COLLATERAL_ASSETS) {
      for (const s of [1, 2]) out.add(`${m}:${c}:${s}`);
    }
  }
  return out;
};

beforeEach(() => {
  readPosition.mockReset();
  // No position anywhere: the hooks then never reach market state or the
  // oracle, so the key enumeration is all this exercises.
  readPosition.mockResolvedValue(null);
  readOrders.mockReset();
  readOrders.mockResolvedValue([]);
  getOraclePayload.mockReset();
  getOraclePayload.mockRejectedValue(new Error("not needed"));
});
afterEach(() => vi.useRealTimers());

describe("usePerpsPositions reads every collateral a position can be keyed by", () => {
  it("asks for both collaterals on both sides of every enabled market", async () => {
    const { result } = renderHook(() => usePerpsPositions(OWNER));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(requested()).toEqual(expected());
  });

  it("includes ALGO specifically, not merely two of something", async () => {
    // Guards against a POSITION_COLLATERAL_ASSETS that drifts to e.g. [usdc,
    // usdc] or [usdc, xAlgo] while the set-equality test above still passes,
    // since that test derives its expectation from the same constant.
    renderHook(() => usePerpsPositions(OWNER));
    await waitFor(() =>
      expect(readPosition.mock.calls.some((c) => c[3] === PEX_ASSETS.algo)).toBe(true));
    expect(readPosition.mock.calls.some((c) => c[3] === PEX_ASSETS.usdc)).toBe(true);
  });
});

describe("usePerpsOrders resolves orders against every collateral", () => {
  it("asks for both collaterals on both sides of every enabled market", async () => {
    /**
     * Not cosmetic here. `analyzeV2OrderLifecycle` resolves an order's key
     * against the position set it is handed, so an ALGO-collateral order read
     * against a USDC-only set resolves to NOTHING — reported as "Orphaned —
     * funds still locked" on an order whose position is open and healthy.
     */
    const { result } = renderHook(() => usePerpsOrders(OWNER));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(requested()).toEqual(expected());
  });
});

describe("no owner means no reads", () => {
  it("does not enumerate keys for a disconnected wallet", async () => {
    const { result } = renderHook(() => usePerpsPositions(null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(readPosition).not.toHaveBeenCalled();
  });
});
