// @vitest-environment jsdom

/**
 * Can the card actually SIZE a trade, in each collateral?
 *
 * ── The bug this exists for ─────────────────────────────────────────────────
 * The toggle shipped and no ALGO amount could be entered: every value above
 * the $5 minimum produced "No size on this side currently clears the
 * exchange's checks."
 *
 * Cause: `quoteOpen` and `confirmCeiling` both need `algoPrice12` to value
 * non-USD collateral, and the card passed it to neither. Both throw
 * `UnpricedCollateralError`, both calls sit inside `try { } catch { return
 * null; }`, and a null quote plus a null ceiling render as that message. The
 * admin page passed the price and the card did not, so the path was proven on
 * MainNet and still broken in the product.
 *
 * ── Why nothing caught it ───────────────────────────────────────────────────
 * Every existing card test mocks `usePerpsMarket` to return `data: null`,
 * which short-circuits the quote before it can throw. There was no
 * `MarketState` fixture, so no test could drive the card far enough to
 * compute anything. `marketSnapshot.json` is captured from MainNet for
 * exactly this.
 */
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import snapshot from "@/lib/strategy/__fixtures__/marketSnapshot.json";

/** Revive the tagged bigints and byte arrays the capture wrote. */
function revive<T>(v: unknown): T {
  if (Array.isArray(v)) return v.map(revive) as unknown as T;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.__big === "string") return BigInt(o.__big) as unknown as T;
    if (typeof o.__bytes === "string") {
      return new Uint8Array(Buffer.from(o.__bytes, "base64")) as unknown as T;
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) out[k] = revive(val);
    return out as T;
  }
  return v as T;
}

const snap = revive<{ state: unknown; oracle: unknown }>(snapshot);

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({ isConnected: true, address: "MAGNETTEST", signTransactions: vi.fn() }),
}));
vi.mock("@/hooks/usePerpsPreflight", () => ({
  usePerpsPreflight: () => ({ canOpen: true, kind: "ok", reason: null, detail: null }),
}));
vi.mock("@/hooks/usePerpsMarket", () => ({
  usePerpsMarket: () => ({ data: snap, loading: false, error: null }),
  // Fresh enough that no staleness banner replaces the form.
  oracleAgeSeconds: () => 1,
}));

import { PerpsCard } from "./PerpsCard";

afterEach(cleanup);

const amountBox = () => document.getElementById("perps-amount") as HTMLInputElement;
const NO_SIZE = /no size on this side currently clears/i;

/** Type an amount and let the 120ms debounce settle. */
async function type(value: string) {
  fireEvent.change(amountBox(), { target: { value } });
  await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
}

describe("a USDC amount can be sized", () => {
  it("does not report that nothing clears", async () => {
    render(<PerpsCard />);
    await type("25");
    expect(screen.queryByText(NO_SIZE)).toBeNull();
  });
});

describe("an ALGO amount can be sized", () => {
  it("does not report that nothing clears", async () => {
    /**
     * THE regression. 300 ALGO is roughly $30 at the captured price — well
     * above the $5 minimum, and the exact shape of input that produced the
     * message for every value the user tried.
     */
    render(<PerpsCard />);
    fireEvent.click(screen.getByRole("button", { name: "ALGO" }));
    await type("300");
    expect(screen.queryByText(NO_SIZE)).toBeNull();
  });

  it("shows the dollar value of the ALGO entered", async () => {
    // Proves the collateral was actually VALUED rather than merely accepted:
    // the approximation line only renders when `collateralUsd > 0`, which
    // requires the price that was missing.
    render(<PerpsCard />);
    fireEvent.click(screen.getByRole("button", { name: "ALGO" }));
    await type("300");
    expect(screen.getByText(/^≈ \$/)).toBeTruthy();
  });
});
