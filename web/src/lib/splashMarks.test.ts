// What each arrival puts on screen.
//
// Three splashes now share one component, and the thing that distinguishes them
// is the mark. These pin the decisions so a later edit has to mean them.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_MS } from "@/components/ArrivalSplash";

const tokens = readFileSync("src/components/tokens/TokensSplash.tsx", "utf8");
const trade = readFileSync("src/components/strategy/TradeSplash.tsx", "utf8");
const magnetfi = readFileSync("src/components/magnetfi/MagnetFiSplash.tsx", "utf8");
const strategy = readFileSync("src/components/liquidity/StrategySplash.tsx", "utf8");

describe("each arrival is its own image", () => {
  it("gives the $U mark to /tokens and the wordmark to MagnetFi", () => {
    // /tokens leads with the token's own artwork, not the organisation's "m".
    expect(tokens).toContain('src="/tokens/u-mark.png"');
    expect(magnetfi).toContain('src="/magnetfi-logo.png"');
  });

  it("uses a TIGHT crop on the splash and leaves the padded files alone", () => {
    // Both candidates for this slot ship with transparent padding —
    // /magnet-icon.png is 56% transparent by height, and the ASA png is
    // 307x365 of content on a 521x479 canvas. At splash scale that padding
    // becomes a visible gap between the mark and the rule, so the splash gets
    // a cropped asset while the navbar keeps the padded square.
    // The comments NAME the files not used, so this checks src, not the path.
    expect(tokens).not.toContain('src="/magnet-icon.png"');
    expect(tokens).not.toContain('src="/tokens/u.png"');
    // The crop's own dimensions — wrong numbers here mean a padded canvas crept
    // back in and the intrinsic aspect no longer matches the file.
    expect(tokens).toContain("width={307}");
    expect(tokens).toContain("height={365}");
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
  it("runs all three arrivals on the one shared duration", () => {
    // The terminal used to hold 2500 against the others' 2000, for a fourth
    // element it no longer has. Nobody reading three splashes wants to discover
    // that one is longer, so there is a single number now and no overrides —
    // which is what these assertions guard.
    for (const src of [tokens, magnetfi, trade]) {
      expect(src).not.toContain("durationMs");
    }
  });

  it("keeps that duration at 2.5s", () => {
    // The VALUE, imported — not a grep for the literal in the source. A comment
    // mentioning the number would satisfy a text match while the constant said
    // something else entirely.
    expect(DEFAULT_MS).toBe(2500);
  });
});

describe("the Strategy arrival", () => {
  it("uses the house banner, not a product mark", () => {
    // /tokens leads with the $U mark and /magnetfi with its wordmark because
    // each stands for one asset or protocol we wrote. Strategy is a shelf —
    // PEX pools today, more sections behind its tab bar — so it carries the
    // organisation's own banner instead.
    expect(strategy).toContain('src="/magnet-wordmark-tight.png"');
  });

  it("uses the TIGHT crop, not the padded canvas", () => {
    // /magnet-wordmark.png is an 877x284 canvas holding an 815x226 mark,
    // padded unevenly. At splash scale that dead space becomes a visible gap
    // between the mark and the rule — the same defect /tokens hit.
    expect(strategy).not.toContain('src="/magnet-wordmark.png"');
    expect(strategy).toContain("width={815}");
    expect(strategy).toContain("height={226}");
  });

  /**
   * The className of the mark, not the whole file.
   *
   * These assertions are about what the <Image> actually carries, and a
   * whole-file grep cannot tell that from prose ABOUT it — the first version
   * of the glow test below failed because this file's own comment explains why
   * MagnetFi's inline `drop-shadow-[...]` is the outlier, and the grep matched
   * the explanation. Same defect this repo has hit four times now.
   */
  const markClass = (src: string): string => {
    const m = /className="([^"]*)"\s*\/>/.exec(src);
    if (!m) throw new Error("no mark className found — did the splash stop rendering an Image?");
    return m[1];
  };

  it("sizes to MagnetFi's arrival exactly", () => {
    // The two wordmark arrivals. Equal width reads as equal prominence; this
    // shipped 7% wider and 21% taller because the aspect ratios differ
    // (3.61:1 against 4.09:1). Asserted against MagnetFi's own classes so the
    // two cannot drift apart silently.
    const mine = markClass(strategy);
    const theirs = markClass(magnetfi);
    for (const cls of ["w-[17rem]", "max-w-[72vw]", "sm:w-[23rem]", "lg:w-[28rem]"]) {
      expect(mine, `strategy: ${cls}`).toContain(cls);
      expect(theirs, `magnetfi: ${cls}`).toContain(cls);
    }
  });

  it("glows with the shared class rather than an inline one-off", () => {
    // magnet-glow-soft is what the landing page puts on this exact asset and
    // what TokensSplash uses. MagnetFi's inline drop-shadow is the outlier.
    const mine = markClass(strategy);
    expect(mine).toContain("magnet-glow-soft");
    expect(markClass(tokens)).toContain("magnet-glow-soft");
    expect(mine).not.toContain("drop-shadow-[");
  });

  it("runs on the shared duration with no override", () => {
    expect(strategy).not.toContain("durationMs");
  });
});
