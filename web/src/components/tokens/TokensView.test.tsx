// @vitest-environment jsdom

/**
 * The mUSD page's two pills, exercised rather than grepped.
 *
 * The pills themselves are a toggle and barely need a test. The deep link
 * does: `next.config.js` sends `/vote` and `/dao` to `/tokens#governance`, and
 * `LiveProposalsPill` links there from /strategy. Those destinations were
 * written when governance was a SECTION with that id, where the browser's own
 * anchor handling did the work. Behind a pill there is no element to scroll to
 * until the pill is chosen, so a fragment that used to be free now depends on
 * this component reading it — which is exactly the kind of load-bearing
 * behaviour that looks like decoration in a diff.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPEN_GOVERNANCE, TokensView } from "./TokensView";

/*
  The live count drives the Governance pill's dot, and the real hook reads
  the chain through `useWallet`, which throws outside the provider. Driven
  by hand here so the dot's two states are both reachable; DEFAULT ZERO, so
  every pre-existing test below still matches a bare "Governance" name.
*/
let liveCount = 0;
vi.mock("@/hooks/useGovernanceProposals", () => ({
  useLiveProposalCount: () => ({
    count: liveCount, loading: false, incomplete: false, refresh: () => {},
  }),
}));

const MINT = <div>mint-content</div>;
const EXCHANGE = <div>exchange-content</div>;
const GOVERNANCE = <div>governance-content</div>;

/** Both views are passed every time: the component chooses, never the caller. */
const mount = () => render(
  <TokensView mintView={MINT} exchangeView={EXCHANGE} governanceView={GOVERNANCE} />);

afterEach(() => {
  cleanup();
  liveCount = 0;
  window.history.replaceState({}, "", "/tokens");
});

/** The dot: the only pulsing round thing in the pill row. */
const dot = (c: HTMLElement) => c.querySelector("span.animate-pulse.rounded-full");

describe("the two pills", () => {
  it("offers Exchange and Governance, and neither of the asset pills it replaced", () => {
    mount();
    expect(screen.getByRole("button", { name: /^Exchange$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Governance$/ })).toBeTruthy();
    // The page toggled between two ASSETS until 2026-11-04.
    expect(screen.queryByRole("button", { name: /Magnet/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^mUSD$/ })).toBeNull();
  });

  it("lands on Mint, not Exchange", () => {
    /*
      Changed 2026-11-07 when the PSM's two-way swap split across two pills.
      Mint is the on-ramp — bringing USDC in is why most people open this
      page — so it leads and it is where an unqualified visit lands.
      Exchange keeps the way back out.
    */
    mount();
    expect(screen.getByText("mint-content")).toBeTruthy();
    expect(screen.queryByText("exchange-content")).toBeNull();
    expect(screen.queryByText("governance-content")).toBeNull();
  });

  it("offers all three pills", () => {
    mount();
    for (const name of [/^Mint$/, /^Exchange$/, /^Governance$/]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
  });

  it("reaches Exchange from Mint and back", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /^Exchange$/ }));
    expect(screen.getByText("exchange-content")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Mint$/ }));
    expect(screen.getByText("mint-content")).toBeTruthy();
  });

  it("swaps the column rather than stacking", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /^Governance$/ }));
    expect(screen.getByText("governance-content")).toBeTruthy();
    expect(screen.queryByText("exchange-content")).toBeNull();
  });

  it("goes back, rather than being a one-way door", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /^Governance$/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Exchange$/ }));
    expect(screen.getByText("exchange-content")).toBeTruthy();
  });
});

describe("#governance, which /vote and /dao redirect to", () => {
  it("opens the Governance pill on arrival", () => {
    window.history.replaceState({}, "", "/tokens#governance");
    mount();
    expect(screen.getByText("governance-content")).toBeTruthy();
  });

  it("opens it for ?tab=governance too", () => {
    window.history.replaceState({}, "", "/tokens?tab=governance");
    mount();
    expect(screen.getByText("governance-content")).toBeTruthy();
  });

  it("responds to a hash arriving AFTER mount", () => {
    /**
     * Following `/tokens#governance` while already on /tokens is a hash change,
     * not a navigation: this component does not remount, so a mount-only read
     * would leave the landing pill selected under a URL claiming Governance.
     */
    mount();
    expect(screen.getByText("mint-content")).toBeTruthy();
    window.history.replaceState({}, "", "/tokens#governance");
    fireEvent(window, new HashChangeEvent("hashchange"));
    expect(screen.getByText("governance-content")).toBeTruthy();
  });

  it("leaves an unrelated fragment alone", () => {
    // Only `#governance` means anything here. A stray fragment must land on the
    // default view, not on a pill the reader did not ask for.
    window.history.replaceState({}, "", "/tokens#psm");
    mount();
    expect(screen.getByText("mint-content")).toBeTruthy();
  });

  it("stops listening once unmounted", () => {
    /**
     * Asserted through the listener registry, not through a fired event.
     *
     * The first version of this test unmounted, fired a `hashchange` and
     * expected no throw. That passes with the cleanup DELETED — React 18 makes
     * a setState on an unmounted component a silent no-op — so it was a test
     * that could never fail, verified by removing the cleanup and watching it
     * stay green. What survives a leaked listener is a handler accumulating
     * once per mount, which is what these two spies actually measure.
     */
    const added: EventListenerOrEventListenerObject[] = [];
    const removed: EventListenerOrEventListenerObject[] = [];
    const add = vi.spyOn(window, "addEventListener")
      .mockImplementation((t, fn) => { if (t === "hashchange" && fn) added.push(fn); });
    const remove = vi.spyOn(window, "removeEventListener")
      .mockImplementation((t, fn) => { if (t === "hashchange" && fn) removed.push(fn); });
    try {
      mount().unmount();
      expect(added).toHaveLength(1);
      // The SAME function object — `removeEventListener` with a fresh closure
      // removes nothing, and is the usual way this bug ships.
      expect(removed).toEqual(added);
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });
});

/**
 * The URL and the selected pill stay in step.
 *
 * ── Why this became load-bearing on 2026-11-07 ───────────────────────────
 * `LiveProposalsPill` moved onto THIS page, into the mUSD hero. It links to
 * `/tokens#governance`, and the only thing that turns that into a pill
 * selection is the `hashchange` listener above.
 *
 * Which means: if the URL already says `#governance` while the Exchange pill
 * is showing, the pill's link changes nothing, no `hashchange` fires, and
 * pressing it does nothing at all. A live count above a dead button. That
 * state was reachable the moment selecting a pill stopped being a no-op for
 * the URL — arrive at `/tokens#governance`, press Exchange, press the pill.
 */
describe("the URL follows the pill", () => {
  /**
   * What following the Live proposals link looks like to this component.
   *
   * `fireEvent`, not `window.dispatchEvent`: the listener calls `setTab`, and
   * a bare dispatch updates state outside React's batching, so the re-render
   * had not happened by the time the assertion ran. The event is identical;
   * only the act() wrapper differs.
   */
  const followPillLink = () => {
    window.history.replaceState({}, "", "/tokens#governance");
    fireEvent(window, new HashChangeEvent("hashchange"));
  };

  it("writes the hash when Governance is chosen", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /^Governance$/ }));
    expect(window.location.hash).toBe("#governance");
  });

  it("clears it again when Exchange is chosen", () => {
    // The stale state itself: Exchange showing under a governance URL.
    mount();
    fireEvent.click(screen.getByRole("button", { name: /^Governance$/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Exchange$/ }));
    expect(window.location.hash).toBe("");
    expect(screen.getByText("exchange-content")).toBeTruthy();
  });

  it("lets the pill work after the user has gone back to Exchange", () => {
    /*
      The whole point. Arrive on governance, switch to Exchange, then follow
      the Live proposals link — which is a navigation to the same hash it
      arrived with. Without the clear above, this fires nothing.
    */
    window.history.replaceState({}, "", "/tokens#governance");
    mount();
    expect(screen.getByText("governance-content")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Exchange$/ }));
    expect(screen.getByText("exchange-content")).toBeTruthy();
    expect(window.location.hash).toBe("");

    followPillLink();
    expect(screen.getByText("governance-content")).toBeTruthy();
  });

  /*
    ── What `followPillLink` above does NOT reproduce ──────────────────────
    It dispatches `hashchange`, and a same-page Next <Link> never fires one:
    the router updates the URL through the history API. So the test passed
    while the real pill set `/tokens#governance` and left the Exchange pill
    showing — found in a browser, not here.

    The pill now announces itself with `OPEN_GOVERNANCE`, and these assert
    that contract from this side. `LiveProposalsPill.test.tsx` asserts the
    other side: that pressing it dispatches the event.
  */
  it("opens Governance on the pill's event, with no hash change at all", () => {
    mount();
    expect(screen.getByText("mint-content")).toBeTruthy();
    fireEvent(window, new Event(OPEN_GOVERNANCE));
    expect(screen.getByText("governance-content")).toBeTruthy();
  });

  it("opens it even when the hash ALREADY says governance", () => {
    // The exact state the bug lived in: URL right, pill wrong, and nothing
    // the browser emits to reconcile them.
    window.history.replaceState({}, "", "/tokens#governance");
    mount();
    fireEvent.click(screen.getByRole("button", { name: /^Exchange$/ }));
    window.history.replaceState({}, "", "/tokens#governance");  // Link's update
    expect(screen.getByText("exchange-content")).toBeTruthy();

    fireEvent(window, new Event(OPEN_GOVERNANCE));
    expect(screen.getByText("governance-content")).toBeTruthy();
  });

  it("stops listening once unmounted", () => {
    /*
      A listener that outlives its component sets state on a dead tree, and
      every remount adds another.

      The first version of this asserted the dispatch did not THROW, which
      React never does for that — it warns at most. It passed with the
      cleanup deleted, so it was checking nothing. Asserting the removal
      itself is the behaviour, and it fails when the cleanup goes.
    */
    // Bind the real one BEFORE replacing it. Reaching for
    // EventTarget.prototype and `.call(window, …)` instead threw
    // "not a valid instance of EventTarget" in jsdom and left the spy in
    // place for the rest of the file, failing two unrelated tests after it.
    const original = window.removeEventListener.bind(window);
    const removed: string[] = [];
    const spy = vi.spyOn(window, "removeEventListener").mockImplementation(
      ((type: string, listener: EventListener, opts?: boolean | EventListenerOptions) => {
        removed.push(type);
        original(type, listener, opts);
      }) as typeof window.removeEventListener);

    const { unmount } = mount();
    unmount();
    expect(removed).toContain(OPEN_GOVERNANCE);
    expect(removed).toContain("hashchange");
    spy.mockRestore();
  });

  it("clears the ?tab= form too, so it cannot outlive the hash", () => {
    // Both forms are accepted on the way in; a query left behind would keep
    // claiming a tab the user has since left, and survives a copied link.
    window.history.replaceState({}, "", "/tokens?tab=governance");
    mount();
    expect(screen.getByText("governance-content")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Exchange$/ }));
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("");
  });

  it("does not stack history entries, so Back leaves the page", () => {
    // `replaceState`, not `location.hash =`. Toggling pills five times must
    // not bury the page the visitor came from under five entries.
    const before = window.history.length;
    mount();
    for (let i = 0; i < 5; i++) {
      fireEvent.click(screen.getByRole("button", { name: /^Governance$/ }));
      fireEvent.click(screen.getByRole("button", { name: /^Exchange$/ }));
    }
    expect(window.history.length).toBe(before);
  });
});

describe("the Governance pill signals an open vote", () => {
  /*
    A small prompt to go and look, matching the hero's "Live proposals" pill
    so the two read as one vocabulary rather than two notifications.

    Driven off the SAME count as that pill, through one module-level store:
    a pill row saying a vote is open above a hero pill reading 0 is not a
    state this page should be able to reach.
  */
  it("shows no dot when nothing is open", () => {
    const { container } = mount();
    expect(dot(container)).toBeNull();
  });

  it("shows one when a proposal is live", () => {
    liveCount = 1;
    const { container } = mount();
    expect(dot(container)).toBeTruthy();
  });

  it("puts it on Governance and on no other pill", () => {
    // A signal on Mint or Exchange would point at the wrong tab, which is
    // worse than no signal: it spends the reader's attention and misroutes it.
    liveCount = 2;
    mount();
    const pill = (name: RegExp) => screen.getByRole("button", { name });
    expect(pill(/^Governance/).querySelector("span.animate-pulse")).toBeTruthy();
    for (const name of [/^Mint$/, /^Exchange$/]) {
      expect(pill(name).querySelector("span.animate-pulse"), String(name)).toBeNull();
    }
  });

  it("says what the dot means, for a reader who cannot see it", () => {
    // A bare coloured circle is invisible to a screen reader, and `aria-hidden`
    // on it without this would make the state unreachable rather than quiet.
    liveCount = 1;
    mount();
    expect(screen.getByRole("button", { name: "Governance, a proposal is open" })).toBeTruthy();
  });

  it("stays visible once the tab is selected, in a colour that survives the gradient", () => {
    /*
      `bg-magnet-400` on the selected pill's magnet-600→500 gradient is
      purple on purple. The dot does not vanish when you arrive — it is the
      same object either way — so the active state flips it to white.
    */
    liveCount = 1;
    const { container } = mount();
    expect(dot(container)!.className).toContain("bg-magnet-400");

    fireEvent.click(screen.getByRole("button", { name: /^Governance/ }));
    const active = dot(container)!;
    expect(active).toBeTruthy();
    expect(active.className).toContain("bg-white");
    expect(active.className).not.toContain("bg-magnet-400");
  });

  it("keeps the row narrow enough for a 360px phone", () => {
    /*
      A STYLING guard, and a weak one — jsdom computes no layout, so this
      pins the class rather than the width. It is here because the fact it
      records was measured in a browser and is invisible in a diff: at
      `px-4` the three pills run 355px wide, the dot adds 14, and 369 against
      360px of viewport is 4px of real horizontal page scroll. Re-measure in
      a browser before changing it; do not reason about it.
    */
    mount();
    for (const name of [/^Mint$/, /^Exchange$/, /^Governance$/]) {
      const cls = screen.getByRole("button", { name }).className;
      expect(cls, String(name)).toContain("px-3");
      expect(cls, String(name)).toContain("sm:px-4");
    }
  });

  it("glows, rather than being a flat 6px circle", () => {
    // It carries the message alone here: the hero pill has a number and the
    // word "proposals" beside its dot, and this row reads as navigation.
    liveCount = 1;
    const { container } = mount();
    expect(dot(container)!.className).toMatch(/shadow-\[0_0_\d+px/);
  });
});
