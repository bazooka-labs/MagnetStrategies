// @vitest-environment jsdom

/**
 * The swap panel's default route, and the asset switch.
 *
 * ── Why the default is worth a test ───────────────────────────────────────
 * It is a product decision, not a style one. The protocol's claim is that $U
 * beats holding vanilla ALGO, so ALGO -> $U is the route that acts on the
 * claim; USDC -> $U was the only option until 2026-11-07 and asked a visitor
 * to arrive already holding a stablecoin.
 *
 * A default is also the easiest thing in a file to flip back by accident —
 * it is one word, it compiles either way, and nothing else fails. So the
 * route the panel actually QUOTES is asserted, not merely the label it
 * renders: `fromASAID: 0` is ALGO to Haystack's router, and a test that only
 * read the heading would pass while the panel quoted USDC behind it.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const quotes: { fromASAID: number; toASAID: number; amount: number }[] = [];
const newQuote = vi.fn(async (args: { fromASAID: number; toASAID: number; amount: number }) => {
  quotes.push(args);
  // A plain number, not a BigInt literal: tsconfig targets below ES2020 and
  // `678_886n` fails tsc while vitest runs it happily. The component reads
  // this through `Number(q.quote)`, so either form exercises the same path.
  return { quote: 678_886, userPriceImpact: -0.146 };
});

vi.mock("@txnlab/haystack-router", () => ({
  RouterClient: class { newQuote = newQuote; newSwap = vi.fn(); },
}));
vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({
    isConnected: false, activeAddress: null, transactionSigner: null, wallets: [],
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const U = 3081853135;
const ALGO = 0;
const USDC = 31566704;

beforeEach(() => { quotes.length = 0; newQuote.mockClear(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); cleanup(); });

const mount = async () => {
  const { HaystackSwap } = await import("./HaystackSwap");
  return render(<HaystackSwap />);
};

/**
 * Types an amount and lets the 500ms quote debounce fire.
 *
 * `act` + `advanceTimersByTimeAsync`, not `waitFor`: waitFor polls on REAL
 * timers, so under fake ones it never re-checks and every assertion after it
 * timed out at 5s. Advancing the fake clock inside act runs the debounce and
 * flushes the state update it produces, which is what waitFor was there for.
 */
const type = async (value: string) => {
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value } });
  await act(async () => { await vi.advanceTimersByTimeAsync(600); });
};

describe("the default route", () => {
  it("lands on ALGO, not USDC", async () => {
    await mount();
    expect(screen.getByRole("tab", { name: "ALGO" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "USDC" }).getAttribute("aria-selected")).toBe("false");
  });

  it("QUOTES ALGO -> $U, which is the part a label cannot prove", async () => {
    // `fromASAID: 0` is ALGO. A panel showing "ALGO" while quoting USDC
    // would pass every assertion above and be wrong in the only way that
    // costs the user money.
    await mount();
    await type("10");
    expect(quotes[0]).toMatchObject({ fromASAID: ALGO, toASAID: U, amount: 10_000_000 });
  });

  it("still offers USDC, and quotes it when chosen", async () => {
    // Keeping the stablecoin route was explicit: plenty of people arrive
    // holding USDC. It is a second option, not a removed one.
    await mount();
    fireEvent.click(screen.getByRole("tab", { name: "USDC" }));
    await type("10");
    expect(quotes[quotes.length - 1]).toMatchObject({ fromASAID: USDC, amount: 10_000_000 });
  });
});

describe("switching the asset", () => {
  it("clears the amount rather than carrying it across", async () => {
    // "10" means something different in each asset; re-quoting it on the
    // other side prices a trade the user never asked for.
    await mount();
    await type("10");
    expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("10");

    fireEvent.click(screen.getByRole("tab", { name: "USDC" }));
    expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("");
  });

  it("drops the stale preview with it", async () => {
    // The output figure belongs to the OLD asset's quote. Left on screen it
    // reads as the new asset's rate.
    await mount();
    await type("10");
    expect(screen.getByText("6.78886")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "USDC" }));
    expect(screen.queryByText("6.78886")).toBeNull();
  });

  it("does not re-quote when the selected asset is pressed again", async () => {
    await mount();
    await type("10");
    const before = quotes.length;
    fireEvent.click(screen.getByRole("tab", { name: "ALGO" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(quotes.length).toBe(before);
    // ...and the amount survives, because nothing changed.
    expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("10");
  });

  it("re-quotes on the new asset once an amount is typed", async () => {
    await mount();
    fireEvent.click(screen.getByRole("tab", { name: "USDC" }));
    await type("25");
    expect(quotes[quotes.length - 1].fromASAID).toBe(USDC);
    expect(quotes[quotes.length - 1].amount).toBe(25_000_000);
  });
});

describe("the output side is always \$U", () => {
  it("never quotes anything but \$U out", async () => {
    await mount();
    await type("1");
    fireEvent.click(screen.getByRole("tab", { name: "USDC" }));
    await type("1");
    expect(quotes.length).toBeGreaterThan(1);
    for (const q of quotes) expect(q.toASAID).toBe(U);
  });
});
