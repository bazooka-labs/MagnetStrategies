/**
 * The one property that makes the TradingView frame worth having.
 *
 * The advanced chart loads a third-party script from s3.tradingview.com. Until
 * 2026-10-17 that script ran in the page's own realm — the realm that builds
 * and signs perps transactions — so it could patch the signer after
 * perpsGroup.ts's assertions had passed, or patch the assertions. It now runs
 * in a `srcdoc` iframe with an opaque origin.
 *
 * `allow-same-origin` is what would silently undo that: combined with `srcdoc`
 * the frame inherits this document's origin and the isolation becomes
 * decorative while still LOOKING sandboxed. That is the failure this binds —
 * asserted against the exported constant, not a grep of the file, because the
 * file's comments mention the token repeatedly and a text match would pass on
 * those alone.
 *
 * Known limit, stated rather than implied: this binds the CONSTANT, not the
 * attribute. `setAttribute("sandbox", TV_SANDBOX + " allow-same-origin")`
 * would still pass all three. Binding the real attribute means mounting the
 * component in jsdom and reading `querySelector("iframe")` — the repo has the
 * harness for it (see FormSection.test.tsx) and that is the stronger test to
 * write next.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { TV_SANDBOX, TV_SIGNALS } from "@/components/strategy/perps/PerpsChartPanel";

const PANEL = "src/components/strategy/perps/PerpsChartPanel.tsx";

describe("the TradingView frame stays cross-origin", () => {
  it("never grants allow-same-origin", () => {
    expect(TV_SANDBOX).not.toContain("allow-same-origin");
  });

  it("still grants the scripts the widget needs", () => {
    // Without allow-scripts the frame renders nothing and the panel would fall
    // back forever — the isolation would be real but the feature dead.
    expect(TV_SANDBOX.split(/\s+/)).toContain("allow-scripts");
  });

  it("grants nothing that reaches this document", () => {
    // Allow-list rather than deny-list: a future token added casually should
    // fail here rather than quietly widen the frame's reach.
    const ALLOWED = new Set(["allow-scripts"]);
    for (const token of TV_SANDBOX.split(/\s+/).filter(Boolean)) {
      expect(ALLOWED.has(token), `unexpected sandbox token: ${token}`).toBe(true);
    }
  });
});

describe("the advanced chart's draw detection", () => {
  /**
   * A real white screen on 2026-10-23 is why these exist.
   *
   * `tv-ok` fires on the LOADER's onload — the script fetched. The loader then
   * creates its own cross-origin frame, and when that drew nothing the panel
   * sat blank forever, because `tv-ok` had already disarmed the fallback. The
   * component's own comment had predicted this and called it unverifiable
   * without a real browser; the frame can in fact watch its OWN DOM, which is
   * what `tv-drawn` / `tv-blank` do.
   */
  it("treats only tv-drawn as success, never tv-ok", () => {
    const src = readFileSync(PANEL, "utf8");
    // The switch must not settle on tv-ok. Asserted on the real source because
    // this is a one-line regression away: adding `settled = true` to that case
    // restores the blank panel exactly.
    const okCase = src.slice(src.indexOf('case "tv-ok"'));
    const nextCase = okCase.indexOf("break;");
    expect(okCase.slice(0, nextCase)).not.toContain("settled = true");
    expect(okCase.slice(0, nextCase)).not.toContain("fallBackToBasic");
  });

  it("falls back on tv-blank, which is the white screen reporting itself", () => {
    const src = readFileSync(PANEL, "utf8");
    const blankCase = src.slice(src.indexOf('case "tv-blank"'));
    const body = blankCase.slice(0, blankCase.indexOf("break;"));
    expect(body).toContain("fallBackToBasic");
  });

  it("the frame polls for a laid-out child and reports either way", () => {
    const src = readFileSync(PANEL, "utf8");
    // Inside the srcdoc, so it cannot be unit-tested by mounting — but its
    // absence is what the bug was, so its presence is pinned.
    expect(src).toContain("tv-drawn");
    expect(src).toContain("tv-blank");
    expect(src).toContain("clientHeight");
  });

  it("gives up polling before the parent's timeout, so the cause is reported", () => {
    const src = readFileSync(PANEL, "utf8");
    const ms = Number(/DRAW_POLL_MS = (\d+)/.exec(src)?.[1]);
    const polls = Number(/DRAW_POLLS = (\d+)/.exec(src)?.[1]);
    const timeoutMs = Number(/\}, (\d+)_000\)/.exec(src)?.[1]) * 1000;
    expect(ms * polls).toBeLessThan(timeoutMs);
    // Otherwise the generic timeout fires first and the console says nothing
    // about WHY, which is the diagnostic this incident needed.
    expect(timeoutMs - ms * polls).toBeGreaterThan(2_000);
  });

  it("still only sends strings it declares", () => {
    const src = readFileSync(PANEL, "utf8");
    for (const sig of ["tv-ok", "tv-fail", "tv-drawn", "tv-blank"]) {
      expect(src).toContain(`postMessage('${sig}'`);
    }
    expect(TV_SIGNALS).toEqual(["tv-ok", "tv-fail", "tv-drawn", "tv-blank"]);
  });
});
