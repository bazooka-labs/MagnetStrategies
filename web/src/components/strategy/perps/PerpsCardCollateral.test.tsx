// @vitest-environment jsdom

/**
 * The collateral toggle on the trading card.
 *
 * `PerpsCard` is ~2000 lines on the money path and the OVERVIEW has carried
 * "no behavioural test" as an open item for a while. This does not close that,
 * but the toggle is new and it changes what a typed number MEANS, which is
 * the kind of thing that must not regress silently.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({ isConnected: true, address: "MAGNETTEST", signTransactions: vi.fn() }),
}));
vi.mock("@/hooks/usePerpsPreflight", () => ({
  usePerpsPreflight: () => ({ canOpen: true, kind: "ok", reason: null, detail: null }),
}));
vi.mock("@/hooks/usePerpsMarket", () => ({
  usePerpsMarket: () => ({ data: null, loading: false, error: null }),
  oracleAgeSeconds: () => 1,
}));

import { PerpsCard } from "./PerpsCard";

afterEach(cleanup);

const amountBox = () => document.getElementById("perps-amount") as HTMLInputElement;

describe("the collateral toggle", () => {
  it("offers both assets and starts on USDC", () => {
    render(<PerpsCard />);
    expect(screen.getByRole("button", { name: "USDC" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "ALGO" })).toBeTruthy();
    // The dollar prefix is the tell that the field means dollars.
    expect(screen.getByText("$")).toBeTruthy();
  });

  it("changes what the amount MEANS when ALGO is picked", () => {
    render(<PerpsCard />);
    fireEvent.click(screen.getByRole("button", { name: "ALGO" }));
    // No dollar prefix: the number is now ALGO, which is what leaves the
    // wallet. A "$" beside an ALGO figure is the whole conflation this
    // change exists to avoid.
    expect(screen.queryByText("$")).toBeNull();
  });

  it("clears a typed amount when the unit changes under it", () => {
    /**
     * "50" means fifty dollars under USDC and fifty ALGO under ALGO — about
     * $5 apart at today's price. Carrying the digits across would silently
     * restate the trade by a factor of ten.
     */
    render(<PerpsCard />);
    fireEvent.change(amountBox(), { target: { value: "50" } });
    expect(amountBox().value).toBe("50");
    fireEvent.click(screen.getByRole("button", { name: "ALGO" }));
    expect(amountBox().value).toBe("");
  });

  it("does not clear when the same asset is clicked again", () => {
    render(<PerpsCard />);
    fireEvent.change(amountBox(), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "USDC" }));
    expect(amountBox().value).toBe("50");
  });
});
