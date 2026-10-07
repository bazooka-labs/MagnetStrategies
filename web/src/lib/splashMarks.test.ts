// What each arrival puts on screen.
//
// Three splashes now share one component, and the thing that distinguishes them
// is the mark. These pin the decisions so a later edit has to mean them.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tokens = readFileSync("src/components/tokens/TokensSplash.tsx", "utf8");
const trade = readFileSync("src/components/strategy/TradeSplash.tsx", "utf8");
const magnetfi = readFileSync("src/components/magnetfi/MagnetFiSplash.tsx", "utf8");

describe("each arrival is its own image", () => {
  it("gives the Magnet mark to /tokens and the wordmark to MagnetFi", () => {
    expect(tokens).toContain('src="/magnet-mark.png"');
    expect(magnetfi).toContain('src="/magnetfi-logo.png"');
  });

  it("uses the TIGHT crop on the splash and leaves the square one alone", () => {
    // /magnet-icon.png is 56% transparent by height. At splash scale that
    // padding became a visible gap between the mark and the rule; the navbar
    // and footer still want the padded square.
    // The comment NAMES the square file to record why it is not used, so this
    // checks the src attribute rather than the path.
    expect(tokens).not.toContain('src="/magnet-icon.png"');
    expect(tokens).toContain("width={316}");
    expect(tokens).toContain("height={222}");
  });

  it("leaves the Trading Terminal as type alone", () => {
    // The mark moved to /tokens, so the two are not the same image with
    // different captions.
    expect(trade).not.toContain("/magnet-icon.png");
    expect(trade).toContain("Trading Terminal");
  });

  it("does not leave Image imported where nothing renders one", () => {
    // A dead import under a comment describing what it used to do is this
    // codebase's most repeated defect.
    expect(trade).not.toMatch(/^import Image/m);
    expect(tokens).toMatch(/^import Image/m);
  });

  it("keeps the no-wordmark rule for the terminal", () => {
    // Removing the icon must not read as licence to add a "MagnetTrade" mark:
    // we write no exchange contracts and custody no funds.
    expect(trade).toContain("MagnetTrade");
    expect(trade).toContain("so the product name is set in type");
  });
});

describe("timings stay deliberate", () => {
  it("holds the terminal longer than the default", () => {
    expect(trade).toContain("durationMs={2500}");
  });

  it("leaves the other two on the shared default", () => {
    // A mark, a rule and one line — the weight ArrivalSplash's 2s was set for.
    expect(tokens).not.toContain("durationMs");
    expect(magnetfi).not.toContain("durationMs");
  });
});
