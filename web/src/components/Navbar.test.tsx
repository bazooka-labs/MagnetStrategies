// @vitest-environment jsdom

/**
 * What is in the nav, and what is deliberately not.
 *
 * ── Why this exists ──
 * The nav had no test, and `/strategy` has now been added, removed and added
 * again — each time on a judgement about whether the page behind it was ready.
 * The judgement is not testable; the OUTCOME is, and the outcome is the thing
 * a future session will change by accident. Three entries here are hidden on
 * purpose (`/predict`, `/vote`, `/dao`), and "hidden, not removed" means the
 * routes still serve — so the only thing distinguishing a deliberate omission
 * from a regression is a test that says which is which.
 *
 * Asserted against the RENDERED nav rather than the `navLinks` array, because
 * the array is not exported and because a link that renders is what a visitor
 * has. Both the desktop row and the mobile sheet are checked: the two iterate
 * the same list in separate JSX, so a link can reach one and miss the other.
 */
import { cleanup, render, screen, fireEvent, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Navbar } from "./Navbar";

vi.mock("@/components/WalletButton", () => ({
  WalletButton: () => <button type="button">Connect Wallet</button>,
}));
vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <span role="presentation" aria-label={alt} />,
}));

afterEach(cleanup);

/** Every rendered nav href, desktop row and mobile sheet together. */
function hrefs(): string[] {
  render(<Navbar />);
  // The mobile sheet only mounts once opened.
  const toggle = screen.queryByRole("button", { name: "Open menu" });
  if (toggle) fireEvent.click(toggle);
  return Array.from(document.querySelectorAll("a[href]"))
    .map((a) => a.getAttribute("href") ?? "")
    .filter((h) => h.startsWith("/"));
}

describe("the nav shows the live products", () => {
  it("links to Strategy", () => {
    // Back in the nav 2026-10-23, once the C-Vault had a full signed round
    // trip on MainNet and the unsigned direct pools went admin-only. See the
    // comment on this entry in Navbar.tsx before removing it again.
    expect(hrefs()).toContain("/strategy");
  });

  it("labels it 'Strategy', not the route name", () => {
    render(<Navbar />);
    const links = screen.getAllByRole("link", { name: "Strategy" });
    expect(links.length).toBeGreaterThan(0);
    expect(links[0].getAttribute("href")).toBe("/strategy");
  });

  it("puts Strategy beside Trade, which shares its arm", () => {
    const desktop = hrefs();
    expect(desktop.indexOf("/strategy")).toBe(desktop.indexOf("/trade") + 1);
  });

  it("links to the other live products", () => {
    const h = hrefs();
    for (const route of ["/tokens", "/magnetfi", "/trade", "/contact"]) {
      expect(h, route).toContain(route);
    }
  });

  it("reaches BOTH the desktop row and the mobile sheet", () => {
    // The two iterate the same list in separate JSX; a link added to one and
    // not the other is invisible on a phone, or only on a phone.
    render(<Navbar />);
    const before = document.querySelectorAll('a[href="/strategy"]').length;
    const toggle = screen.queryByRole("button", { name: "Open menu" });
    if (toggle) fireEvent.click(toggle);
    const after = document.querySelectorAll('a[href="/strategy"]').length;
    expect(before).toBeGreaterThan(0);
    expect(after).toBeGreaterThan(before);
  });
});

describe("the row collapses before it can clip the wallet button", () => {
  /**
   * A CLASS assertion, which this repo normally avoids in favour of behaviour —
   * but jsdom has no layout, so there is no behaviour here to assert. The real
   * check was rendering at 768px in a browser: five links plus the social icons
   * pushed Connect Wallet off the right edge, and because the header is
   * `overflow-x-hidden` it clipped silently instead of scrolling.
   *
   * This pins the fix so the breakpoint is not quietly lowered back to `md`,
   * and names the browser check for whoever changes it next.
   */
  it("shows the desktop link row only from lg", () => {
    render(<Navbar />);
    const row = screen.getAllByRole("link", { name: "Strategy" })[0].parentElement;
    expect(row?.className).toContain("lg:flex");
    expect(row?.className).not.toMatch(/\bmd:flex\b/);
  });

  it("keeps the toggle and the sheet on the same breakpoint as the row", () => {
    // A mismatch shows the hamburger AND the links at the same width.
    render(<Navbar />);
    const toggle = screen.getByRole("button", { name: "Open menu" });
    expect(toggle.className).toContain("lg:hidden");
    fireEvent.click(toggle);
    expect(document.getElementById("mobile-nav")?.className).toContain("lg:hidden");
  });

  it("names the toggle and reports whether the sheet is open", () => {
    // An icon-only button with no label announced as an unnamed button.
    render(<Navbar />);
    const toggle = screen.getByRole("button", { name: "Open menu" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    const open = screen.getByRole("button", { name: "Close menu" });
    expect(open.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("the entries that are hidden on purpose", () => {
  // HIDDEN, NOT REMOVED: these routes still build and still serve, so the
  // absence of a link is the only thing expressing the decision. Without this,
  // "add Predict to the nav" looks like a fix rather than a reversal.
  it.each(["/predict", "/vote", "/dao"])("does not link to %s", (route) => {
    expect(hrefs()).not.toContain(route);
  });
});
