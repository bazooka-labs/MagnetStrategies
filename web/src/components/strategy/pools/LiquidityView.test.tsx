// @vitest-environment jsdom

/**
 * Only the C-Vault is public.
 *
 * The two direct market pools are admin-only for now — not because they are
 * unfinished, but because the C-Vault is the product going in front of users
 * first and a page offering three destinations invites a choice nobody has the
 * context to make.
 *
 * ── What this gate is, and is not ──
 * It is COSMETIC, deliberately. Everything on this page is a PEX call signed by
 * the user's own wallet; anyone can deposit to either pool through PEX
 * directly. `isAdmin` hides a card, it does not guard an authority — real
 * authority is in the contracts' own admin checks.
 *
 * These tests therefore assert what a VISITOR CAN SEE, which is the whole
 * claim being made. A test that only checked the boolean would pass while the
 * cards rendered anyway.
 */
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ADMIN = "KNML6OW2XVXYSSGQX7EBLBMSLAPY6QFNBZUJMNEFIEXIIVJLMW4VINYU6A";
const VISITOR = "A4YW55ZEC2TTIN2TEVN56IRVGLWQYQRUNJTPG37OTWE4EJWNAH3EUKHZKA";

let wallet: { address: string | null; isConnected: boolean } =
  { address: null, isConnected: false };

/**
 * A non-null algod stands in for a node: `load()` returns early without one, so
 * a null client would make every data assertion below pass against an unloaded
 * page. The object is never called — `readStrategyLiquidity` is mocked.
 */
// STABLE identity, deliberately. `load` is a useCallback keyed on
// [algodClient, address] and the effect that calls it is keyed on `load`, so a
// fresh object per render re-runs the read forever — which it did, and hung the
// suite rather than failing it.
const ALGOD = {} as unknown;

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({
    algodClient: ALGOD,
    address: wallet.address,
    isConnected: wallet.isConnected,
    signTransactions: null,
  }),
}));
/**
 * The read layer needs a node. By default both reads REJECT — the page must
 * render without a node, showing its error state rather than throwing, which is
 * also what a visitor sees offline. `liquidity`/`bundle` let a test supply real
 * figures instead; the share stats cannot be asserted against a null read.
 */
let liquidity: unknown = null;
let bundle: unknown = null;

vi.mock("@/lib/strategy/pools/reads", () => ({
  readStrategyLiquidity: () => liquidity
    ? Promise.resolve(liquidity)
    : Promise.reject(new Error("no node in this test")),
  cvaShareOfMarket: () => null,
}));
vi.mock("@/lib/strategy/pools/performance", async (orig) => ({
  // The REAL pickLongest — the annualization is the thing under test, so
  // stubbing it would certify arithmetic nobody ran.
  ...(await orig<Record<string, unknown>>()),
  fetchPerformanceBundle: () => bundle
    ? Promise.resolve(bundle)
    : Promise.reject(new Error("no bundle in this test")),
  benchmarkLabel: () => "vs 50/50 geometric benchmark",
  marketKey: (id: number) => `market-${id}`,
  cvaKey: (id: number) => `cva-${id}`,
}));

/** Index series shaped like the real bundle: both start at 1.0. */
const series = (productPct: number, holdPct: number, n = 6) =>
  Array.from({ length: n }, (_, k) => ({
    ts: 1_790_000_000 + k * 86_400,
    product: 1 + (productPct / 100) * (k / (n - 1)),
    hold: 1 + (holdPct / 100) * (k / (n - 1)),
  }));

/** The vault's real shape on 2026-10-23, with a position added. */
const LIQUIDITY = {
  markets: [],
  cva: {
    navUsd: 1557.42,
    allocations: [{ marketId: 1 }, { marketId: 2 }],
    totalMarkets: 2,
    yourShares: 5.879,
    totalShares: 1400.654055,
    navPerShare: 1.190677,
    yourUsd: 6.999,
  },
  totals: { totalUsd: 4689, directUsd: 3132, viaCvaUsd: 1557 },
  algoUsd: 0.1234,
};
const BUNDLE = {
  asOf: 1792800000, updatedAt: 1792800000, expiresAt: 1792929600,
  sourceRound: 66274546, stale: false,
  byKey: {
    "cva-3690309167": {
      income: { totalPct: 7.57, feePct: 1.52, yieldPct: 6.05, feeUsd7d: 0.26,
        yieldUsd7d: 1.67, windowStart: 0, windowEnd: 0, missingEvents: 0 },
      ret: { period: "30d", productPct: 5.64, holdPct: -4, vsHoldingPoints: 9.64,
        benchmarkKind: "geometric_mean_50_50", points: 30, days: 29, hasGaps: false, series: series(5.64, -4) },
      retUnavailableReason: null,
      // Real spans from the live bundle on 2026-10-28.
      returns: {
        "7d":  { period: "7d",  productPct: 3.70,  holdPct: -4.49, vsHoldingPoints: 8.19,
          benchmarkKind: "geometric_mean_50_50", points: 7,  days: 6,  hasGaps: false },
        "30d": { period: "30d", productPct: -2.38, holdPct: -12.42, vsHoldingPoints: 10.04,
          benchmarkKind: "geometric_mean_50_50", points: 30, days: 29, hasGaps: false, series: series(-2.38, -12.42) },
        "90d": { period: "90d", productPct: 17.00, holdPct: 5.63, vsHoldingPoints: 11.37,
          benchmarkKind: "geometric_mean_50_50", points: 43, days: 55, hasGaps: true, series: series(17.00, 5.63) },
      },
      reasons: {},
    },
  },
};

// The ALGO price comes from Coinbase before anything else is read, so it is
// stubbed rather than reached — an unstubbed fetch makes `load` throw and the
// page render its error state regardless of what the read mocks return.
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ price: "0.1234" }) }),
  ));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  liquidity = null;
  bundle = null;
});

async function mount(as: "visitor" | "admin" | "disconnected") {
  wallet = as === "disconnected"
    ? { address: null, isConnected: false }
    : { address: as === "admin" ? ADMIN : VISITOR, isConnected: true };
  const { LiquidityView } = await import("./LiquidityView");
  render(<LiquidityView />);
  await waitFor(() => {
    expect(screen.getByRole("heading", { name: "C-Vault Strategy" })).toBeTruthy();
  });
}

describe("the public page shows the C-Vault only", () => {
  it("renders the C-Vault for a disconnected visitor", async () => {
    await mount("disconnected");
    expect(screen.getByRole("heading", { name: "C-Vault Strategy" })).toBeTruthy();
  });

  it("does NOT render the direct pool cards for a visitor", async () => {
    await mount("visitor");
    // The card headings, not the words anywhere on the page — the disclaimer
    // and the totals legitimately mention the markets.
    expect(screen.queryByRole("heading", { name: "ALGO/USD" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "BTC/USD" })).toBeNull();
    // And no way to act on them.
    expect(screen.queryByText("Add or remove liquidity")).toBeNull();
  });

  it("offers a visitor no admin control at all", async () => {
    await mount("visitor");
    expect(screen.queryByRole("button", { name: /Direct pools/ })).toBeNull();
  });

  it("shows no page-level totals at all", async () => {
    /**
     * This used to assert that the headline split did not say "direct" to a
     * visitor who could not see the direct pools. The split is gone with the
     * rest of the PEX-specific page chrome — the page hosts more than PEX now,
     * so one "total liquidity" across venues would sum unlike things. The
     * assertion is kept, aimed at the whole page rather than the box, so
     * reintroducing a cross-venue total trips it.
     */
    liquidity = LIQUIDITY;
    await mount("visitor");
    await waitFor(() => expect(screen.getByText("Pool liquidity")).toBeTruthy());
    const body = (document.body.textContent ?? "").replace(/\s+/g, " ");
    expect(body).not.toMatch(/Total liquidity/i);
    expect(body).not.toMatch(/Fees to date/i);
    expect(body).not.toMatch(/\bdirect ·/);
  });

  it("has no page heading — the splash carries the name", async () => {
    await mount("visitor");
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });
});

describe("the admin can open them", () => {
  it("shows the control but keeps the pools closed until pressed", async () => {
    await mount("admin");
    const btn = screen.getByRole("button", { name: /Direct pools/ });
    expect(btn).toBeTruthy();
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    // Closed by default: opening admin tools should be deliberate.
    expect(screen.queryByRole("heading", { name: "ALGO/USD" })).toBeNull();
  });

  it("reveals both pool cards when pressed, and hides them again", async () => {
    await mount("admin");
    const btn = screen.getByRole("button", { name: /Direct pools/ });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "ALGO/USD" })).toBeTruthy();
    });
    expect(screen.getByRole("heading", { name: "BTC/USD" })).toBeTruthy();
    expect(btn.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(btn);
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "ALGO/USD" })).toBeNull();
    });
  });
});

/**
 * The card itself.
 *
 * ── Why the share stats are asserted against a REAL read ──
 * With the read rejecting, every one of them renders "—", so a test over the
 * default mock would pass whether the wiring existed or not. These use the
 * vault's actual numbers from 2026-10-23: $1,557.42 of NAV over 1,400.654
 * shares at $1.190677 each.
 */
describe("the C-Vault card", () => {
  it("carries the display heading", async () => {
    await mount("visitor");
    const h = screen.getByRole("heading", { name: "C-Vault Strategy" });
    // The glow is the point of the heading treatment — a plain h2 is the
    // regression, and it is invisible in a text-only assertion.
    //
    // `glow-text-card`, NOT `magnet-glow-soft` (a drop-shadow filter for the
    // hero logo, no visible halo here) and NOT `glow-text` (radii tuned for a
    // 48-60px splash title, which dilute at heading size). Pinned to the class
    // that actually renders a glow at this size.
    expect(h.className).toContain("glow-text-card");
    expect(h.className).toContain("font-display");
  });

  it("offers the About explainer to a public visitor", async () => {
    // Not admin-gated: a visitor who cannot see the direct pools is exactly
    // the reader who needs this.
    await mount("visitor");
    expect(screen.getByRole("button", { name: /Learn more/ })).toBeTruthy();
  });

  it("headlines the annualized return, derived from the LONGEST window", async () => {
    bundle = BUNDLE;
    liquidity = LIQUIDITY;
    await mount("visitor");
    // 17.00% realised over 55 days compounds to +183%. Computed by the real
    // pickLongest, not stubbed — the arithmetic is the thing under test.
    await waitFor(() => expect(screen.getByText("+183%")).toBeTruthy());
    const figure = screen.getByText("+183%");
    expect(figure.className).toContain("text-green-400");
    expect(figure.className).toContain("font-mono");
    expect(screen.getByText(/Derived from past 55 days performance/)).toBeTruthy();
  });

  it("never annualizes a short window, however good it looks", async () => {
    /**
     * The 7-day window here is +3.70%, which annualizes to +812%. Picking it
     * would be the single most flattering number available and the least
     * defensible. The headline must come from the 55-day window.
     */
    bundle = BUNDLE;
    liquidity = LIQUIDITY;
    await mount("visitor");
    await waitFor(() => expect(screen.getByText("+183%")).toBeTruthy());
    const body = (document.body.textContent ?? "").replace(/\s+/g, " ");
    expect(body).not.toContain("812");
  });

  it("never shows the headline without its basis", async () => {
    /**
     * The derivation lives in the LABEL now rather than a sentence beneath,
     * which makes it inseparable from the figure: "+183%" alone is a claim,
     * "+183% derived from past 55 days performance" is a measurement with its
     * basis attached. The realised ladder and the benchmark chart moved to the
     * About modal.
     */
    bundle = BUNDLE;
    liquidity = LIQUIDITY;
    await mount("visitor");
    await waitFor(() => expect(screen.getByText("+183%")).toBeTruthy());
    // Label and figure read as one statement; the derivation is the subtext
    // directly beneath. Asserted via the shared parent so the three cannot be
    // separated — that is how a basis drifts away from its figure.
    const label = screen.getByText("12 Month Annualized Return:");
    expect(label.parentElement?.textContent).toContain("+183%");
    expect(label.parentElement?.nextElementSibling?.textContent)
      .toMatch(/Derived from past 55 days performance/);
  });

  it("timestamps the two sources separately, because they differ", async () => {
    /**
     * Chain reads are seconds old; PEX's bundle is a daily snapshot. Measured
     * 2026-10-28 the gap was 16 hours. A single "updated just now" would be
     * false for the half of the card carrying the headline number.
     */
    bundle = BUNDLE;
    liquidity = LIQUIDITY;
    await mount("visitor");
    await waitFor(() => expect(screen.getByText("+183%")).toBeTruthy());
    const line = screen.getByText(/Your position and pool figures read/);
    expect(line.textContent).toMatch(/performance to/);
    // The bundle's own as_of, not the read time.
    expect(line.textContent).toMatch(/\d+ \w+/);
  });

  it("carries ONE figure — the per-window ladder lives in the modal", async () => {
    // The card is the headline and its basis; the 7d/30d/90d spread, the
    // benchmark chart and the risk disclosure are one click away.
    bundle = BUNDLE;
    liquidity = LIQUIDITY;
    await mount("visitor");
    await waitFor(() => expect(screen.getByText("+183%")).toBeTruthy());
    const body = (document.body.textContent ?? "").replace(/\s+/g, " ");
    expect(body).not.toContain("Realised");
    expect(body).not.toContain("+3.70%");
    expect(body).not.toContain("-2.38%");
  });

  it("names where the return comes from, in contribution order", async () => {
    /**
     * Qualitative on the card by design — a depositor is asking what the
     * strategy is and what it returns, and every extra figure competes with
     * that. The ORDER carries the weighting: trader P&L is ~96% of what the
     * vault adds and swap fees are 0-3%, so fees go last. This page used to
     * lead with fees.
     */
    bundle = BUNDLE;
    liquidity = LIQUIDITY;
    await mount("visitor");
    await waitFor(() => expect(screen.getByText("+183%")).toBeTruthy());
    const line = screen.getByText(/Returns are generated by/);
    expect(line.textContent).toMatch(
      /opposite trade positions.*ALGO\/USDC price movement.*pool swap fees/,
    );
  });

  it("carries ONE rate — the income APR is a different quantity and lives in the modal", async () => {
    /**
     * 5.11% income against a +183% total on 2026-10-28, because income was
     * ~2.6% of the return. Two rates side by side invited reading the small
     * one as a subset of the large one in the wrong proportion.
     *
     * Asserted on the rendered element, not a substring of the page: an
     * earlier version of this test matched "7.57% APR" as a literal and kept
     * passing after the APR came BACK onto the card, because the markup had
     * split the value from its label.
     */
    bundle = BUNDLE;
    liquidity = LIQUIDITY;
    await mount("visitor");
    await waitFor(() => expect(screen.getByText("+183%")).toBeTruthy());
    expect(screen.queryByText("7.57%")).toBeNull();
    expect(screen.queryByText(/fees \+ yield/i)).toBeNull();
    expect(screen.queryByText("all sources")).toBeNull();
  });

  it("does not put the benchmark comparison on the card", async () => {
    // "+11.37pp against a geometric 50/50 benchmark" is too much to hold at a
    // glance. The About modal charts it instead, which shows the same thing
    // without asking anyone to parse percentage points.
    bundle = BUNDLE;
    liquidity = LIQUIDITY;
    await mount("visitor");
    await waitFor(() => expect(screen.getByText("+183%")).toBeTruthy());
    const body = (document.body.textContent ?? "").replace(/\s+/g, " ");
    // The FIGURE, not the letters — "Opportunities" contains "pp".
    expect(body).not.toMatch(/[+-]\d+\.\d+pp/);
    expect(body).not.toContain("Beat holding");
  });

  it("shows pool liquidity, shares outstanding and the user's own position", async () => {
    liquidity = LIQUIDITY;
    await mount("visitor");
    await waitFor(() => expect(screen.getByText("Pool liquidity")).toBeTruthy());
    const read = (label: string) =>
      screen.getByText(label).parentElement?.textContent ?? "";
    expect(read("Pool liquidity")).toContain("$1,557");
    expect(read("Shares outstanding")).toContain("1,400.65");
    expect(read("Your shares")).toContain("5.879");
    // Priced at the CONTRACT's NAV per share, the same basis the withdraw form
    // spends against — 5.879 shares x $1.190677 = $7.00.
    expect(read("Your position")).toContain("$7.00");
  });

  it("declines to value a position it could not read, rather than showing $0", async () => {
    liquidity = { ...LIQUIDITY, cva: { ...LIQUIDITY.cva, yourUsd: null, yourShares: null } };
    await mount("disconnected");
    await waitFor(() => expect(screen.getByText("Your position")).toBeTruthy());
    expect(screen.getByText("Your position").parentElement?.textContent).not.toContain("$0");
  });
});
