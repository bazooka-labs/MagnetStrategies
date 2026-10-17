// @vitest-environment jsdom

/**
 * The splash's compositing contract.
 *
 * These assert the RENDERED DOM, not the source text, and that distinction is
 * the whole point here: the component carries a long comment explaining
 * `transform-gpu`, so `expect(src).toContain("transform-gpu")` would pass on
 * the prose alone while the className said nothing of the kind. Mounting it
 * means only the real output can satisfy the test.
 *
 * What is NOT claimed: that the mobile rectangle is gone. jsdom has no
 * compositor, so nothing here observes a backdrop-filter sampling a layer.
 * These pin the STRUCTURE the fix depends on — two fixed siblings, both
 * promoted — so a later edit that reintroduces the nesting, or drops a
 * promotion, fails loudly instead of silently restoring the artifact on
 * phones only.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ArrivalSplash, DEFAULT_MS } from "./ArrivalSplash";

afterEach(cleanup);

/** jsdom has no matchMedia; the component reads it optionally, so stub false. */
function mount() {
  window.matchMedia ??= ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;

  const { container } = render(
    <ArrivalSplash mark={<img src="/tokens/u-mark.png" alt="" />} subtext="s" />
  );
  const scrim = container.querySelector(".backdrop-blur-md") as HTMLElement;
  const markWrap = container.querySelector(".animate-splash-mark") as HTMLElement;
  return { container, scrim, markWrap };
}

describe("the scrim is a sibling, never an ancestor of the mark", () => {
  it("keeps the blur layer free of the filtered mark", () => {
    // The trap this guards: a filtered descendant inside the blur layer gets
    // its own compositing layer, the backdrop is sampled per layer, and the
    // seam paints a rectangle the size of the image.
    const { scrim, markWrap } = mount();
    expect(scrim).toBeTruthy();
    expect(markWrap).toBeTruthy();
    expect(scrim.contains(markWrap)).toBe(false);
  });

  it("gives the blur layer no children at all", () => {
    // Stronger than the above and the actual rule: the scrim holds nothing.
    expect(mount().scrim.childElementCount).toBe(0);
  });

  it("does not nest either layer inside an opacity-animated wrapper", () => {
    // The inverse trap, and the one I actually tripped: an animated ANCESTOR
    // becomes a backdrop root, so the blur samples a transparent subtree and
    // silently does nothing. Both layers must be top-level siblings.
    const { container, scrim } = mount();
    expect(scrim.parentElement).toBe(container);
    for (const el of Array.from(container.children)) {
      expect(el.className).toContain("fixed");
    }
  });
});

describe("both compositing layers are promoted up front", () => {
  it("promotes the scrim and the mark wrapper", () => {
    // Cold-load fix: both layers must exist on the first frame, so the mark's
    // layer cannot materialise on image decode AFTER the scrim has rasterised
    // its backdrop.
    const { scrim, markWrap } = mount();
    expect(scrim.className).toContain("transform-gpu");
    expect(markWrap.className).toContain("transform-gpu");
  });

  it("drives both layers from one duration variable", () => {
    // The timeout and the keyframes must not be able to disagree.
    const { scrim, container } = mount();
    const content = container.children[1] as HTMLElement;
    for (const el of [scrim, content]) {
      expect(el.style.getPropertyValue("--splash-dur")).toBe(`${DEFAULT_MS}ms`);
    }
  });
});

describe("it never gates the page", () => {
  it("is pointer-transparent on every layer it paints", () => {
    const { container } = mount();
    for (const el of Array.from(container.children)) {
      expect(el.className).toContain("pointer-events-none");
    }
  });
});
