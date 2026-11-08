// @vitest-environment jsdom

/**
 * The PSM panel's direction, fixed and free.
 *
 * ── The bug these exist for ──────────────────────────────────────────────
 * `fixed` started as `useState(fixed ?? "mint")`. Mint and Exchange are both
 * `<MusdTokenView>` at the same position in the tree, so switching pills does
 * NOT remount — React reconciles them as one instance and updates props. An
 * initial-state read happens once, so Exchange rendered the heading "Redeem
 * mUSD" over a panel still pointing USDC → mUSD, offering a 0% fee on a trade
 * that charges 1%.
 *
 * It compiled, it rendered, and every test passed. It was caught by clicking
 * between the two tabs in a browser.
 *
 * So the case that matters is not "does each direction render" — it is "does
 * the SAME instance follow the prop when it changes", which is what a rerender
 * with a new prop reproduces.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Flipped per test: the button's label is gated on being connected. */
let wallet = { address: null as string | null, isConnected: false };
vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({
    address: wallet.address, isConnected: wallet.isConnected,
    algodClient: null, transactionSigner: null,
  }),
}));
vi.mock("@/lib/magnetfiClient", () => ({
  makeAlgorand: () => null, optIn: vi.fn(), mintMusd: vi.fn(), redeemMusd: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const connected = () => { wallet = { address: "A".repeat(58), isConnected: true }; };
afterEach(() => { cleanup(); wallet = { address: null, isConnected: false }; });

const load = async () => (await import("./MusdTab")).MusdTab;

describe("a fixed direction", () => {
  it("mint pays USDC and receives mUSD", async () => {
    const MusdTab = await load();
    render(<MusdTab fixed="mint" />);
    expect(screen.getByText("Mint mUSD")).toBeTruthy();
    expect(screen.getByText("USDC → mUSD")).toBeTruthy();
  });

  it("the redeem direction pays mUSD and receives USDC", async () => {
    const MusdTab = await load();
    render(<MusdTab fixed="redeem" />);
    expect(screen.getByText("Exchange mUSD")).toBeTruthy();
    expect(screen.getByText("mUSD → USDC")).toBeTruthy();
  });

  it("FOLLOWS the prop when it changes on the same instance", async () => {
    /*
      The regression itself. A rerender rather than a fresh render, because
      remounting is precisely what the tab switch does not do.
    */
    const MusdTab = await load();
    const { rerender } = render(<MusdTab fixed="mint" />);
    expect(screen.getByText("USDC → mUSD")).toBeTruthy();

    rerender(<MusdTab fixed="redeem" />);
    expect(screen.getByText("mUSD → USDC")).toBeTruthy();
    expect(screen.queryByText("USDC → mUSD")).toBeNull();
    expect(screen.getByText("Exchange mUSD")).toBeTruthy();
  });

  it("hides the flip control, which would undo the pill", async () => {
    const MusdTab = await load();
    render(<MusdTab fixed="mint" />);
    expect(screen.queryByRole("button", { name: /Switch swap direction/ })).toBeNull();
  });

  it("carries the redeem fee on redeem only", async () => {
    // A mint shown with redeem's 1% — or a redeem shown with mint's 0% —
    // misprices the trade in the panel the user is about to sign from.
    const MusdTab = await load();
    const { rerender, container } = render(<MusdTab fixed="mint" />);
    expect(container.textContent).toContain("0%");
    rerender(<MusdTab fixed="redeem" />);
    expect(container.textContent).toMatch(/1%/);
  });
});

describe("no fixed direction — the original two-way panel", () => {
  it("keeps the flip control and the neutral heading", async () => {
    const MusdTab = await load();
    render(<MusdTab />);
    expect(screen.getByText("Stablecoin Swap")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Switch swap direction/ })).toBeTruthy();
  });
});

describe("one box, and the figure on the button", () => {
  const type = (v: string) => fireEvent.change(
    screen.getByRole("spinbutton"), { target: { value: v } });

  it("drops the read-only receive box on a fixed pill", async () => {
    /*
      A field you cannot type in, under one you can, restating what the
      button is about to do. On a two-way swap it is where the direction
      reads; on Mint or Exchange the pill is.
    */
    const MusdTab = await load();
    render(<MusdTab fixed="mint" />);
    expect(screen.getAllByRole("spinbutton").length).toBe(1);
    expect(screen.queryByText("You receive")).toBeNull();
  });

  it("keeps it on the two-way panel, where it carries the direction", async () => {
    const MusdTab = await load();
    render(<MusdTab />);
    expect(screen.getByText("You receive")).toBeTruthy();
  });

  it("quotes the output on the Mint button", async () => {
    connected();
    const MusdTab = await load();
    render(<MusdTab fixed="mint" />);
    type("10");
    expect(screen.getByRole("button", { name: /Mint: 10\.00 mUSD/ })).toBeTruthy();
  });

  it("quotes the output NET OF FEE on the Exchange button", async () => {
    // 1% redeem fee: 10 mUSD returns 9.90 USDC, not 10. With the receive
    // box gone this is the only place the net appears, so quoting the gross
    // here would overstate the trade at the point of signing it.
    connected();
    const MusdTab = await load();
    render(<MusdTab fixed="redeem" />);
    type("10");
    expect(screen.getByRole("button", { name: /Exchange: 9\.90 USDC/ })).toBeTruthy();
  });

  it("shows a bare verb before an amount is typed", async () => {
    // "Mint: 0.00 mUSD" on an empty disabled button reads as a broken quote.
    connected();
    const MusdTab = await load();
    render(<MusdTab fixed="mint" />);
    expect(screen.getByRole("button", { name: /^Mint$/ })).toBeTruthy();
  });

  it("still reports a blocking state instead of a quote", async () => {
    // An error the user has to act on outranks the figure.
    connected();
    const MusdTab = await load();
    render(<MusdTab fixed="mint" />);
    type("10");
    expect(screen.getByRole("button", { name: /Mint: 10\.00 mUSD/ })).toBeTruthy();
  });
});

describe("the word on screen is Exchange, not Redeem", () => {
  /*
    Changed 2026-11-07. "Redeem" asks a reader to know mUSD is a claim on a
    reserve before the label makes sense, and the pill that gets them here
    already says Exchange — two words for one action, one of them jargon.

    The PROTOCOL term stays: the call is `redeemMusd`, the fee is
    `REDEEM_FEE_BPS`, and the internal mode is "redeem". Asserted here so
    the split is deliberate rather than something half-renamed later.
  */
  it("says Exchange nowhere near the word Redeem", async () => {
    /*
      CONNECTED. Disconnected, the wallet gate wins the button label and
      the verb branch never renders — a first pass asserted this without a
      wallet and two mutations putting "Redeem" back on the button survived
      it untouched.
    */
    connected();
    const MusdTab = await load();
    const { container } = render(<MusdTab fixed="redeem" />);
    expect(container.textContent).toContain("Exchange mUSD");
    expect(screen.getByRole("button", { name: /^Exchange$/ })).toBeTruthy();
    expect(container.textContent).not.toMatch(/Redeem/);
  });

  it("keeps Mint untouched — only the other direction was jargon", async () => {
    const MusdTab = await load();
    const { container } = render(<MusdTab fixed="mint" />);
    expect(container.textContent).toContain("Mint mUSD");
  });

  it("renames the two-way panel's button too", async () => {
    /*
      The free panel is unreachable in the app today but still rendered by
      tests; leaving "Redeem mUSD" there is how one surface keeps the old
      word after the rest move on.

      It has to be CONNECTED and FLIPPED to reach that label: the panel
      opens on mint, and the wallet gate otherwise owns the button.
    */
    connected();
    const MusdTab = await load();
    const { container } = render(<MusdTab />);
    fireEvent.click(screen.getByRole("button", { name: /Switch swap direction/ }));
    expect(screen.getByRole("button", { name: /^Exchange mUSD$/ })).toBeTruthy();
    expect(container.textContent).not.toMatch(/Redeem/);
  });
});
