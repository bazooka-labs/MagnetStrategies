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

  it("explains itself in the page's own informative-text style", () => {
    // It was a 90-word paragraph under a white heading — the only thing on
    // this page that explained itself that way.
    expect(gov).toContain("<AboutModal triggerLabel=\"How voting works\"");
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
