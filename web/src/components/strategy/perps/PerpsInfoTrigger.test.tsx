// @vitest-environment jsdom

/**
 * Where the "More info" trigger lives, and that it still opens the modal.
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 * The button spent months alone in a full-width row above the card, with
 * 58px of empty page between the two — an orphan left behind when the page
 * header was removed. On 2026-11-08 it moved into the chart panel's control
 * row, beside the market pills, the chart toggle and the timeframes.
 *
 * Putting it back is a one-line edit that compiles and breaks nothing else:
 * render a button in `PerpsView` again and the terminal still works. So the
 * thing asserted here is containment — the trigger is INSIDE the card — plus
 * the two properties the move was supposed to preserve, that it still opens
 * the dialog and that it does not become an orphan again at phone width.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/* The terminal's heavy children are not what this file is about: a candle
   chart, an order form that quotes against a live oracle, and a positions
   list that reads the chain. The chart PANEL is left real — it is the thing
   that now holds the button. */
vi.mock("@/components/strategy/perps/PerpsChart", () => ({ PerpsChart: () => <div data-testid="chart" /> }));
vi.mock("@/components/strategy/perps/PerpsCard", () => ({ PerpsCard: () => <div data-testid="order-card" /> }));
vi.mock("@/components/strategy/perps/PositionsPanel", () => ({ PositionsPanel: () => <div data-testid="positions" /> }));
vi.mock("@/lib/strategy/perps/chart", async (orig) => ({
  ...(await orig<typeof import("@/lib/strategy/perps/chart")>()),
  fetchDayStats: () => Promise.reject(new Error("no network in this test")),
}));
vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({ address: null, isConnected: false, algodClient: null }),
}));

afterEach(cleanup);

/**
 * Render, and WAIT for the chart panel.
 *
 * `PerpsChartPanel` comes in through `next/dynamic`, so it is not in the DOM
 * on the first paint — a synchronous version of this file found zero buttons
 * and one of its assertions ("nothing renders above the card") passed for the
 * worst possible reason: there was nothing in the tree at all.
 */
const mount = async () => {
  const { PerpsView } = await import("./PerpsView");
  const r = render(<PerpsView />);
  await waitFor(() => expect(screen.getByRole("button", { name: /More info/i })).toBeTruthy());
  return r;
};

/** The glowing card. Everything the terminal shows lives inside it. */
const card = (c: HTMLElement) => c.querySelector("[class*='ring-magnet-400']") as HTMLElement;
const trigger = () => screen.getByRole("button", { name: /More info/i });

describe("the info trigger belongs to the card", () => {
  it("renders inside it, not in a row above it", async () => {
    const { container } = await mount();
    expect(card(container), "the card lost its glow").toBeTruthy();
    expect(card(container).contains(trigger()), "the trigger is outside the card").toBe(true);
  });

  it("leaves no stray row between the page top and the card", async () => {
    /*
      The float was the card's only preceding sibling. Anything rendered
      before the card now is the orphan row coming back — which is the whole
      defect, and it would pass every other test in the suite.
    */
    const { container } = await mount();
    // Proven non-empty by `mount`, which waits for the trigger: an empty tree
    // would satisfy "nothing renders above the card" trivially.
    expect(card(container)).toBeTruthy();
    let node: Element | null = card(container);
    while (node && node.parentElement !== container) node = node.parentElement;
    expect(node, "could not locate the card's top-level wrapper").toBeTruthy();
    const before = [...container.children].slice(0, [...container.children].indexOf(node!));
    const withText = before.filter((el) => (el.textContent ?? "").trim().length > 0);
    expect(withText.map((el) => el.textContent?.trim()), "something renders above the card").toEqual([]);
  });

  it("sits in the control row, with the market and chart toggles", async () => {
    // Not merely "somewhere in the card" — the point of the move is that it
    // joins the row the card already had, rather than getting a row of its own.
    const { container } = await mount();
    const row = trigger().closest("div.flex-wrap") as HTMLElement;
    expect(row, "the trigger is not in a wrapping control row").toBeTruthy();
    expect(within(row).getByRole("button", { name: "ALGO/USD" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Basic Chart" })).toBeTruthy();
  });

  it("travels with the timeframes when the row wraps", async () => {
    /*
      The row is `flex-wrap`. As a loose child the button dropped onto a line
      of its own at phone width — the orphan reappearing exactly where it is
      least affordable. Sharing a non-wrapping parent with the interval
      buttons is what prevents that, so the shared parent is the assertion.
    */
    await mount();
    const group = trigger().parentElement!;
    expect(group.className).not.toContain("flex-wrap");
    expect(within(group).getByRole("button", { name: "1D" })).toBeTruthy();
  });
});

describe("it still does its job", () => {
  it("opens the dialog", async () => {
    // The modal stays in PerpsView and the panel only gets a callback, so a
    // move like this can silently leave the button wired to nothing.
    await mount();
    expect(trigger().getAttribute("aria-haspopup")).toBe("dialog");
    fireEvent.click(trigger());
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  });

  it("stays amber, because it is the only route to the risk copy", async () => {
    // A help-link grey would read as optional. This is where "you can lose
    // everything you put in" lives.
    await mount();
    expect(trigger().className).toMatch(/amber/);
  });
});
