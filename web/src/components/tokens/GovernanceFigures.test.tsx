// @vitest-environment jsdom

/**
 * The pair of figures inside "How voting works".
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 * The treasury moved into the governance panel on 2026-11-08, out of the
 * mUSD metric row. The guard that was supposed to police where it lives
 * read the SOURCE of `GovernanceSection.tsx` for `getTreasuryUsdc` and
 * `TREASURY_ADDRESS` — and it went on passing after the move, because the
 * panel renders `<TreasuryStat />` and never names either symbol. A guard
 * that is green while the thing it forbids is on screen is worse than none.
 *
 * So the placement is asserted against the RENDERED tree from here on:
 * `TreasuryStat` is left real and only its chain read is stubbed, which is
 * also what makes the two boxes' shared frame checkable.
 */

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GovernanceSection } from "./GovernanceSection";

/* No client, so every chain read in the section short-circuits and the
   proposals store stays on its initial snapshot. The treasury builds its
   OWN client, by design, so that one read is stubbed instead. */
vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({
    address: null, isConnected: false, algodClient: null,
    signTransactions: () => Promise.reject(new Error("not in this test")),
  }),
}));
vi.mock("@/lib/governanceReads", async (orig) => ({
  ...(await orig<typeof import("@/lib/governanceReads")>()),
  // Base units, as the real read returns: micro-USDC off the asset holding.
  getTreasuryUsdc: () => Promise.resolve(48_250_500_000),
}));

afterEach(cleanup);

/** The amber explanation, found by its heading rather than by a class. */
const panel = () =>
  screen.getByRole("heading", { name: "How voting works" }).closest("div.rounded-2xl") as HTMLElement;

describe("the treasury lives inside the voting explanation", () => {
  it("renders the balance there, not just somewhere on the page", async () => {
    render(<GovernanceSection />);
    await waitFor(() => expect(within(panel()).getByText("$48,250.50")).toBeTruthy());
    expect(within(panel()).getByText("Treasury")).toBeTruthy();
  });

  it("keeps the link to the account on chain", async () => {
    render(<GovernanceSection />);
    const link = await waitFor(() => within(panel()).getByText(/USDC for liquidity/));
    // The label is the honest one: the account holds ALGO too, and widening
    // the figure to a portfolio total under the word "Treasury" would make a
    // bigger number by changing the question.
    expect(link.closest("a")!.getAttribute("href")).toMatch(/^https:\/\/allo\.info\/account\/[A-Z2-7]{58}$/);
  });

  it("sits beside vote power, not stacked in a column of one", async () => {
    /*
      The two are a pair: the pot a proposal points at, and your say in
      where it points. They share one grid row, so they must share one
      parent — and that parent must actually be a two-column grid, or the
      "pair" is a claim the layout does not make.
    */
    render(<GovernanceSection />);
    await waitFor(() => expect(within(panel()).getByText("Treasury")).toBeTruthy());
    const row = within(panel()).getByText("Treasury").closest("div.rounded-xl")!.parentElement!;
    expect(row.className).toContain("sm:grid-cols-2");
    expect(within(row as HTMLElement).getByText("Current vote power")).toBeTruthy();
    expect(row.children.length).toBe(2);
  });

  it("gives both boxes the same frame, so the pair cannot drift", async () => {
    /*
      Both come from `GovFigure`. Hand-built, they would be two copies of
      six classes and the first edit to one would misalign the baselines of
      a pair whose whole job is to be compared at a glance.
    */
    render(<GovernanceSection />);
    await waitFor(() => expect(within(panel()).getByText("Treasury")).toBeTruthy());
    const frame = (label: string) =>
      within(panel()).getByText(label).closest("div.rounded-xl")!.className;
    expect(frame("Treasury")).toBe(frame("Current vote power"));
  });

  it("labels both in white, because grey reads as disabled on amber", async () => {
    // The inverse of the metric row, where the label is grey and the colour
    // carries the number. These boxes sit on an amber-tinted panel.
    render(<GovernanceSection />);
    await waitFor(() => expect(within(panel()).getByText("Treasury")).toBeTruthy());
    for (const label of ["Treasury", "Current vote power"]) {
      expect(within(panel()).getByText(label).className, label).toContain("text-white");
    }
  });

  it("colours the two figures apart, from the shared table", async () => {
    // A hardcoded class is how these drift from the metric row's palette.
    render(<GovernanceSection />);
    const money = await waitFor(() => within(panel()).getByText("$48,250.50"));
    expect(money.className).toContain("text-green-400");
    expect(within(panel()).getByText("Connect a wallet to see your voting power")).toBeTruthy();
  });
});

describe("it is in the governance panel INSTEAD of the metric row", () => {
  /*
    Not as well as. Governance and the mUSD metric row are two pills of one
    page, and a balance shown twice invites the reader to ask which is
    current — the reason it left this panel in the first place.

    The mUSD half of this is asserted in `tokenHeroCards.test.tsx`, which
    renders that view; here is the half that proves it arrived.
  */
  it("shows the balance exactly once in the whole section", async () => {
    const { container } = render(<GovernanceSection />);
    await waitFor(() => expect(within(panel()).getByText("$48,250.50")).toBeTruthy());
    expect(screen.getAllByText("$48,250.50")).toHaveLength(1);
    expect(container.querySelectorAll("a[href*='allo.info/account/']")).toHaveLength(1);
  });
});
