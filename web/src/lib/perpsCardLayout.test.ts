// Where things sit on the order card, and what the browser is told about the
// money fields.
//
// Column order is checked by SOURCE POSITION rather than by class names: the
// three columns are siblings in one grid, so "is it in column two" is really
// "does it come after column one's last block and before column two's exits".

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/components/strategy/perps/PerpsCard.tsx", "utf8");
const at = (needle: string) => {
  const i = src.indexOf(needle);
  expect(i, `missing: ${needle}`).toBeGreaterThan(-1);
  return i;
};

describe("the three columns read as three questions", () => {
  // One: what and how much. Two: the market, and the exits chosen against it.
  // Three: what it costs and what it commits to.
  it("keeps direction, amount and risk together in column one", () => {
    expect(at("{/* Direction */}")).toBeLessThan(at("{/* Amount */}"));
    expect(at("{/* Amount */}")).toBeLessThan(at("{/* Risk */}"));
  });

  it("heads column two with the market, not with an exit", () => {
    // Open interest and funding are the conditions a target or a stop is
    // chosen against, so they come first and the two folded exits sit under
    // them.
    expect(at("{/* Risk */}")).toBeLessThan(at("{view.openInterest && ("));
    expect(at("{view.openInterest && (")).toBeLessThan(at("{view.funding?.charged && ("));
    expect(at("{view.funding?.charged && (")).toBeLessThan(at("title={<>Take profit"));
    expect(at("title={<>Take profit")).toBeLessThan(at("title={<>Stop loss"));
  });

  it("puts liquidation with the costs and the button, not above the exits", () => {
    // It belongs to what the signature commits to, which is column three's
    // subject. It used to open column two, above the take-profit.
    expect(at("title={<>Stop loss")).toBeLessThan(at("{/* Liquidation — permanent"));
    expect(at("{/* Liquidation — permanent")).toBeLessThan(at("{/* Costs */}"));
    expect(at("{/* Costs */}")).toBeLessThan(at("{/* Submit */}"));
  });

  it("starts all three columns at the same offset", () => {
    // Different top margins on the first child of each column stagger the row.
    for (const first of [
      '<div className="mt-4 grid grid-cols-2 gap-2',
      '<div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] px-3.5 py-3',
      '<div className="mt-4 rounded-xl border border-red-400/20',
    ]) expect(src).toContain(first);
  });
});

describe("both exits are labelled optional", () => {
  it("says it the same way for each", () => {
    // The take-profit used to be titled "Take profit at ALGO price" — naming a
    // market the pills and the chart above already name twice, and not saying
    // the one thing that matters, which is that it can be skipped.
    const optional = '<span className="normal-case tracking-normal text-white/30">· optional</span>';
    expect(src).toContain(`title={<>Take profit ${optional}</>}`);
    expect(src).toContain(`title={<>Stop loss ${optional}</>}`);
  });
});

describe("the browser is told to leave the money fields alone", () => {
  // Typing in the amount box raised the browser's own white suggestion list
  // over a dark card. It is form history, not anything we render, and it is
  // unstyleable — so it has to be switched off rather than themed.
  it("applies the opt-out to every text input on the card", () => {
    for (const id of ["perps-amount", "perps-trigger", "perps-tp", "perps-sl"]) {
      expect(src).toContain(`<input id="${id}" {...NO_AUTOFILL} inputMode="decimal"`);
    }
  });

  it("leaves the range slider alone", () => {
    // It has no text entry and no suggestion UI; a name and an autocomplete
    // attribute on it would be cargo.
    expect(src).toContain('<input id="perps-risk" type="range"');
    expect(src).not.toContain('<input id="perps-risk" {...NO_AUTOFILL}');
  });

  it("carries a name no heuristic matches", () => {
    // autoComplete="off" is advisory; a recognisable name is what brings the
    // suggestions back regardless.
    expect(src).toContain('autoComplete: "off"');
    expect(src).toContain('name: "magnet-np"');
  });
});
