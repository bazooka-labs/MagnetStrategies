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

const EXCHANGE = <div>exchange-content</div>;
const GOVERNANCE = <div>governance-content</div>;

/** Both views are passed every time: the component chooses, never the caller. */
const mount = () => render(<TokensView exchangeView={EXCHANGE} governanceView={GOVERNANCE} />);

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/tokens");
});

describe("the two pills", () => {
  it("offers Exchange and Governance, and neither of the asset pills it replaced", () => {
    mount();
    expect(screen.getByRole("button", { name: /^Exchange$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Governance$/ })).toBeTruthy();
    // The page toggled between two ASSETS until 2026-11-04.
    expect(screen.queryByRole("button", { name: /Magnet/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^mUSD$/ })).toBeNull();
  });

  it("lands on Exchange", () => {
    mount();
    expect(screen.getByText("exchange-content")).toBeTruthy();
    expect(screen.queryByText("governance-content")).toBeNull();
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
     * would leave Exchange selected under a URL claiming Governance.
     */
    mount();
    expect(screen.getByText("exchange-content")).toBeTruthy();
    window.history.replaceState({}, "", "/tokens#governance");
    fireEvent(window, new HashChangeEvent("hashchange"));
    expect(screen.getByText("governance-content")).toBeTruthy();
  });

  it("leaves an unrelated fragment alone", () => {
    // Only `#governance` means anything here. A stray fragment must land on the
    // default view, not on a pill the reader did not ask for.
    window.history.replaceState({}, "", "/tokens#psm");
    mount();
    expect(screen.getByText("exchange-content")).toBeTruthy();
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
    expect(screen.getByText("exchange-content")).toBeTruthy();
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
