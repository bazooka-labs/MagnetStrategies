// Governance's home, and where the treasury box lives.
//
// ── What moved on 2026-11-04, and why this file was rewritten ─────────────
// Governance was a SECTION at the foot of the $U tab of /tokens. $U is now the
// "Magnet Token" pill on /strategy, and governance is the "Governance" pill on
// /tokens, which is the mUSD page.
//
// Two assertions here survived that move and would have gone green for ever
// while describing the opposite of the truth — `toContain("<GovernanceSection
// />")` against a file that no longer renders it fails loudly, but
// `not.toContain("GovernanceSection")` against the mUSD view passed BEFORE the
// move and passes after it for a different reason. Both directions are now
// pinned against the file that actually composes each page.

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const magnet = readFileSync("src/components/tokens/MagnetTokenView.tsx", "utf8");
const musd = readFileSync("src/components/tokens/MusdTokenView.tsx", "utf8");
/** The two ROUTES, which is where each view is now composed. */
const tokensRoute = readFileSync("src/app/tokens/page.tsx", "utf8");
const strategyRoute = readFileSync("src/app/strategy/page.tsx", "utf8");
const gov = readFileSync("src/components/tokens/GovernanceSection.tsx", "utf8");
const treasury = readFileSync("src/components/tokens/TreasuryStat.tsx", "utf8");
const govFigure = readFileSync("src/components/tokens/GovFigure.tsx", "utf8");
const navbar = readFileSync("src/components/Navbar.tsx", "utf8");
const config = readFileSync("next.config.js", "utf8");

describe("the mUSD page wires each pill to its own view", () => {
  const page = readFileSync("src/app/tokens/page.tsx", "utf8");

  /*
    Mint is the landing page — hero, About, five stats, chart, swap.
    Exchange is the trade — compact header, chart, swap. They rendered the
    SAME view with one prop different until 2026-11-07.

    This is asserted at the wiring because the cheapest way to undo the
    split is one line here: point `exchangeView` back at `MusdTokenView`.
    It compiles, and every component test still passes — confirmed by
    mutation, which is why this block exists.
  */
  it("gives Exchange its own component, not the full view with a flag", () => {
    expect(page).toContain("exchangeView={<MusdExchangeView");
    expect(page).not.toMatch(/exchangeView=\{<MusdTokenView/);
  });

  it("keeps Mint on the full landing view", () => {
    expect(page).toContain("mintView={<MusdTokenView");
    expect(page).toContain('swapMode="mint"');
  });

  it("imports both, so neither is wired by accident", () => {
    expect(page).toContain('from "@/components/tokens/MusdExchangeView"');
    expect(page).toContain('from "@/components/tokens/MusdTokenView"');
  });
});

describe("the metric rows, and where the treasury went", () => {
  /*
    Both token rows are FOUR cells now.

    The treasury was the fifth on mUSD and a year-to-date return the fifth on
    Magnet. YTD came out on 2026-11-07 to stand beside the name; the treasury
    came out on 2026-11-08 into "How voting works" on the Governance pill. It
    is the balance proposals direct, not a figure about the token, and every
    cell left in either row is one.
  */
  it("runs BOTH rows four across, with no spanning fifth", () => {
    /* The METRIC row specifically — it is the one with the cell dividers.
       A bare `lg:grid-cols-5` search also matches the chart-and-swap split
       below it, which is 3 + 2 and has nothing to do with this. */
    const metricRow = (src: string) =>
      src.split("\n").find((l) => l.includes("divide-x") && l.includes("grid-cols")) ?? "";

    for (const [name, src] of [["magnet", magnet], ["musd", musd]] as const) {
      expect(metricRow(src), name).toContain("lg:grid-cols-4");
      expect(metricRow(src), name).not.toContain("lg:grid-cols-5");
      // The wrapper that let a fifth cell span two columns on the narrow
      // breakpoint. Left behind, it is a lone wide cell under a 2x2.
      expect(src, name).not.toContain('className="col-span-2 lg:col-span-1"');
    }
  });

  it("puts the YTD return on Magnet and NOT on mUSD", () => {
    // It left the metric row entirely later the same day — see above — so
    // this asserts the figure is on the page, not which element holds it.
    expect(magnet).toContain("YTD vs ALGO");
    // The rendered label, not the bare acronym: a prose comment on the mUSD
    // view mentions the YTD box by name and a substring match caught it.
    expect(musd).not.toContain("YTD vs ALGO");
  });

  it("measures it in ALGO, not dollars", () => {
    // The protocol's goal is to beat holding vanilla ALGO. A dollar figure
    // answers a different question and flatters it in exactly the month it
    // most needs to be honest — when ALGO itself rose further.
    expect(magnet).toContain("ALGO since");
    expect(magnet).not.toMatch(/label="YTD[^"]*\$"/);
  });

  it("renders the treasury from governance and from NEITHER token view", () => {
    /*
      One copy on the page. Governance and the mUSD metric row are two pills
      of a single page, and a balance shown twice invites the reader to ask
      which one is current — the reason it left the governance panel the
      first time, in 2026-11.

      Asserted at the wiring because the cheapest way to undo the move is to
      drop `<TreasuryStat />` back into either row: it compiles, and it does
      not fail the rendered tests in `GovernanceFigures.test.tsx`, which look
      at the governance side only.
    */
    expect(gov).toContain("<TreasuryStat />");
    expect(gov).toContain('from "@/components/tokens/TreasuryStat"');

    for (const [name, src] of [["magnet", magnet], ["musd", musd]] as const) {
      expect(src, name).not.toContain("<TreasuryStat />");
      // The import has to go with it, or the next edit re-adds the element
      // against a still-valid symbol.
      expect(src, name).not.toContain('from "@/components/tokens/TreasuryStat"');
    }
  });

  it("takes its colour from the shared table", () => {
    // A hardcoded class here is how the palette drifts the first time it
    // moves — the same reason TvlRankStat imports it. `GovFigure` is where
    // the lookup now lives, since the box took its frame from there.
    expect(treasury).toContain('tone="green"');
    expect(treasury).not.toMatch(/text-green-\d00/);
    expect(govFigure).toContain("STAT_TONES[tone]");
    expect(govFigure).not.toMatch(/text-(green|magnet|amber|teal)-\d00/);
  });

  it("says which number it is", () => {
    // The account holds ALGO too. Widening the figure to a portfolio total
    // while keeping the label "Treasury" would make a bigger number by
    // changing the question.
    expect(treasury).toContain("getTreasuryUsdc");
    expect(treasury).toContain("USDC for liquidity");
  });

  it("renders without a wallet", () => {
    // It builds its own client: the treasury is a fact about the project,
    // not about the viewer, and a reader weighing a proposal may well not
    // have connected anything.
    expect(treasury).toContain("new algosdk.Algodv2");
    expect(treasury).not.toContain("useWallet");
  });
});

describe("governance is the mUSD page's Governance pill", () => {
  it("is composed by the /tokens route, not by either token view", () => {
    // It is a PILL now, so the route hands it to TokensView beside the
    // exchange view — it is not nested inside a token's own markup.
    expect(tokensRoute).toContain("governanceView={<GovernanceSection />}");
    expect(magnet).not.toContain("GovernanceSection");
    expect(musd).not.toContain("GovernanceSection");
  });

  it("left the Magnet Token view behind on /strategy", () => {
    /**
     * The direction that matters.
     *
     * `magnet.not.toContain("GovernanceSection")` above is true of a file that
     * never had it, so on its own it would not notice the section quietly
     * coming back to a page that no longer has an anchor for it. This pins the
     * other half: the Magnet Token view is composed by the STRATEGY route now,
     * and that route composes no governance.
     */
    expect(strategyRoute).toContain("<MagnetTokenView");
    expect(strategyRoute).not.toContain("Governance");
    expect(tokensRoute).not.toContain("MagnetTokenView");
  });

  it("no longer shares that tab with the liquidity pools", () => {
    /**
     * The $U pools moved to the Strategy page on 2026-11-04.
     *
     * This test used to assert they came BEFORE governance, by comparing
     * `indexOf`. Once the section was removed that comparison became
     * `-1 < someIndex` — true for ever, asserting nothing. A test that keeps
     * passing after the thing it describes is deleted is worse than no test,
     * so it asserts the absence instead, which is the fact that now holds.
     */
    expect(magnet).not.toContain("<PoolsSection />");
    expect(magnet).not.toContain("<LpPoolsSection />");
  });

  it("describes mUSD voting, not $U voting", () => {
    /**
     * The honesty check, inverted on 2026-11-05 when mVote shipped.
     *
     * While the contract locked $U, this asserted the page SAID so and carried
     * a "moving to mUSD" notice — because describing mUSD voting over a $U
     * contract would have put a false statement in front of someone about to
     * sign a lock. The contract now locks mUSD, so the same rule points the
     * other way: the mechanism copy must say mUSD, and the notice announcing a
     * future move must be gone.
     */
    // Anchored on the JSX heading, not on the words "How voting works" — the
    // first occurrence of those is in this component's own docstring, which
    // explains the $U era and legitimately still names it. Slicing from there
    // made this fail on the prose rather than on the page.
    const RULES_START = '<h3 className="font-display text-base font-semibold text-amber-200">How voting works</h3>';
    const rules = gov.slice(gov.indexOf(RULES_START), gov.indexOf("{/* ── Live proposals"));
    expect(rules.length).toBeGreaterThan(200);   // the anchors still match something
    expect(rules).toContain("utilizing held mUSD");
    expect(rules).toContain("one mUSD is equal to one vote");
    expect(rules).not.toContain("$U");
    expect(gov).not.toContain("Governance is moving to mUSD");
  });

  it("explains itself in a PERMANENT box, not a modal", () => {
    // It was briefly an AboutModal. Those answer a question a reader may
    // already know the answer to; this one explains a mechanism that locks
    // their tokens for seven days, and rules you must understand before acting
    // do not belong one click away.
    // The docstring still NAMES AboutModal to record why it is not used, so
    // this checks for the import and the element rather than the word.
    expect(gov).not.toContain("<AboutModal");
    expect(gov).not.toMatch(/^import .*AboutModal/m);
    expect(gov).toContain('<h3 className="font-display text-base font-semibold text-amber-200">How voting works</h3>');
    expect(gov).toContain("border-amber-400/25");
  });

  it("puts vote power inside that explanation, paired with the treasury", () => {
    // Next to the sentence that says one whole token is one vote. As a lone
    // pill in the header it was a figure without a unit. The treasury joined
    // it on 2026-11-08 for the same reason in reverse — in the metric row it
    // was a balance with no question attached.
    //
    // That the two SIT TOGETHER in one two-column row is checked against the
    // rendered tree in `GovernanceFigures.test.tsx`; this pins them to the
    // panel rather than to the page.
    const box = gov.slice(gov.indexOf("How voting works"), gov.indexOf("Live proposals"));
    expect(box).toContain("Current vote power");
    expect(box).toContain("${formatWeight(MVOTE, balance)} ${MVOTE.unit}");
    expect(box).toContain("<TreasuryStat />");
  });

  it("says something useful when no wallet is connected", () => {
    expect(gov).toContain("Connect a wallet to see your voting power");
  });

  it("keeps admin behind a pill, opt in", () => {
    expect(gov).toContain("GOVERNANCE_ADMIN_ADDRESS");
    expect(gov).toContain("const [adminOpen, setAdminOpen] = useState(false);");
    expect(gov).toContain("{isAdmin && adminOpen && (");
  });

  it("is linkable", () => {
    expect(gov).toContain('id="governance"');
  });
});

describe("live proposals and voting history", () => {
  it("names the empty case rather than leaving a blank", () => {
    // A reader who cannot tell "nothing to vote on" from "this is broken"
    // assumes the latter.
    expect(gov).toContain("Live proposals");
    expect(gov).toContain("Nothing to vote on right now");
    expect(gov).toContain("There are no live proposals.");
  });

  it("calls the closed list Voting history", () => {
    expect(gov).toContain("Voting history");
    expect(gov).not.toMatch(/>\s*Closed\s*</);
  });

  it("stacks full width rather than two across", () => {
    // A proposal is a question, its choices and a tally; at half width the
    // question wrapped before the reader reached the options.
    expect(gov).not.toContain("lg:grid-cols-2");
    expect(gov).toContain('<div className="space-y-4">');
  });

  it("orders each list by what that list is for", () => {
    // Live: the nearest deadline is the one needing a decision.
    expect(gov).toContain(".sort((a, b) => a.endTime - b.endTime)");
    // History: newest result on top, growing downward into the past.
    expect(gov).toContain(".sort((a, b) => b.endTime - a.endTime)");
  });

  it("hides the history heading when there is none", () => {
    // An empty "Voting history" under an empty "Live proposals" is two
    // statements of the same nothing.
    expect(gov).toContain("{history.length > 0 && (");
  });
});

describe("the old route is retired, not orphaned", () => {
  it("no longer exists", () => {
    expect(existsSync("src/app/vote/page.tsx")).toBe(false);
  });

  it("is gone from the nav", () => {
    expect(navbar).not.toContain('href: "/vote"');
  });

  it("redirects, along with the /dao links that used to point at it", () => {
    // /dao pointed at /vote. Left alone it would now hop through a route that
    // itself redirects.
    expect(config).toContain('{ source: "/vote", destination: "/tokens#governance", permanent: true }');
    expect(config).toContain('{ source: "/dao", destination: "/tokens#governance", permanent: true }');
    expect(config).not.toContain('destination: "/vote"');
  });
});

describe("the hero points at governance", () => {
  const pill = readFileSync("src/components/tokens/LiveProposalsPill.tsx", "utf8");
  const store = readFileSync("src/hooks/useGovernanceProposals.ts", "utf8");
  const musd = readFileSync("src/components/tokens/MusdTokenView.tsx", "utf8");

  it("uses the full path, not a bare fragment", () => {
    /**
     * It was `#governance`, which worked while the pill and the section shared
     * a page. They parted company on 2026-11-04, and a bare fragment pointed
     * at an element that was not in the document — which scrolls nowhere and
     * reports nothing, the quietest possible breakage.
     *
     * The pill is back on /tokens since 2026-11-07, so a fragment would work
     * again — and it still must not be one. `TokensView` selects the pill by
     * reading the hash; the browser's anchor handling has nothing to scroll
     * to, because the section does not exist until the pill is chosen.
     */
    expect(pill).toContain('href="/tokens#governance"');
    expect(pill).not.toMatch(/href="#governance"/);
  });

  it("rides in the mUSD hero, not the Magnet Token one", () => {
    /*
      Moved 2026-11-07. Voting is weighted by mUSD, so the holder who can act
      on the count is the one reading the mUSD hero — and the Governance pill
      it opens is on that same page.

      Both halves are asserted. Checking only the new home would pass with the
      pill rendered in both places, which is the likelier mistake in a move
      than failing to add it.
    */
    expect(musd).toContain("<LiveProposalsPill />");
    expect(magnet).not.toContain("<LiveProposalsPill />");
    // The import has to go with it, or the move is half-done and the next
    // edit re-adds the element against a still-valid symbol.
    expect(magnet).not.toContain('from "@/components/tokens/LiveProposalsPill"');
  });

  it("counts from the SAME list the section renders", () => {
    // Two independent fetches would be two numbers that can disagree — a pill
    // advertising a vote the list below has already closed.
    expect(pill).toContain("useGovernanceProposals");
    expect(gov).toContain("useGovernanceProposals");
    expect(gov).not.toContain("listProposals");
    expect(store).toContain("listProposals");
  });

  it("defines the count once", () => {
    expect(store).toContain("export const liveCount");
    expect(pill).toContain("liveCount(proposals)");
  });

  it("shares one request between the two consumers", () => {
    // Both mount in the same tick on first paint.
    expect(store).toContain("if (inflight) return inflight;");
  });

  /*
    What happens to the list when a read fails is NOT asserted here any more.

    It was, as `toContain("set({ ...snapshot, loading: false, incomplete: true })")`,
    and an audit was right that it proved nothing: the string says what the
    rarely-reached `.catch` branch looks like, not what the component does.
    It passed throughout the period when a partial read was silently wiping
    the list, and it broke on an unrelated edit to a neighbouring line.

    The behaviour lives in `governanceUnknowns.test.ts`, which calls
    `mergeAcrossEras` directly and fails when the carry-over is removed.
  */

  it("stays visible at zero", () => {
    // "0" says governance exists and nothing needs you — different from, and
    // more useful than, an absent pill, and the hero keeps its shape.
    expect(pill).not.toMatch(/if \(n === 0\) return null|if \(!open\) return null/);
  });

  it("has no pill column left in the Magnet hero", () => {
    /*
      This has now been rewritten twice, and both times for the same reason:
      it measured a column whose contents kept leaving.

      It began asserting an ordering between three pills, using `indexOf` of
      a string that is not in the file (-1) against one that is — so -1 <
      positive passed and it certified nothing. Rewritten on 2026-11-07 to
      assert the column held About $U. Later the same day the About modal
      opened out onto the page as an inline panel, and the column had no
      children at all.

      So it asserts the end state: no column, no trigger, and the copy that
      used to be behind the button now in the document.
    */
    expect(magnet).not.toContain("flex shrink-0 flex-col items-start gap-2 sm:items-end");
    expect(magnet).not.toContain('triggerLabel="About $U"');
    expect(magnet).not.toContain('from "@/components/tokens/AboutModal"');
    expect(magnet).toContain("What is $U?");
    expect(magnet).toContain("fixed supply of 750,000 tokens");
  });

  it("has opened its About out onto the page too, since 2026-11-07", () => {
    /*
      This asserted the OPPOSITE for most of a day: Magnet opened its About
      panel out and mUSD kept the modal, a deliberate one-sided divergence.
      The founder then asked for the same treatment here, so the two match
      again and the assertion flips with them.
    */
    for (const [name, src] of [["magnet", magnet], ["musd", musd]] as const) {
      expect(src, name).not.toContain("triggerLabel=");
      expect(src, name).not.toContain('from "@/components/tokens/AboutModal"');
    }
    expect(musd).toContain("What is mUSD?");
    expect(musd).toContain("Peg Stability Module");
  });

  it("leaves the proposals pill alone in the mUSD hero's action slot", () => {
    /*
      It shared that row with the About trigger until 2026-11-07, when the
      About content moved onto the page. The pill is what keeps the header
      balanced now — the Magnet hero had no such replacement and sat
      lopsided until its YTD box arrived.
    */
    expect(musd).toContain("<LiveProposalsPill />");
    expect(musd).not.toContain("About mUSD\"");
  });

});

describe("the metric row lines up", () => {
  const rank = readFileSync("src/components/TvlRankStat.tsx", "utf8");

  it("pins the rank cell's content to the top", () => {
    // A <button> centres its content vertically, and this is the only cell with
    // no `sub` line once the board loads — two lines against its neighbours'
    // three. Centred in a row sized by the taller cells, its heading sat below
    // every other heading.
    expect(rank).toContain("flex w-full flex-col items-start p-5");
  });
});
