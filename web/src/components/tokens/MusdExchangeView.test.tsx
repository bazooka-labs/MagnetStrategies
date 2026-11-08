// @vitest-environment jsdom

/**
 * The Exchange pill, and what it deliberately does NOT carry.
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 * The whole view was written and the suite stayed green, because every mUSD
 * assertion pointed at `MusdTokenView` — which is now only the Mint tab. A
 * new component that nothing renders in a test is a component nothing
 * checks.
 *
 * The valuable assertions here are ABSENCES. Mint and Exchange rendered the
 * same thing with one prop different until 2026-11-07, and the cheapest way
 * to undo this change is to point `exchangeView` back at `MusdTokenView` in
 * `app/tokens/page.tsx` — one line, compiles, and every other test passes.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MusdExchangeView } from "./MusdExchangeView";

vi.mock("@/components/VestigeChart", () => ({
  VestigeChart: () => <div data-testid="chart" />,
}));
/** Records the props, because the peg and the strapline are now ITS job. */
const swapProps: { fixed?: string; subtitle?: string; peg?: number | null }[] = [];
vi.mock("@/components/magnetfi/v2/MusdTab", () => ({
  MusdTab: (props: { fixed?: string; subtitle?: string; peg?: number | null }) => {
    swapProps.push(props);
    return <div data-testid={`swap-${props.fixed}`} />;
  },
}));

afterEach(() => { cleanup(); swapProps.length = 0; });

const mount = (price: number | null = 1.0001) =>
  render(<MusdExchangeView marketPrice={price} />);

describe("what the Exchange tab carries", () => {
  it("is the chart and the swap, in one glowing card", async () => {
    /*
      The swap is AWAITED. `MusdTab` comes in through `next/dynamic`, so it
      is not in the DOM on the first paint — a synchronous assertion found
      null, and the direction test below passed for the worst possible
      reason: NEITHER testid existed, so "mint is absent" was trivially
      true. The chart is a plain import and is there immediately.
    */
    const { container } = mount();
    const card = container.querySelector("[class*='ring-magnet-400']")!;
    expect(card, "the card lost its glow").toBeTruthy();
    expect(card.querySelector("[data-testid='chart']")).toBeTruthy();
    await waitFor(() => expect(card.querySelector("[data-testid='swap-redeem']")).toBeTruthy());
  });

  it("fixes the swap to the redeem direction", async () => {
    // The pill IS the direction here; a two-way panel would undo it. Wait
    // for the dynamic panel first, or this asserts against an empty slot.
    const { container } = mount();
    await waitFor(() => expect(container.querySelector("[data-testid='swap-redeem']")).toBeTruthy());
    expect(container.querySelector("[data-testid='swap-mint']")).toBeNull();
    expect(container.querySelector("[data-testid='swap-undefined']")).toBeNull();
  });

  it("hands the peg and the strapline to the swap panel", async () => {
    /*
      Both moved INTO the card on 2026-11-07 — the peg box came down out of
      the header and the strapline came with it. So the view's job is to
      pass them and the panel's is to render them; the rendering is
      asserted in MusdTab.test.tsx against the real component.
    */
    mount(1.0001);
    await waitFor(() => expect(swapProps.length).toBeGreaterThan(0));
    expect(swapProps[0].peg).toBe(1.0001);
    expect(swapProps[0].subtitle).toMatch(/Peg Stability Module/);
  });

  it("passes a null peg through rather than swallowing it", async () => {
    // `undefined` would hide the box entirely; `null` renders a dash. An
    // unread price must still show that there IS a peg figure.
    mount(null);
    await waitFor(() => expect(swapProps.length).toBeGreaterThan(0));
    expect(swapProps[0].peg).toBeNull();
  });

  it("still says which asset it is", () => {
    // Dropping the heading entirely made switching tabs feel like losing
    // the page.
    expect(mount().container.textContent).toContain("Exchange mUSD");
  });

  it("has no logo and no strapline in the header any more", () => {
    // Both came out on request; the strapline moved into the card.
    const { container } = mount();
    expect(container.querySelector("img")).toBeNull();
    const header = container.querySelector("h1")!.parentElement!;
    expect(header.textContent!.trim()).toBe("Exchange mUSD");
  });
});

describe("what it deliberately drops", () => {
  /*
    Each of these is on the Mint tab, which is the mUSD landing page: what
    the stablecoin is, what backs it, how it is doing. Carrying them here
    too is what made switching pills change a badge and nothing else.
  */
  it("has no About panel", () => {
    const { container } = mount();
    expect(container.textContent).not.toContain("What is mUSD?");
    expect(container.querySelector("[class*='border-amber-400/25']")).toBeNull();
  });

  it("has no five-box metric row", () => {
    const { container } = mount();
    for (const label of ["Holders", "Circulating Supply", "Backing Ratio", "Treasury"]) {
      expect(container.textContent, label).not.toContain(label);
    }
    /* Not a bare grid-cols-5 check: the chart-and-swap split IS five
       columns (3 + 2) and matched it. The metric row is the one with
       horizontal dividers BETWEEN STACKED CELLS — `divide-y`. */
    expect(container.querySelector("[class*='grid-cols-2'][class*='divide-y']")).toBeNull();
  });

  it("has no mUSD pools section", () => {
    // Those moved to Strategy earlier the same day; this guards the Exchange
    // tab against them coming back by way of a shared view.
    expect(mount().container.textContent).not.toContain("mUSD / USDC");
  });

  it("uses a smaller title than the Mint landing page", () => {
    // A working surface, not an introduction. Mint keeps 4xl/5xl.
    const h1 = mount().container.querySelector("h1")!;
    expect(h1.className).toContain("text-2xl");
    expect(h1.className).not.toContain("text-4xl");
  });
});
