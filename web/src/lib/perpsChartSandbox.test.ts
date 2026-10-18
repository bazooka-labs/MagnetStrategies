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
import { TV_SANDBOX } from "@/components/strategy/perps/PerpsChartPanel";

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
