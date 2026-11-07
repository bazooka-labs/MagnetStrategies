// Governance's home, and the treasury promoted to a metric box.
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
const navbar = readFileSync("src/components/Navbar.tsx", "utf8");
const config = readFileSync("next.config.js", "utf8");

describe("the fifth box differs by view, since 2026-11-07", () => {
  /*
    It was the treasury on BOTH, and this block asserted that. The treasury
    is USDC available for liquidity — a fact about the protocol's balance
    sheet rather than about $U — so it stayed on the mUSD page and the Magnet
    page took a year-to-date return instead, which is what a reader of that
    page is actually asking.

    Both views still run five across with the fifth cell spanning two columns
    on the narrow breakpoint, because that part was never about which figure
    sits in it.
  */
  it("keeps the treasury on mUSD and NOT on Magnet", () => {
    expect(musd).toContain("<TreasuryStat />");
    expect(magnet).not.toContain("<TreasuryStat />");
    // The import has to go with it, or the next edit re-adds the element
    // against a still-valid symbol.
    expect(magnet).not.toContain('from "@/components/tokens/TreasuryStat"');
  });

  it("puts the YTD return on Magnet and NOT on mUSD", () => {
    expect(magnet).toContain('label="YTD vs ALGO"');
    expect(musd).not.toContain("YTD");
  });

  it("measures it in ALGO, not dollars", () => {
    // The protocol's goal is to beat holding vanilla ALGO. A dollar figure
    // answers a different question and flatters it in exactly the month it
    // most needs to be honest — when ALGO itself rose further.
    expect(magnet).toContain("ALGO since");
    expect(magnet).not.toMatch(/label="YTD[^"]*\$"/);
  });

  it("keeps both rows five across, fifth cell spanning", () => {
    for (const [name, src] of [["magnet", magnet], ["musd", musd]] as const) {
      expect(src, name).toContain("lg:grid-cols-5");
      expect(src, name).not.toContain("lg:grid-cols-4");
      expect(src, name).toContain('className="col-span-2 lg:col-span-1"');
    }
  });

  it("takes its colour from the shared table", () => {
    // A hardcoded class here is how the row drifts the first time the palette
    // moves — the same reason TvlRankStat imports it.
    expect(treasury).toContain("STAT_TONES.green");
    expect(treasury).not.toMatch(/text-green-\d00/);
  });

  it("says which number it is", () => {
    // The account holds ALGO too. Widening the figure to a portfolio total
    // while keeping the label "Treasury" would make a bigger number by
    // changing the question.
    expect(treasury).toContain("getTreasuryUsdc");
    expect(treasury).toContain("USDC for liquidity");
  });

  it("renders without a wallet", () => {
    // It builds its own client: this box exists for a visitor who has never
    // connected anything.
    expect(treasury).toContain("new algosdk.Algodv2");
    expect(treasury).not.toContain("useWallet");
  });

  it("does not also show the balance inside governance", () => {
    // It was a panel there. Two copies on one page invite the reader to ask
    // which is current.
    expect(gov).not.toContain("getTreasuryUsdc");
    expect(gov).not.toContain("TREASURY_ADDRESS");
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

  it("puts vote power inside that explanation", () => {
    // Next to the sentence that says one whole token is one vote. As a lone
    // pill in the header it was a figure without a unit.
    const box = gov.slice(gov.indexOf("How voting works"), gov.indexOf("Live proposals"));
    expect(box).toContain("Current vote power");
    expect(box).toContain("${formatWeight(MVOTE, balance)} ${MVOTE.unit}");
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

  it("keeps the modal on mUSD, which did NOT change", () => {
    // The divergence is deliberate and one-sided; asserting only the Magnet
    // half would pass with mUSD's modal removed too.
    expect(musd).toContain('triggerLabel="About mUSD"');
    expect(musd).toContain('from "@/components/tokens/AboutModal"');
  });

  it("puts the pill beside About mUSD in the mUSD hero", () => {
    const about = musd.indexOf('triggerLabel="About mUSD"');
    const pillAt = musd.indexOf("<LiveProposalsPill />");
    expect(about).toBeGreaterThan(-1);
    expect(pillAt).toBeGreaterThan(about);
    // Same flex row: no closing div between the two.
    expect(musd.slice(musd.indexOf("</AboutModal>", about), pillAt))
      .not.toContain("</div>");
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
