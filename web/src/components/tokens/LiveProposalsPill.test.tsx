// @vitest-environment jsdom

/**
 * The pill's half of the contract: pressing it must ANNOUNCE itself.
 *
 * ── The bug this file exists for ──────────────────────────────────────────
 * The pill moved into the mUSD hero on 2026-11-07, which made its link a
 * same-page navigation. Next routes that through the history API and fires
 * no `hashchange`, so `TokensView`'s listener never ran: the URL became
 * `/tokens#governance` and the Exchange pill stayed selected. A live count
 * sitting above a button that does nothing.
 *
 * It was caught by clicking it in a real browser. A jsdom test had passed
 * throughout by dispatching `hashchange` by hand — the one event the real
 * navigation does not produce. So this asserts the event the pill actually
 * sends, and `TokensView.test.tsx` asserts the view's response to it.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPEN_GOVERNANCE } from "./TokensView";

vi.mock("@/hooks/useGovernanceProposals", () => ({
  liveCount: () => 1,
  useGovernanceProposals: () => ({
    proposals: [], loading: false, incomplete: false, refresh: () => {},
  }),
}));
vi.mock("next/link", () => ({
  // Stands in for Next's Link: renders an anchor and runs onClick. It does
  // NOT fire hashchange — which is the whole point.
  default: ({ children, href, onClick, className }: {
    children: React.ReactNode; href: string;
    onClick?: () => void; className?: string;
  }) => <a href={href} onClick={onClick} className={className}>{children}</a>,
}));

afterEach(cleanup);

const mount = async () => {
  const { LiveProposalsPill } = await import("./LiveProposalsPill");
  return render(<LiveProposalsPill />);
};

describe("the Live proposals pill", () => {
  it("still links to the governance URL, for arrivals from other pages", async () => {
    await mount();
    const link = screen.getByRole("link", { name: /Live proposals/ });
    expect(link.getAttribute("href")).toBe("/tokens#governance");
  });

  it("dispatches the open-governance event when pressed", async () => {
    const seen: string[] = [];
    const onOpen = () => seen.push("open");
    window.addEventListener(OPEN_GOVERNANCE, onOpen);

    await mount();
    fireEvent.click(screen.getByRole("link", { name: /Live proposals/ }));
    expect(seen, "pressing the pill announced nothing — a same-page Link "
      + "fires no hashchange, so the event is the only signal").toEqual(["open"]);

    window.removeEventListener(OPEN_GOVERNANCE, onOpen);
  });

  it("shows the count, and stays visible when it is zero", async () => {
    await mount();
    await waitFor(() => expect(screen.getByText("1")).toBeTruthy());
    expect(screen.getByRole("link", { name: /Live proposals/ })).toBeTruthy();
  });
});
