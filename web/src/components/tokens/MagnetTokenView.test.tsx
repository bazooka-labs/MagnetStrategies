// @vitest-environment jsdom

/**
 * The Magnet Token view is ONE card, and it glows.
 *
 * ── Why this needs a test at all ──────────────────────────────────────────
 * The hero and the stats panel were merged on 2026-11-07, and the thing that
 * made them worth merging is invisible in a diff: both already carried the
 * same `rounded-2xl border-white/10 bg-black/40 backdrop-blur-sm` and each
 * drew its own top hairline, so the page rendered the same card twice with a
 * gap between.
 *
 * Splitting them again is a one-line edit that breaks nothing, compiles, and
 * looks plausible in review. So the structure is asserted: one glowing
 * container, holding both the title and the figures.
 *
 * The glow is asserted the way `LpPoolsGlow.test.tsx` learned to — ring AND
 * halo, with the default black shadow absent. `Panel`'s own doc records why:
 * a glow passed through `className` keeps its ring and silently loses its
 * shadow, which renders as a thin border where a neon glow was intended.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/* The heavy children are not what this file is about: a TradingView embed, a
   wallet swap widget, and two cells that fetch on mount. Stubbed so the test
   is about layout and cannot fail on a network. */
vi.mock("@/components/VestigeChart", () => ({
  VestigeChart: () => <div data-testid="chart" />,
}));
vi.mock("@/components/HaystackSwap", () => ({
  HaystackSwap: () => <div data-testid="swap" />,
}));
vi.mock("@/components/TvlRankStat", () => ({
  TvlRankStat: () => <div data-testid="rank" />,
}));
vi.mock("@/components/tokens/TreasuryStat", () => ({
  TreasuryStat: () => <div data-testid="treasury" />,
}));

const mount = async () => {
  const { MagnetTokenView } = await import("./MagnetTokenView");
  return render(<MagnetTokenView holders="120" price="$0.139636" tvl="442,531 ALGO" />);
};

afterEach(cleanup);

/** Containers carrying the magnet ring. */
const glowing = (c: HTMLElement) =>
  [...c.querySelectorAll("[class*='ring-magnet-400']")] as HTMLElement[];

describe("the merged card", () => {
  it("renders exactly one glowing container, not two stacked", async () => {
    const { container } = await mount();
    expect(glowing(container).length,
      "the hero and the stats panel should be one card").toBe(1);
  });

  it("gives it a halo, not just a ring", async () => {
    // A glow routed through `className` instead of `glowClass` keeps the ring
    // and loses the shadow — a thin border where a neon glow was intended.
    const { container } = await mount();
    const card = glowing(container)[0];
    expect(card.className).toMatch(/shadow-\[0_0_30px/);
    expect(card.className, "the black shadow would recolour the halo")
      .not.toContain("shadow-black/40");
  });

  it("holds BOTH the title and the figures", async () => {
    // The merge is only real if one container contains both halves.
    const { container } = await mount();
    const card = glowing(container)[0];
    expect(card.textContent).toContain("Magnet Token");
    expect(card.textContent).toContain("$0.139636");
    expect(card.textContent).toContain("442,531 ALGO");
    expect(card.querySelector("[data-testid='chart']")).toBeTruthy();
    expect(card.querySelector("[data-testid='swap']")).toBeTruthy();
  });

  it("draws one top hairline, not one per former block", async () => {
    // Each block used to render its own. Stacked, that was two.
    const { container } = await mount();
    expect(container.querySelectorAll("[class*='via-magnet-500/60']").length).toBe(1);
  });

  it("heads the taller card with the larger title", async () => {
    // Stepped up from 3xl/4xl when the card roughly doubled in height; at the
    // old size it read small against the stat row beneath it.
    const { container } = await mount();
    const h1 = container.querySelector("h1")!;
    expect(h1.textContent).toBe("Magnet Token");
    expect(h1.className).toContain("text-4xl");
    expect(h1.className).toContain("sm:text-5xl");
  });

  it("keeps the About pill inside the card", async () => {
    await mount();
    expect(screen.getByRole("button", { name: /About \$U/ })).toBeTruthy();
  });
});
