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

describe("the PSM reserve, shown before you hit it", () => {
  /*
    `lowReserve` already refused an oversized exchange — but only on the
    button, after an amount was typed. The reserve is the ceiling on a
    redemption, the number was already fetched for that guard, and
    `Current Available` lives on the Finance page, so there was no way to
    size a trade from the mUSD page at all.
  */
  it("appears on the exchange side", async () => {
    const MusdTab = await load();
    render(<MusdTab fixed="redeem" />);
    expect(screen.getByText("PSM reserve")).toBeTruthy();
  });

  it("does NOT appear on mint, which this reserve does not cap", async () => {
    // Minting is bounded by `max_balance`, not by the USDC reserve. Showing
    // it there would answer a question nobody on that tab is asking.
    const MusdTab = await load();
    render(<MusdTab fixed="mint" />);
    expect(screen.queryByText("PSM reserve")).toBeNull();
  });
});

describe("the peg and strapline, now inside the card", () => {
  /*
    They were in the page header until 2026-11-07. The peg is what the
    trade is priced against, so it reads better beside the form than as a
    stat detached from it, and moving it closed the gap the header left
    when the logo and strapline came out.
  */
  it("shows the peg when one is given", async () => {
    const MusdTab = await load();
    render(<MusdTab fixed="redeem" peg={1.0001} />);
    expect(screen.getByText("$1.0001")).toBeTruthy();
    expect(screen.getByText(/mUSD peg/i)).toBeTruthy();
    // Shortened to "via Vestige" when the box became a 104px square —
    // the attribution survives, the sentence does not fit.
    expect(screen.getByText(/via Vestige/)).toBeTruthy();
  });

  it("shows a dash, never a zero, for an unread peg", async () => {
    // "$0.0000" on a stablecoin reads as a depeg rather than a failed read.
    const MusdTab = await load();
    render(<MusdTab fixed="redeem" peg={null} />);
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.queryByText("$0.0000")).toBeNull();
  });

  it("omits the box entirely when no peg is passed", async () => {
    // The Mint tab does not pass one; an empty peg box there would be a
    // figure the panel never had.
    const MusdTab = await load();
    render(<MusdTab fixed="mint" />);
    expect(screen.queryByText(/mUSD peg/i)).toBeNull();
  });

  it("renders the strapline under the heading", async () => {
    const MusdTab = await load();
    render(<MusdTab fixed="redeem" subtitle="Back to USDC through the PSM." />);
    expect(screen.getByText("Back to USDC through the PSM.")).toBeTruthy();
  });
});

describe("the direction pill yields its slot to the peg", () => {
  /*
    They do not both fit beside the heading. On the Exchange panel the
    direction is already stated twice — "Exchange mUSD" and a strapline
    reading "back to USDC" — so the pill is the thing that goes. On Mint
    and on the two-way panel it is the only direction marker there is.
  */
  it("drops the pill when a peg box is shown", async () => {
    const MusdTab = await load();
    render(<MusdTab fixed="redeem" peg={1.0001} />);
    expect(screen.queryByText("mUSD → USDC")).toBeNull();
    expect(screen.getByText(/mUSD peg/i)).toBeTruthy();
  });

  it("keeps the pill on Mint, which has no other direction marker", async () => {
    const MusdTab = await load();
    render(<MusdTab fixed="mint" />);
    expect(screen.getByText("USDC → mUSD")).toBeTruthy();
  });

  it("keeps the pill on the two-way panel", async () => {
    const MusdTab = await load();
    render(<MusdTab />);
    expect(screen.getByText("USDC → mUSD")).toBeTruthy();
  });
});

describe("the heading tag, after the Exchange page header came out", () => {
  /*
    The Exchange tab's page header said "Exchange mUSD" and so did this
    panel, eight lines apart. The header went on 2026-11-08, which left
    that page with no level-one heading — so this panel's heading became
    it. Everywhere else the panel sits under a page that has its own, and
    a second `<h1>` there would be the defect rather than the fix.
  */
  it("renders a <p> by default, so Mint and Finance keep one <h1> each", async () => {
    const MusdTab = await load();
    const { container } = render(<MusdTab fixed="mint" />);
    expect(container.querySelector("h1")).toBeNull();
    expect(screen.getByText("Mint mUSD").tagName).toBe("P");
  });

  it("renders the heading as the <h1> when asked", async () => {
    const MusdTab = await load();
    const { container } = render(<MusdTab fixed="redeem" headingAs="h1" peg={1.0001} />);
    const h1 = container.querySelectorAll("h1");
    expect(h1.length).toBe(1);
    expect(h1[0].textContent).toBe("Exchange mUSD");
  });

  it("changes the tag and nothing else — same size, same strapline, same peg", async () => {
    /*
      The point of promoting the real heading instead of adding an
      `sr-only` copy was that nothing on screen moves. If the tag starts
      carrying type scale with it, a browser default (h1 = 2em bold) is
      what renders, and this panel's title would jump.
    */
    const MusdTab = await load();
    const plain = render(<MusdTab fixed="redeem" peg={1.0001} subtitle="A line." />).container.innerHTML;
    cleanup();
    const promoted = render(
      <MusdTab fixed="redeem" headingAs="h1" peg={1.0001} subtitle="A line." />,
    ).container.innerHTML;
    expect(promoted.replace(/<h1 /g, "<p ").replace(/<\/h1>/g, "</p>")).toBe(plain);
  });
});
