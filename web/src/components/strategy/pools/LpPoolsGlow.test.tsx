// @vitest-environment jsdom

/**
 * The pool cards carry a real glow, not just its ring.
 *
 * ── The bug ────────────────────────────────────────────────────────────────
 * `MAGNET_GLOW` is a ring AND a coloured shadow. Passing it to `Panel` via
 * `className` keeps the ring and silently kills the shadow: Panel's default
 * `shadow-black/40` sets `--tw-shadow-color`, which recolours any shadow
 * arriving that way to black. The card renders as a thin neon border with no
 * halo.
 *
 * Panel's own doc comment warns about this and records it as how the
 * `glowClass` prop first shipped. It is also how the pool cards shipped, one
 * commit later, and nothing caught it — tsc is happy, the class name IS
 * present, and only looking at the page shows the halo missing.
 *
 * So this asserts the RENDERED class list: the glow's shadow present, and the
 * default black shadow that would defeat it absent.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALGO_GLOW, MAGNET_GLOW, Panel } from "@/components/magnetfi/v2/shared";

/** Two pools, one of each accent, shaped as /api/pools returns them. */
const POOLS = [
  {
    id: "u-ualgo", pair: "U / uALGO", partner: "uALGO", accent: "gold", featured: true,
    venues: [{ dex: "tinyman", ref: "X", addLiquidityUrl: "#" }],
    tvlUsd: 9842, feeApr: null, farmApr: null, totalApr: null, farmLive: false, venueData: [],
  },
  {
    id: "u-algo", pair: "U / ALGO", partner: "ALGO",
    venues: [{ dex: "tinyman", ref: "Y", addLiquidityUrl: "#" }],
    tvlUsd: 184000, feeApr: 12.4, farmApr: 8.1, totalApr: 20.5, farmLive: true, venueData: [],
  },
];

afterEach(cleanup);

/** Panel renders its own root; the classes under test live on it. */
const panelClasses = (ui: React.ReactElement) => {
  const { container } = render(ui);
  return (container.firstElementChild as HTMLElement).className;
};

describe("a glow passed to Panel survives as a glow", () => {
  it("keeps the coloured shadow when passed through glowClass", () => {
    const cls = panelClasses(<Panel glowClass={MAGNET_GLOW}>x</Panel>);
    expect(cls).toContain("ring-magnet-400/60");
    // The halo itself, not just the ring.
    expect(cls).toMatch(/shadow-\[0_0_30px/);
  });

  it("drops the default black shadow that would recolour it", () => {
    // `shadow-black/40` sets --tw-shadow-color. Present alongside the glow,
    // it turns the halo black, which is indistinguishable from no halo.
    const cls = panelClasses(<Panel glowClass={MAGNET_GLOW}>x</Panel>);
    expect(cls).not.toContain("shadow-black/40");
  });

  it("shows what the WRONG route produces, so the difference is on record", () => {
    // Exactly how the pool cards first shipped: ring survives, halo does not,
    // and the black shadow is still there to recolour anything that did.
    const cls = panelClasses(<Panel className={MAGNET_GLOW}>x</Panel>);
    expect(cls).toContain("ring-magnet-400/60");
    expect(cls).toContain("shadow-black/40");
  });

  it("keeps the default shadow when no glow is asked for", () => {
    const cls = panelClasses(<Panel>x</Panel>);
    expect(cls).toContain("shadow-black/40");
    expect(cls).not.toMatch(/ring-magnet-400/);
  });

  it("carries the gold variant the same way", () => {
    const cls = panelClasses(<Panel glowClass={ALGO_GLOW}>x</Panel>);
    expect(cls).toContain("ring-amber-300/60");
    expect(cls).toMatch(/shadow-\[0_0_30px/);
    expect(cls).not.toContain("shadow-black/40");
  });
});


describe("the POOL CARDS themselves, not just the Panel contract", () => {
  /**
   * The contract tests above pass even with the bug in place, because they
   * exercise `Panel` directly. Only rendering the real card catches a glow
   * routed through the wrong prop — which is how this shipped.
   */
  const renderCards = async () => {
    vi.stubGlobal("fetch", () => Promise.resolve({ json: () => Promise.resolve({ pools: POOLS }) }));
    const { LpPoolsSection } = await import("@/components/strategy/pools/LpPoolsSection");
    const { container } = render(<LpPoolsSection />);
    await waitFor(() => expect(screen.getByText("U / uALGO")).toBeTruthy());
    return container;
  };

  it("gives every card a halo, not just a ring", async () => {
    const container = await renderCards();
    const cards = [...container.querySelectorAll("[class*='ring-']")]
      .filter((el) => /ring-(magnet-400|amber-300)/.test(el.className));
    expect(cards.length, "no glowing cards rendered").toBe(2);
    for (const el of cards) {
      expect(el.className, `card has a ring but no halo: ${el.className}`)
        .toMatch(/shadow-\[0_0_30px/);
      expect(el.className, "the black shadow would recolour the halo")
        .not.toContain("shadow-black/40");
    }
  });

  it("gives the Myth Finance pool the gold one and the rest purple", async () => {
    const container = await renderCards();
    expect(container.querySelectorAll("[class*='ring-amber-300']").length).toBe(1);
    expect(container.querySelectorAll("[class*='ring-magnet-400']").length).toBe(1);
  });
});
