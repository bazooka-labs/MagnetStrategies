// Perps — the audit 10 fixes.
//
// ── Why some of these read the source text ─────────────────────────────────
// Audit 10's closing observation was that BOTH ship blockers were removals of a
// guard inside a commit that added a guard, and both survived because the thing
// removed had no test and the comment beside it still described it as present.
// Both reviews looked at what the commit added. Neither diffed what it deleted.
//
// A unit test cannot easily reach `openPositionInner` — it needs a funded
// account, a live oracle and a wallet. So for the two guards that were deleted,
// the test asserts they are still WIRED: imported and called. That is a crude
// check and it is aimed exactly at the failure that happened twice, where a
// guard became a dead import and every other test stayed green.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { capacityOnlyFailure } from "./perpsQuote";
import type { OpenQuote } from "./perpsQuote";

const clientSrc = readFileSync("src/lib/perpsClient.ts", "utf8");

describe("SB1 — the take-profit crossing guards are wired", () => {
  // e2adc4d deleted both of these from openPositionInner and left only the
  // stop-loss block in their place, so the write path had ZERO take-profit
  // crossing checks while the stop-loss had two. `takeProfitBounds` became a
  // dead import. The comment below it still read "Both layers now, as the
  // take-profit has", which is how it passed review.
  it("calls takeProfitBounds, not merely imports it", () => {
    expect(clientSrc).toContain("takeProfitBounds(probe)");
  });

  it("asks PEX about the take-profit, not only the stop-loss", () => {
    // Both legs must reach `quoteProtectiveOrderCrossed`. Before the fix only
    // DECREASE_STOP_LOSS did.
    expect(clientSrc).toContain("V2_ORDER_KIND.DECREASE_TAKE_PROFIT");
    expect(clientSrc).toContain("V2_ORDER_KIND.DECREASE_STOP_LOSS");
  });

  it("keeps the guard inside a wantsTakeProfit branch", () => {
    // Skipped entirely without a target, not merely ignored: the SDK validates
    // the trigger and throws on zero, which would surface as "raw Price12 must
    // be positive" with no wallet prompt.
    expect(clientSrc).toContain("if (wantsTakeProfit) {");
  });
});

describe("SB2 — the limit stop-loss reaches the group", () => {
  const cardSrc = readFileSync("src/components/strategy/perps/PerpsCard.tsx", "utf8");

  it("passes stopLossPrice12 on BOTH submit paths", () => {
    // The input was un-gated for limit mode, validated and billed for, and the
    // value never reached openLimitOrder — so a bare limit order was built and
    // asserted green under a card that said the loss was capped.
    expect(cardSrc).toContain("stopLossPrice12: slEmpty ? BigInt(0) : sl12");   // market
    expect(cardSrc).toContain("{ stopLossPrice12: sl12 }");                     // limit
  });

  it("treats zero as NONE on the limit path, as the market path does", () => {
    // The trap audit 10 caught: the two had opposite contracts, so the obvious
    // wiring would have thrown "That stop-loss price is not valid" on EVERY
    // limit order.
    expect(clientSrc).toContain("input.stopLossPrice12 < BigInt(0)");
    expect(clientSrc).not.toContain("input.stopLossPrice12 <= BigInt(0)");
  });

  it("decides 'is there a child' by price, not by presence", () => {
    // `!== undefined` here would read a zero as a stop-loss and build a kind-3
    // leg at a trigger of 0.
    expect(clientSrc).toContain("const slSet = (input.stopLossPrice12 ?? BigInt(0)) > BigInt(0)");
    expect(clientSrc).toContain("const tpSet = (input.takeProfitPrice12 ?? BigInt(0)) > BigInt(0)");
  });
});

describe("MEDIUM 4 — the limit stop-loss clears the band at the entry", () => {
  it("scales the band to the trigger rather than comparing to it", () => {
    // `sl < trigger` is directionally right and one band-width short: the keeper
    // fills a long parent at indexMax <= trigger, and the child's own crossed
    // test is then indexMin <= sl, so every stop within a band-width of entry
    // fires on arrival.
    expect(clientSrc).toContain("sl * bandMax * tenK >= input.triggerPrice12 * bandMin * (tenK - margin)");
    expect(clientSrc).toContain("sl * bandMin * tenK <= input.triggerPrice12 * bandMax * (tenK + margin)");
  });

  it("carries the same crossing margin as the other two guards", () => {
    expect(clientSrc).toContain("CROSS_MARGIN_BPS");
  });
});

describe("HIGH 3 — capacityOnlyFailure", () => {
  const q = (ok: boolean, reasons: string[]) => ({ ok, reasons } as unknown as OpenQuote);

  it("is true only when every reason is a capacity reason", () => {
    expect(capacityOnlyFailure(q(false, ["long_oi_cap"]))).toBe(true);
    expect(capacityOnlyFailure(q(false, ["short_reserves_exceeded"]))).toBe(true);
    expect(capacityOnlyFailure(q(false, ["long_oi_cap", "short_oi_cap"]))).toBe(true);
  });

  it("is false when anything else failed too", () => {
    // The loosening must not swallow a real refusal. `initial_margin_breach`
    // scales with side OI and looks capacity-shaped; it is not, and it must
    // still block.
    expect(capacityOnlyFailure(q(false, ["long_oi_cap", "initial_margin_breach"]))).toBe(false);
    expect(capacityOnlyFailure(q(false, ["position_too_small"]))).toBe(false);
    expect(capacityOnlyFailure(q(false, ["price_slippage"]))).toBe(false);
  });

  it("is false for a passing quote and for no quote", () => {
    expect(capacityOnlyFailure(q(true, []))).toBe(false);
    expect(capacityOnlyFailure(q(false, []))).toBe(false);
    expect(capacityOnlyFailure(null)).toBe(false);
    expect(capacityOnlyFailure(undefined)).toBe(false);
  });

  it("is reached by the card's submit gate", () => {
    // The defect was that solveBar and confirmCeiling learned to ignore capacity
    // and the display quote did not, so the bar offered sizes canSubmit then
    // refused — a dead button under a banner saying the order could be placed.
    const cardSrc = readFileSync("src/components/strategy/perps/PerpsCard.tsx", "utf8");
    expect(cardSrc).toContain("capacityOnlyFailure(quote)");
    expect(cardSrc).toContain("tradable && tpOk && slOk && quoteUsable");
  });
});
