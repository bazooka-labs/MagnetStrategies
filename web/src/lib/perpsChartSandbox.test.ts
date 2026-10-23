/**
 * The one property that makes the TradingView frame worth having.
 *
 * ── What changed on 2026-10-23, and why the rule is now a PAIR ──
 * Until today the advanced chart loaded TradingView's script into a `srcdoc`
 * document with an opaque origin. That isolated it, and it also broke it: an
 * opaque origin makes `document.cookie` THROW, TradingView reads it while
 * building their WebSocket URL, and the panel rendered chrome with no candles.
 *
 * The frame now loads their widget page DIRECTLY, at its own origin. Isolation
 * comes from the same-origin policy instead of from an opaque sandbox, which is
 * both stronger and standard — and their loader script never enters our
 * document at all, so the thing the sandbox was containing is simply absent.
 *
 * That makes `allow-same-origin` safe, but **only in "url" mode**:
 *
 *   srcdoc + allow-same-origin     frame inherits OUR origin -> a third-party
 *                                  script shares the realm that signs
 *                                  transactions. Catastrophic.
 *   cross-origin URL + same token  frame keeps TradingView's origin. No reach
 *                                  into us.
 *
 * So the invariant is no longer "never grant the token". It is **the token and
 * the mode move together**, which is what these tests bind.
 *
 * Why bind it at all, when every change goes through one author: the likely
 * author of a regression here is a future session with no memory of this one,
 * and two commits before this change that author injected its own script into
 * the srcdoc to detect a blank panel. That instinct plus a token already
 * sitting in the constant is the whole failure. A comment would not stop it;
 * a red build will.
 *
 * Known limit, stated rather than implied: this binds the CONSTANT and the
 * MODE, not the attribute actually set on the element.
 * `setAttribute("sandbox", TV_SANDBOX + " allow-top-navigation")` would still
 * pass. Binding the real attribute means mounting the component in jsdom and
 * reading `querySelector("iframe")` — the repo has the harness (see
 * FormSection.test.tsx) and that is the stronger test to write next.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  TV_SANDBOX, TV_FRAME_MODE, TV_FRAME_ORIGIN, tvFrameSrc,
} from "@/components/strategy/perps/PerpsChartPanel";

const PANEL = "src/components/strategy/perps/PerpsChartPanel.tsx";

describe("the sandbox token and the frame mode move together", () => {
  it("THE RULE: allow-same-origin is permitted only when the frame loads a URL", () => {
    // The one assertion that matters. Either mode is a valid choice; the
    // combination of srcdoc AND the token is the loophole, and it is the
    // combination that is forbidden.
    const sameOrigin = TV_SANDBOX.split(/\s+/).includes("allow-same-origin");
    if (TV_FRAME_MODE === "srcdoc") {
      expect(sameOrigin,
        "srcdoc + allow-same-origin makes the frame inherit our origin — "
        + "remove the token or keep mode 'url'").toBe(false);
    } else {
      // In url mode the token is what lets the widget read its OWN cookies.
      expect(sameOrigin).toBe(true);
    }
  });

  it("the source agrees with the mode — no srcdoc assignment while in url mode", () => {
    // Asserted against the file because the mode is a constant and the
    // assignment is code: a `frame.srcdoc = ...` left behind would make the
    // constant a lie. Matches an assignment, not the word in prose.
    const src = readFileSync(PANEL, "utf8");
    const assignsSrcdoc = /\bframe\.srcdoc\s*=/.test(src);
    expect(assignsSrcdoc).toBe(TV_FRAME_MODE === "srcdoc");
  });

  it("frames the widget host itself, not a page we assemble", () => {
    expect(TV_FRAME_ORIGIN).toBe("https://www.tradingview-widget.com");
    const url = tvFrameSrc('{"symbol":"COINBASE:ALGOUSD"}');
    expect(url.startsWith(`${TV_FRAME_ORIGIN}/embed-widget/advanced-chart/`)).toBe(true);
    // The config travels in the fragment, so it never reaches a server and is
    // never parsed as script by us.
    expect(url).toContain("#");
    expect(url.split("#")[1]).toBe(encodeURIComponent('{"symbol":"COINBASE:ALGOUSD"}'));
  });

  it("does not load TradingView's loader script into our own document", () => {
    // The script that the old sandbox existed to contain. Its absence is the
    // actual security improvement here, so it is pinned.
    const src = readFileSync(PANEL, "utf8");
    expect(/document\.createElement\(["']script["']\)/.test(src)).toBe(false);
  });

  it("still grants the scripts the widget needs", () => {
    // Without allow-scripts the frame renders nothing and the panel falls back
    // forever — the isolation would be real but the feature dead.
    expect(TV_SANDBOX.split(/\s+/)).toContain("allow-scripts");
  });

  it("grants nothing beyond those two tokens", () => {
    // Allow-list rather than deny-list: a token added casually should fail here
    // rather than quietly widen what the frame may do. Top-level navigation,
    // popups, forms, downloads, modals and pointer lock all stay denied.
    const ALLOWED = new Set(["allow-scripts", "allow-same-origin"]);
    for (const token of TV_SANDBOX.split(/\s+/).filter(Boolean)) {
      expect(ALLOWED.has(token), `unexpected sandbox token: ${token}`).toBe(true);
    }
  });

  it("keeps the fallback, so a blocked frame does not strand the panel", () => {
    const src = readFileSync(PANEL, "utf8");
    expect(src).toContain("fallBackToBasic");
    // The timeout is the only detector left now that the frame is cross-origin,
    // so its absence would mean a blocked widget shows an empty box forever.
    expect(/setTimeout\([^)]*\n?[^)]*\}, 20_000\)/.test(src)
      || src.includes("}, 20_000)")).toBe(true);
  });
});
