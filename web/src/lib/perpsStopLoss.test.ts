// Perps — the derived group shape, and the stop-loss leg's identity rules.
//
// `openShape` replaced six hand-maintained constants that a second attached leg
// would have doubled to twelve. A derivation is only safe if it agrees with the
// shapes that were measured against real MainNet output, so that agreement is
// asserted here rather than assumed — audit 8's ship-blocker was a shape/offset
// error that passed everything anyone ran.

import { describe, expect, it } from "vitest";
import {
  openShape,
  ORDER_KIND_STOP_LOSS,
  ORDER_KIND_TAKE_PROFIT,
  SHAPE_OPEN,
  SHAPE_OPEN_STORAGE,
  SHAPE_OPEN_TP,
  SHAPE_OPEN_TP_STORAGE,
} from "./perpsGroup";
import { stopLossBounds } from "./perpsQuote";

describe("openShape — derived, checked against the measured constants", () => {
  // Each measured constant is a group shape verified against a real group. If
  // the derivation and a measurement ever disagree, the measurement wins and
  // these tests are how that argument gets had.
  const same = (a: Record<string, unknown>, b: Record<string, unknown>, keys: string[]) =>
    keys.every((k) => a[k] === b[k]);

  it("reproduces SHAPE_OPEN (no legs, no storage)", () => {
    const d = openShape(0, false) as unknown as Record<string, unknown>;
    const m = SHAPE_OPEN as unknown as Record<string, unknown>;
    expect(same(d, m, ["axfer", "pay", "applMin", "applMax", "trading", "orderOps"])).toBe(true);
  });

  it("reproduces SHAPE_OPEN_STORAGE (no legs, storage)", () => {
    const d = openShape(0, true) as unknown as Record<string, unknown>;
    const m = SHAPE_OPEN_STORAGE as unknown as Record<string, unknown>;
    expect(same(d, m, ["axfer", "pay", "applMin", "applMax", "trading", "orderOps"])).toBe(true);
  });

  it("reproduces SHAPE_OPEN_TP (one leg, no storage)", () => {
    const d = openShape(1, false) as unknown as Record<string, unknown>;
    const m = SHAPE_OPEN_TP as unknown as Record<string, unknown>;
    expect(same(d, m, ["axfer", "pay", "applMin", "applMax", "trading"])).toBe(true);
  });

  it("reproduces SHAPE_OPEN_TP_STORAGE (one leg, storage)", () => {
    const d = openShape(1, true) as unknown as Record<string, unknown>;
    const m = SHAPE_OPEN_TP_STORAGE as unknown as Record<string, unknown>;
    expect(same(d, m, ["axfer", "pay", "applMin", "applMax", "trading"])).toBe(true);
  });

  it("does not TIGHTEN the measured ceiling on a bare open", () => {
    // The first draft of the derivation said `9 + legs + storage`, which agreed
    // with both take-profit shapes and quietly tightened both bare ones from 10
    // to 9. A ceiling below a measured group fails CLOSED on correct input,
    // which is how a fix for one thing becomes a block on everything.
    expect(openShape(0, false).applMax).toBe(SHAPE_OPEN.applMax);
    expect(openShape(0, true).applMax).toBe(SHAPE_OPEN_STORAGE.applMax);
  });

  it("charges exactly one axfer, one pay and one OrderOps call per leg", () => {
    // The whole justification for deriving rather than enumerating.
    for (const storage of [false, true]) {
      for (let legs = 0; legs <= 2; legs++) {
        const s = openShape(legs, storage);
        expect(s.axfer, `axfer at ${legs} legs`).toBe(1 + legs);
        expect(s.pay, `pay at ${legs} legs`).toBe(legs + (storage ? 1 : 0));
        expect(s.orderOps, `orderOps at ${legs} legs`).toBe(legs);
      }
    }
  });

  it("keeps orderOps bounded to the leg count", () => {
    // This was 0 on the open shapes after audit 8 HIGH 4, which caught a close
    // group carrying an injected cancel_order. Making it the leg count must
    // preserve that: a group may carry as many OrderOps calls as it has legs,
    // and not one more.
    expect(openShape(0, false).orderOps).toBe(0);
    expect(openShape(2, false).orderOps).toBe(2);
  });

  it("widens the ceiling only for a SECOND leg", () => {
    // The first leg's submit fits inside the headroom the bare shape already
    // had — that is what the measurements show. Only the second adds a call no
    // measurement has covered.
    expect(openShape(1, false).applMax).toBe(openShape(0, false).applMax);
    expect(openShape(2, false).applMax).toBe(openShape(0, false).applMax + 1);
  });
});

describe("protective order kinds", () => {
  it("are the protocol's, and are distinct", () => {
    // `v2ExpectedLinkedChildOrderId` puts the take-profit at base+1 and the
    // stop-loss at base+2. Crossing them turns a stop into a target.
    expect(ORDER_KIND_TAKE_PROFIT).toBe(BigInt(2));
    expect(ORDER_KIND_STOP_LOSS).toBe(BigInt(3));
    expect(ORDER_KIND_TAKE_PROFIT).not.toBe(ORDER_KIND_STOP_LOSS);
  });
});

describe("stopLossBounds — the band, not the point", () => {
  // The regression test for the defect review caught. The first guard compared
  // the trigger to the index PRICE; PEX crosses a DECREASE_STOP_LOSS at the
  // index BAND edge:
  //
  //   crossed = side === LONG ? indexMin <= trigger : indexMax >= trigger
  //
  // and indexMin <= indexPrice <= indexMax. So the whole gap between the edge
  // and the point was accepted here and crossed by PEX — the position opening
  // and closing in one group. The identical window cost $1.58 on a $50 stake
  // when the take-profit had it.
  const P = (n: number) => BigInt(Math.round(n * 1e12));
  const quote = (side: "long" | "short") => ({
    side,
    indexMinPrice12: P(0.116855),
    indexMaxPrice12: P(0.117500),
    entryPrice12: P(0.117000),
    liquidationPrice12: P(0.100000),
    liquidationDirection: "below",
  } as unknown as Parameters<typeof stopLossBounds>[0]);

  const indexPoint = P(0.117100); // inside the band, as the real index always is

  it("rejects a long stop between indexMin and the index price", () => {
    const b = stopLossBounds(quote("long"));
    // This is the value the OLD point comparison accepted: below the index
    // price, so "wrongSide" was false — and at or above indexMin, so PEX
    // reports it crossed.
    const inTheGap = P(0.117000);
    expect(inTheGap < indexPoint).toBe(true);          // the old guard allowed it
    expect(inTheGap > b.maxPrice12).toBe(true);        // the band guard refuses it
  });

  it("rejects a short stop between the index price and indexMax", () => {
    const b = stopLossBounds(quote("short"));
    const inTheGap = P(0.117300);
    expect(inTheGap > indexPoint).toBe(true);          // the old guard allowed it
    expect(inTheGap < b.minPrice12).toBe(true);        // the band guard refuses it
  });

  it("puts the long edge BELOW indexMin, not at the index price", () => {
    const b = stopLossBounds(quote("long"));
    expect(b.maxPrice12 < quote("long").indexMinPrice12).toBe(true);
  });

  it("puts the short edge ABOVE indexMax, not at the index price", () => {
    const b = stopLossBounds(quote("short"));
    expect(b.minPrice12 > quote("short").indexMaxPrice12).toBe(true);
  });

  it("still accepts a stop comfortably outside the band", () => {
    // The control: the guard must not refuse a legitimate stop.
    const long = stopLossBounds(quote("long"));
    expect(P(0.100000) <= long.maxPrice12).toBe(true);
    const short = stopLossBounds(quote("short"));
    expect(P(0.140000) >= short.minPrice12).toBe(true);
  });
});
