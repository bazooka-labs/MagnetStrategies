// @vitest-environment jsdom

/**
 * `SectionHero`, and the `footer` that folds a second block into it.
 *
 * ── Why the footer needs a test ──────────────────────────────────────────
 * Its whole point is invisible in a diff. Before it, the Bank's vault page
 * stacked a `<Panel>` under the hero and drew identical chrome twice — same
 * `rounded-2xl`, same `border-white/10`, same `bg-black/40 backdrop-blur-sm`,
 * each with its own top hairline — with a gap between. Pulling the metrics
 * back out into their own Panel is a small, plausible-looking edit that
 * compiles and breaks nothing else.
 *
 * Three consumers share this component, and only one passes a footer. The
 * tests cover both shapes, because a change made for the merged caller must
 * not quietly alter the two that render a bare header.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SectionHero } from "./SectionHero";

afterEach(cleanup);

const root = (c: HTMLElement) => c.firstElementChild as HTMLElement;

describe("without a footer — the shape the other two callers use", () => {
  it("renders one card, one hairline, and keeps its own padding", () => {
    const { container } = render(
      <SectionHero title="LP Collateral Vaults" description="Borrow mUSD." />);
    const card = root(container);
    expect(card.className).toContain("rounded-2xl");
    expect(container.querySelectorAll("[class*='via-magnet-500/60']").length).toBe(1);
    // The padding moved off the root onto the header section when `footer`
    // arrived; a bare header must still be padded.
    expect(card.querySelector("[class*='px-6']")).toBeTruthy();
  });

  it("carries no glow unless one is asked for", () => {
    const { container } = render(<SectionHero title="T" description="D" />);
    expect(root(container).className).not.toMatch(/ring-magnet/);
  });

  it("puts actions in the header beside the title", () => {
    render(
      <SectionHero title="T" description="D"><button>Learn more</button></SectionHero>);
    expect(screen.getByRole("button", { name: "Learn more" })).toBeTruthy();
  });
});

describe("with a footer — the merged Bank card", () => {
  const merged = () => render(
    <SectionHero
      title="LP Collateral Vaults"
      description="Borrow mUSD against your Tinyman LP tokens."
      glowClass="ring-1 ring-magnet-400/60 shadow-[0_0_30px_-2px_rgba(168,85,247,0.8)]"
      footer={<div data-testid="metrics">Total Max Lending</div>}
    >
      <button>Learn more</button>
    </SectionHero>);

  it("holds the title AND the footer in ONE card", () => {
    // The merge is only real if a single container has both halves.
    const { container } = merged();
    const card = root(container);
    expect(card.textContent).toContain("LP Collateral Vaults");
    expect(card.querySelector("[data-testid='metrics']")).toBeTruthy();
    expect(container.querySelectorAll("[class*='rounded-2xl']").length).toBe(1);
  });

  it("still draws one hairline, not one per block", () => {
    // Two stacked Panels drew two. That is the duplication being removed.
    const { container } = merged();
    expect(container.querySelectorAll("[class*='via-magnet-500/60']").length).toBe(1);
  });

  it("divides the two halves rather than running them together", () => {
    const { container } = merged();
    expect(container.querySelector("[class*='border-t']")).toBeTruthy();
  });

  it("applies the glow to the whole card", () => {
    const { container } = merged();
    expect(root(container).className).toContain("ring-magnet-400/60");
  });

  it("leaves the footer flush — the padding is on the header only", () => {
    /*
      If the root kept `px-6 py-7`, the footer's own cells would be inset
      inside it and its dividers would stop short of the card's edges.
    */
    const { container } = merged();
    expect(root(container).className).not.toMatch(/\bpx-6\b/);
    const footer = container.querySelector("[data-testid='metrics']")!;
    expect(footer.closest("[class*='px-6']")).toBeNull();
  });
});
