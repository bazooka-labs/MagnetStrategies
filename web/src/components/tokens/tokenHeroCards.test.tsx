// @vitest-environment jsdom

/**
 * The two token views are ONE card each, and they match.
 *
 * ── Why these are tested together ─────────────────────────────────────────
 * `MagnetTokenView` and `MusdTokenView` are the same layout with different
 * figures: a hero, a five-cell stat row, a chart beside a swap. Both were two
 * stacked blocks carrying IDENTICAL chrome — same `rounded-2xl`, same
 * `border-white/10`, same `bg-black/40 backdrop-blur-sm`, each drawing its
 * own top hairline — so each page rendered the same card twice with a gap
 * between. They were merged into one glowing card on 2026-11-07, Magnet
 * first and mUSD the same day.
 *
 * One file, one table of cases, because the thing most likely to go wrong is
 * not either view breaking — it is the two DRIFTING. Separate files pass
 * happily while one view keeps a merge the other has lost, and that is the
 * state the second merge existed to end.
 *
 * Splitting a card again is also a one-line edit that compiles, breaks no
 * other test, and reads as reasonable in review. Hence the structure is
 * asserted rather than left to the diff.
 *
 * The glow is checked the way `LpPoolsGlow.test.tsx` learned to: ring AND
 * halo, with the default black shadow absent. `Panel`'s own doc records why —
 * a glow passed through `className` keeps its ring and silently loses its
 * shadow, rendering as a thin border where a neon glow was intended.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/* The heavy children are not what this file is about: a TradingView embed,
   two wallet widgets, and cells that fetch on mount. Stubbed so these tests
   are about layout and cannot fail on a network. */
vi.mock("@/components/VestigeChart", () => ({
  VestigeChart: () => <div data-testid="chart" />,
}));
vi.mock("@/components/HaystackSwap", () => ({
  HaystackSwap: () => <div data-testid="swap" />,
}));
vi.mock("@/components/magnetfi/v2/MusdTab", () => ({
  MusdTab: () => <div data-testid="swap" />,
}));
vi.mock("@/components/TvlRankStat", () => ({
  TvlRankStat: () => <div data-testid="rank" />,
}));
vi.mock("@/components/tokens/TreasuryStat", () => ({
  TreasuryStat: () => <div data-testid="treasury" />,
}));
vi.mock("@/components/tokens/MusdPoolsSection", () => ({
  MusdPoolsSection: () => <div data-testid="musd-pools" />,
}));
vi.mock("@/components/tokens/LiveProposalsPill", () => ({
  LiveProposalsPill: () => <div data-testid="proposals-pill" />,
}));
vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({ algodClient: null, address: null, isConnected: false }),
}));
vi.mock("@/lib/magnetfiReads", () => ({
  getProtocolStats: () => Promise.reject(new Error("no node in this test")),
  getStrategyStats: () => Promise.reject(new Error("no node in this test")),
}));

afterEach(cleanup);

/** Containers carrying the magnet ring. */
const glowing = (c: HTMLElement) =>
  [...c.querySelectorAll("[class*='ring-magnet-400']")] as HTMLElement[];

const CASES = [
  {
    name: "Magnet Token",
    title: "Magnet Token",
    about: /About \$U/,
    mount: async () => {
      const { MagnetTokenView } = await import("./MagnetTokenView");
      return render(
        <MagnetTokenView holders="120" price="$0.139636" tvl="442,531 ALGO" />);
    },
    /** A figure only the stats half renders, to prove both halves are inside. */
    figure: "$0.139636",
  },
  {
    name: "mUSD",
    title: "mUSD",
    about: /About mUSD/,
    mount: async () => {
      const { MusdTokenView } = await import("./MusdTokenView");
      return render(<MusdTokenView holders="8" marketPrice={1.0001} />);
    },
    figure: "8",
  },
] as const;

describe.each(CASES)("$name — the merged card", (c) => {
  it("renders exactly one glowing container, not two stacked", async () => {
    const { container } = await c.mount();
    expect(glowing(container).length,
      "the hero and the stats panel should be one card").toBe(1);
  });

  it("gives it a halo, not just a ring", async () => {
    const { container } = await c.mount();
    const card = glowing(container)[0];
    expect(card.className).toMatch(/shadow-\[0_0_30px/);
    expect(card.className, "the black shadow would recolour the halo")
      .not.toContain("shadow-black/40");
  });

  it("holds BOTH the title and the figures", async () => {
    // The merge is only real if one container contains both halves.
    const { container } = await c.mount();
    const card = glowing(container)[0];
    expect(card.textContent).toContain(c.title);
    expect(card.textContent).toContain(c.figure);
    expect(card.querySelector("[data-testid='chart']")).toBeTruthy();
    expect(card.querySelector("[data-testid='swap']")).toBeTruthy();
  });

  it("draws one top hairline, not one per former block", async () => {
    // Each block used to render its own. Stacked, that was two.
    const { container } = await c.mount();
    expect(container.querySelectorAll("[class*='via-magnet-500/60']").length).toBe(1);
  });

  it("heads the taller card with the larger title", async () => {
    // Stepped up from 3xl/4xl when the cards roughly doubled in height; at
    // the old size the title read small against the stat row beneath it.
    const { container } = await c.mount();
    const h1 = container.querySelector("h1")!;
    expect(h1.textContent).toBe(c.title);
    expect(h1.className).toContain("text-4xl");
    expect(h1.className).toContain("sm:text-5xl");
  });

  it("keeps the About pill inside the card", async () => {
    const { container } = await c.mount();
    const button = screen.getByRole("button", { name: c.about });
    expect(glowing(container)[0].contains(button)).toBe(true);
  });
});

describe("the two views stay the same shape", () => {
  /*
    The drift guard. Everything above runs per view and would pass with one
    merged and one not — each case only ever looks at itself. This compares
    them, which is the claim the second merge actually made.
  */
  it("gives both the identical card treatment", async () => {
    const shapes: string[] = [];
    for (const c of CASES) {
      const { container } = await c.mount();
      const card = glowing(container)[0];
      const h1 = container.querySelector("h1")!;
      shapes.push(JSON.stringify({
        glowing: glowing(container).length,
        halo: /shadow-\[0_0_30px/.test(card.className),
        ring: /ring-magnet-400\/60/.test(card.className),
        blackShadow: card.className.includes("shadow-black/40"),
        hairlines: container.querySelectorAll("[class*='via-magnet-500/60']").length,
        title: h1.className.match(/text-\dxl|sm:text-\dxl/g)?.sort(),
        headerPad: /px-6 py-5 sm:px-10 sm:py-6/.test(card.innerHTML),
      }));
      cleanup();
    }
    expect(shapes[0], "Magnet Token and mUSD have drifted apart")
      .toBe(shapes[1]);
  });
});
