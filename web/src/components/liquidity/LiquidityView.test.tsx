// @vitest-environment jsdom

/**
 * Only the C-Vault is public.
 *
 * The two direct market pools are admin-only for now — not because they are
 * unfinished, but because the C-Vault is the product going in front of users
 * first and a page offering three destinations invites a choice nobody has the
 * context to make.
 *
 * ── What this gate is, and is not ──
 * It is COSMETIC, deliberately. Everything on this page is a PEX call signed by
 * the user's own wallet; anyone can deposit to either pool through PEX
 * directly. `isAdmin` hides a card, it does not guard an authority — real
 * authority is in the contracts' own admin checks.
 *
 * These tests therefore assert what a VISITOR CAN SEE, which is the whole
 * claim being made. A test that only checked the boolean would pass while the
 * cards rendered anyway.
 */
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const ADMIN = "KNML6OW2XVXYSSGQX7EBLBMSLAPY6QFNBZUJMNEFIEXIIVJLMW4VINYU6A";
const VISITOR = "A4YW55ZEC2TTIN2TEVN56IRVGLWQYQRUNJTPG37OTWE4EJWNAH3EUKHZKA";

let wallet: { address: string | null; isConnected: boolean } =
  { address: null, isConnected: false };

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({
    algodClient: null,
    address: wallet.address,
    isConnected: wallet.isConnected,
    signTransactions: null,
  }),
}));
// The read layer needs a node; this page must render without one, showing its
// error state rather than throwing — which is also what a visitor sees offline.
vi.mock("@/lib/strategy/reads", () => ({
  readStrategyLiquidity: () => Promise.reject(new Error("no node in this test")),
  cvaShareOfMarket: () => null,
}));
vi.mock("@/lib/strategy/performance", () => ({
  fetchPerformanceBundle: () => Promise.reject(new Error("no bundle in this test")),
  benchmarkLabel: () => "vs holding",
  marketKey: (id: number) => `market-${id}`,
  cvaKey: (id: number) => `cva-${id}`,
}));

afterEach(cleanup);

async function mount(as: "visitor" | "admin" | "disconnected") {
  wallet = as === "disconnected"
    ? { address: null, isConnected: false }
    : { address: as === "admin" ? ADMIN : VISITOR, isConnected: true };
  const { LiquidityView } = await import("./LiquidityView");
  render(<LiquidityView />);
  await waitFor(() => expect(screen.getByText("C-Vault")).toBeTruthy());
}

describe("the public page shows the C-Vault only", () => {
  it("renders the C-Vault for a disconnected visitor", async () => {
    await mount("disconnected");
    expect(screen.getByText("C-Vault")).toBeTruthy();
  });

  it("does NOT render the direct pool cards for a visitor", async () => {
    await mount("visitor");
    // The card headings, not the words anywhere on the page — the disclaimer
    // and the totals legitimately mention the markets.
    expect(screen.queryByRole("heading", { name: "ALGO/USD" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "BTC/USD" })).toBeNull();
    // And no way to act on them.
    expect(screen.queryByText("Add or remove liquidity")).toBeNull();
  });

  it("offers a visitor no admin control at all", async () => {
    await mount("visitor");
    expect(screen.queryByRole("button", { name: /Direct pools/ })).toBeNull();
  });

  it("does not say 'direct' in the totals when those pools are hidden", async () => {
    // "direct" would name a product the visitor cannot see.
    await mount("visitor");
    const body = (document.body.textContent ?? "").replace(/\s+/g, " ");
    expect(body).not.toMatch(/\bdirect ·/);
  });
});

describe("the admin can open them", () => {
  it("shows the control but keeps the pools closed until pressed", async () => {
    await mount("admin");
    const btn = screen.getByRole("button", { name: /Direct pools/ });
    expect(btn).toBeTruthy();
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    // Closed by default: opening admin tools should be deliberate.
    expect(screen.queryByRole("heading", { name: "ALGO/USD" })).toBeNull();
  });

  it("reveals both pool cards when pressed, and hides them again", async () => {
    await mount("admin");
    const btn = screen.getByRole("button", { name: /Direct pools/ });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "ALGO/USD" })).toBeTruthy();
    });
    expect(screen.getByRole("heading", { name: "BTC/USD" })).toBeTruthy();
    expect(btn.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(btn);
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "ALGO/USD" })).toBeNull();
    });
  });
});
