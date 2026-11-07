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

/**
 * Three pools, shaped as /api/pools returns them.
 *
 * Both liquid-staking pairs are here, because the point of the 2026-11-07
 * change is that they are the same KIND of pool and used to look like two
 * different kinds — uALGO gold, tALGO purple and unbadged.
 */
const POOLS = [
  {
    id: "u-ualgo", pair: "U / uALGO", partner: "uALGO", accent: "gold", featured: true,
    liquidStaking: true,
    venues: [{ dex: "tinyman", ref: "X", addLiquidityUrl: "#" }],
    tvlUsd: 9842, feeApr: null, farmApr: null, totalApr: null, farmLive: false, venueData: [],
  },
  {
    id: "u-talgo", pair: "U / tALGO", partner: "tALGO", accent: "gold",
    liquidStaking: true,
    venues: [{ dex: "tinyman", ref: "Z", addLiquidityUrl: "#" }],
    tvlUsd: 41000, feeApr: 5.2, farmApr: null, totalApr: 5.2, farmLive: false, venueData: [],
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
    expect(cards.length, "no glowing cards rendered").toBe(3);
    for (const el of cards) {
      expect(el.className, `card has a ring but no halo: ${el.className}`)
        .toMatch(/shadow-\[0_0_30px/);
      expect(el.className, "the black shadow would recolour the halo")
        .not.toContain("shadow-black/40");
    }
  });

  it("gives BOTH liquid-staking pools the gold one and the rest purple", async () => {
    // tALGO was purple until 2026-11-07 while uALGO was gold, which made two
    // pools of the same kind read as two different kinds.
    const container = await renderCards();
    expect(container.querySelectorAll("[class*='ring-amber-300']").length).toBe(2);
    expect(container.querySelectorAll("[class*='ring-magnet-400']").length).toBe(1);
  });
});

describe("the Liquid Staking badge", () => {
  /**
   * A FRESH fixture per test.
   *
   * The first version mutated the shared `POOLS` array and restored it at the
   * end of each test — so the moment one assertion failed, the restore was
   * skipped and the next test ran against a pool whose flag was still off. It
   * reported two failures for one defect, and the second was fiction.
   */
  const pools = (patch: Record<string, Partial<Record<string, unknown>>> = {}) =>
    POOLS.map((p) => ({ ...p, ...(patch[p.id] ?? {}) }));

  const renderCards = async (list: unknown[] = pools()) => {
    vi.stubGlobal("fetch", () => Promise.resolve({ json: () => Promise.resolve({ pools: list }) }));
    const { LpPoolsSection } = await import("@/components/strategy/pools/LpPoolsSection");
    const r = render(<LpPoolsSection />);
    await waitFor(() => expect(screen.getByText("U / uALGO")).toBeTruthy());
    return r;
  };

  /**
   * The BADGES, not every mention of the words.
   *
   * The legend at the foot of the section explains the badge and therefore
   * contains the same two words, so a bare `getAllByText` counted three for
   * two badges. The badge is the pill; `rounded-full` is what makes it one.
   */
  const badges = () =>
    screen.queryAllByText("Liquid Staking", { selector: "span.rounded-full" });

  /** The card a pair name sits in. */
  const cardFor = (pair: string) =>
    screen.getByText(pair).closest("[class*='ring-']") as HTMLElement;

  it("appears on both liquid-staking pools and nowhere else", async () => {
    await renderCards();
    expect(badges().length).toBe(2);
    expect(cardFor("U / uALGO").textContent).toContain("Liquid Staking");
    expect(cardFor("U / tALGO").textContent).toContain("Liquid Staking");
    // U/ALGO is plain ALGO, not a staking derivative — the distinction the
    // badge exists to draw, so a badge on everything would erase it.
    expect(cardFor("U / ALGO").textContent).not.toContain("Liquid Staking");
  });

  it("follows the data, not a pool id", async () => {
    // The component must know about a PROPERTY. Clear the flag on one pool
    // and its badge goes, without the component being touched.
    await renderCards(pools({ "u-ualgo": { liquidStaking: undefined } }));
    expect(badges().length).toBe(1);
    expect(cardFor("U / uALGO").textContent).not.toContain("Liquid Staking");
    expect(cardFor("U / tALGO").textContent).toContain("Liquid Staking");
  });

  it("sits alongside Farming rather than displacing it", async () => {
    /*
      uALGO's Tinyman farm starts next month, at which point one card is both
      liquid staking and farming. A single right-hand slot would have shown
      whichever badge won the condition.
    */
    await renderCards(pools({ "u-ualgo": { farmLive: true } }));
    const card = cardFor("U / uALGO");
    expect(card.textContent).toContain("Liquid Staking");
    expect(card.textContent).toContain("Farming");
  });

  it("explains itself in the legend, as Farming does", async () => {
    // A badge nobody can decode is decoration. The legend already carried
    // Farming and would have left this one unexplained.
    await renderCards();
    const legend = screen.getByText(/badge indicates a farm is currently live/);
    expect(legend.textContent).toContain("ALGO staked for consensus");
    expect(legend.textContent).toMatch(/tALGO on Tinyman/);
    expect(legend.textContent).toMatch(/uALGO on Myth Finance/);
  });
});
