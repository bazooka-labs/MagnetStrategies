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
import { TokensView } from "./TokensView";

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
