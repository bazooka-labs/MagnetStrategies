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
    /* Magnet opened its About out onto the page on 2026-11-07; mUSD kept the
       modal. A deliberate divergence, so each case states its own shape
       rather than the table pretending they are the same. */
    about: { kind: "inline", heading: "What is $U?" } as const,
    mount: async () => {
      const { MagnetTokenView } = await import("./MagnetTokenView");
      return render(
        <MagnetTokenView holders="120" price="$0.139636" tvl="442,531 ALGO"
          ytd={{ pct: 5.0, base: 1.4015, now: 1.4716, since: new Date("2026-06-19T00:00:00Z") }} />);
    },
    /** A figure only the stats half renders, to prove both halves are inside. */
    figure: "$0.139636",
  },
  {
    name: "mUSD",
    title: "mUSD",
    about: { kind: "pill", name: /About mUSD/ } as const,
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

  it("insets the chart instead of letting it meet the card border", async () => {
    /*
      The iframe sat flush: its dark body met the card's border on the left
      and bottom, so the two edges read as one smudged line. Every other
      block in this card is inset — header, stat cells, swap — and the chart
      was the only one that was not.

      Asserted on BOTH views, because they are meant to stay the same shape
      and a fix applied to one of them is the drift this file exists to
      catch.
    */
    const { container } = await c.mount();
    const chart = container.querySelector("[data-testid='chart']")!;
    expect(chart, "no chart rendered").toBeTruthy();
    // Clipped, so a hard corner does not sit inside a rounded card.
    expect(chart.parentElement!.className).toContain("rounded-xl");
    expect(chart.parentElement!.className).toContain("overflow-hidden");
    // And the column it sits in carries real padding.
    const column = chart.closest("[class*='col-span-3']") as HTMLElement;
    expect(column, "chart is not in the wide column").toBeTruthy();
    expect(column.className).toMatch(/\bp-4\b/);
  });

  it("keeps its About content inside the card", async () => {
    const { container } = await c.mount();
    const card = glowing(container)[0];
    if (c.about.kind === "pill") {
      expect(card.contains(screen.getByRole("button", { name: c.about.name }))).toBe(true);
    } else {
      // Inline: the heading and the copy are on the page, and there is no
      // longer a trigger to press.
      expect(card.textContent).toContain(c.about.heading);
      expect(card.textContent).toContain("fixed supply of 750,000 tokens");
      expect(screen.queryByRole("button", { name: /About \$U/ })).toBeNull();
    }
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

/**
 * The fifth cell on the Magnet page, which replaced the treasury.
 *
 * ── Why these are rendered rather than grepped ───────────────────────────
 * Mutation run, 2026-11-07: forcing the tone to `green` regardless of sign,
 * and rendering `0.00%` for an unread figure, both SURVIVED every other test
 * in the repo. The source-text tests check the cell EXISTS and the maths
 * tests check the number; neither looks at what a negative or unread figure
 * actually renders as.
 *
 * Those are the two cases that matter. A loss shown in green is a false
 * statement about performance, and a 0.00% we never measured is a claim.
 */
describe("the Magnet YTD cell", () => {
  const withYtd = async (ytd: {
    pct: number; base: number; now: number; since: Date;
  } | null) => {
    const { MagnetTokenView } = await import("./MagnetTokenView");
    return render(
      <MagnetTokenView holders="120" price="$0.139636" tvl="442,531 ALGO" ytd={ytd} />);
  };
  const YTD = { pct: 5.0, base: 1.4015, now: 1.4716, since: new Date("2026-06-19T00:00:00Z") };

  it("shows a gain in green, signed", async () => {
    await withYtd(YTD);
    const v = screen.getByText("+5.00%");
    expect(v.className).toContain("text-green-400");
  });

  it("shows a LOSS in red, which is the whole reason the tone is dynamic", async () => {
    await withYtd({ ...YTD, pct: -7.24, now: 1.3 });
    const v = screen.getByText("-7.24%");
    expect(v.className).toContain("text-red-300");
    expect(v.className).not.toContain("text-green-400");
  });

  it("renders a dash, never 0.00%, when Vestige could not be read", async () => {
    await withYtd(null);
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.queryByText("0.00%")).toBeNull();
    expect(screen.getByText(/Couldn't read the price history/)).toBeTruthy();
  });

  it("carries its own basis, so the figure is not a bare claim", async () => {
    // "1.4015 → 1.4716 ALGO since Jun 19" is a measurement showing its
    // working; "+5.00%" alone is an assertion.
    await withYtd(YTD);
    expect(screen.getByText(/1\.4015 → 1\.4716 ALGO since Jun 19/)).toBeTruthy();
  });

  it("states the date in UTC, matching the candle boundary", async () => {
    // A local-time render would read "Jun 18" for anyone west of London
    // while the figure was measured from the 19th.
    await withYtd(YTD);
    expect(screen.getByText(/since Jun 19/)).toBeTruthy();
    expect(screen.queryByText(/since Jun 18/)).toBeNull();
  });

  it("does not put the treasury on this page any more", async () => {
    await withYtd(YTD);
    expect(screen.queryByText(/USDC for liquidity/)).toBeNull();
  });
});

describe("the Magnet subheader", () => {
  it('reads "The Original Strategy."', async () => {
    /*
      Changed 2026-11-07 from "Built to compound liquidity across Algorand
      DeFi." — accurate but generic, and it read as a tagline on a page that
      now sits inside the Strategy arm. $U was the first product and the line
      says so.

      A product decision in one string, which is the easiest kind of thing to
      revert by accident in a merge.
    */
    const { MagnetTokenView } = await import("./MagnetTokenView");
    const { container } = render(
      <MagnetTokenView holders="120" price="$0.139636" tvl="442,531 ALGO"
        ytd={{ pct: 5, base: 1.4015, now: 1.4716, since: new Date("2026-06-19T00:00:00Z") }} />);
    expect(screen.getByText("The Original Strategy.")).toBeTruthy();
    expect(container.textContent).not.toContain("Built to compound liquidity");
  });
});

describe("the mUSD page no longer lists the mUSD pools", () => {
  it("does not render them — they moved to Strategy on 2026-11-07", async () => {
    /*
      Both PSM pills render this view, so leaving the list here showed the
      same cards twice on one page. The other half of this assertion lives
      in LpPoolsGlow.test.tsx, which checks they arrived.
    */
    const { MusdTokenView } = await import("./MusdTokenView");
    const { container } = render(<MusdTokenView holders="8" marketPrice={1.0001} />);
    expect(container.querySelector("[data-testid='musd-pools']")).toBeNull();
    expect(container.textContent).not.toContain("mUSD / USDC");
  });
});
