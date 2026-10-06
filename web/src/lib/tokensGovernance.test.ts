// UVote folded into the $U page, and the treasury promoted to a metric box.

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const magnet = readFileSync("src/components/tokens/MagnetTokenView.tsx", "utf8");
const musd = readFileSync("src/components/tokens/MusdTokenView.tsx", "utf8");
const gov = readFileSync("src/components/tokens/GovernanceSection.tsx", "utf8");
const treasury = readFileSync("src/components/tokens/TreasuryStat.tsx", "utf8");
const navbar = readFileSync("src/components/Navbar.tsx", "utf8");
const config = readFileSync("next.config.js", "utf8");

describe("the treasury is the fifth box on both tabs", () => {
  it("appears on each", () => {
    // One balance stands behind both tokens, so it is not a property of
    // whichever tab is selected.
    for (const [name, src] of [["magnet", magnet], ["musd", musd]] as const) {
      expect(src, name).toContain("<TreasuryStat />");
      expect(src, name).toContain("lg:grid-cols-5");
      expect(src, name).not.toContain("lg:grid-cols-4");
    }
  });

  it("spans the row on two columns rather than orphaning a half cell", () => {
    for (const src of [magnet, musd]) {
      expect(src).toContain('<div className="col-span-2 lg:col-span-1"><TreasuryStat /></div>');
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

describe("governance is a section of the $U tab", () => {
  it("sits on the Magnet tab, after the pools", () => {
    expect(magnet).toContain("<GovernanceSection />");
    expect(magnet.indexOf("<PoolsSection />")).toBeLessThan(magnet.indexOf("<GovernanceSection />"));
  });

  it("is not on the mUSD tab", () => {
    // Voting is denominated in $U.
    expect(musd).not.toContain("GovernanceSection");
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
    expect(box).toContain("${formatU(uBalance)} $U");
  });

  it("says something useful when no wallet is connected", () => {
    expect(gov).toContain("Connect a wallet to see your voting power");
  });

  it("keeps admin behind a pill, opt in", () => {
    expect(gov).toContain("UVOTE_ADMIN_ADDRESS");
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
