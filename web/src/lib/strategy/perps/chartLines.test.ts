// The chart's price lines: what is HELD versus what is being composed.
//
// The bug these pin: entry and liquidation vanished from the chart on every
// page refresh. Both came from the card's prospective quote, and the collateral
// field is deliberately empty on load — no amount, no quote, no lines. They
// reappeared when something was typed, which made it look intermittent rather
// than structural.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const viewSrc = readFileSync("src/components/strategy/perps/PerpsView.tsx", "utf8");
const hookSrc = readFileSync("src/hooks/usePerpsPositions.ts", "utf8");
const quoteSrc = readFileSync("src/lib/strategy/pex/quote.ts", "utf8");

describe("held positions draw without a quote", () => {
  it("does not bail out when there is no composer overlay", () => {
    // `if (!overlay) return [];` was the bug in one line.
    expect(viewSrc).not.toContain("if (!overlay) return [];");
  });

  it("builds held lines from the positions, not the overlay", () => {
    expect(viewSrc).toContain("const held = positionLines.filter((l) => l.marketId === marketId);");
    expect(viewSrc).toContain('add(l.entryPrice12, `Your ${who}entry`, "#e5e7eb", "");');
  });

  it("recomputes when the held positions or the market change", () => {
    expect(viewSrc).toContain("}, [overlay, positionLines, marketId]);");
  });
});

describe("held and composed are told apart", () => {
  it("draws held solid and composed dashed", () => {
    expect(viewSrc).toContain('add(l.liquidationPrice12, `Your ${who}liquidation`, "#f87171", "");');
    expect(viewSrc).toContain('add(overlay.liquidationPrice12, "Liquidation", "#f87171", "2 3");');
  });

  it("routes its line labels through heldLineQualifiers", () => {
    /**
     * Checked against the AST, not the source text.
     *
     * The label RULE itself is tested behaviourally in positionLines.test.ts.
     * All this file needs to pin is that the view still goes through it rather
     * than growing a second, inlined copy that drifts \u2014 which is exactly what
     * was here before.
     *
     * An earlier version of this matched the source string
     * `"const qualifiers = heldLineQualifiers(held);"`, which a COMMENT
     * containing those words would satisfy. CLAUDE.md names that failure mode
     * directly: guard with the AST or with real behaviour. Flagged in review.
     */
    const sf = ts.createSourceFile("PerpsView.tsx", viewSrc, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let imported = false;
    let called = false;
    const walk = (n: ts.Node): void => {
      if (ts.isImportDeclaration(n)
        && String((n.moduleSpecifier as ts.StringLiteral).text).includes("positionLines")) {
        const named = n.importClause?.namedBindings;
        if (named && ts.isNamedImports(named)) {
          for (const e of named.elements) {
            if (e.name.text === "heldLineQualifiers") imported = true;
          }
        }
      }
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)
        && n.expression.text === "heldLineQualifiers") called = true;
      ts.forEachChild(n, walk);
    };
    walk(sf);
    expect(imported, "PerpsView no longer imports heldLineQualifiers").toBe(true);
    expect(called, "PerpsView imports the rule but never calls it").toBe(true);
  });
});

describe("the liquidation price is PEX's, not ours", () => {
  it("comes from quoteV2LiquidationPrice", () => {
    expect(quoteSrc).toContain("quoteV2LiquidationPrice");
    expect(hookSrc).toContain("quoteLiquidationPrice({");
  });

  it("reads this quote's own result keys", () => {
    // The trap: quoteV2OpenPosition returns `liquidation_price_estimate` and
    // `liquidation_price_direction`; this one returns `liquidation_price` and
    // `direction`. Reading the open quote's names gives undefined, which the
    // `big()` helper converts to a confident 0n — a liquidation line pinned to
    // the bottom of the axis.
    expect(quoteSrc).toContain("big(raw.liquidation_price)");
    expect(quoteSrc).toContain("String(raw.direction ?? \"\")");
  });

  it("returns null rather than zero when the solver declines", () => {
    expect(quoteSrc).toContain("if (!raw.ok) return null;");
    expect(quoteSrc).toContain('if (price12 <= BigInt(0) || direction === "") return null;');
  });

  it("is carried on the position rather than recomputed by the drawer", () => {
    expect(hookSrc).toContain("liquidationPrice12: liq?.price12 ?? null");
  });

  it("carries current_liquidatable instead of discarding it", () => {
    // The SDK flips its search direction on this flag, so for an ALREADY
    // liquidatable long it returns the highest price that is STILL
    // liquidatable — above the index, still labelled `at_or_below`. Dropped,
    // the chart drew a solid red "Your liquidation" line in the profit
    // direction on a position a keeper could close out now. Audit 11 HIGH 3.
    expect(quoteSrc).toContain("liquidatableNow: Boolean(raw.current_liquidatable)");
    expect(hookSrc).toContain("liquidatableNow: liq?.liquidatableNow ?? false");
  });

  it("draws the level only when it is a boundary AHEAD of the price", () => {
    expect(viewSrc).toContain('const ahead = l.side === "long" ? "at_or_below" : "at_or_above";');
    expect(viewSrc).toContain("if (!l.liquidatableNow && l.liquidationDirection === ahead) {");
  });

  it("makes liquidationDirection a field that is actually read", () => {
    // It was carried and never read — the shape of audit 10's first ship
    // blocker, where a deleted guard left a dead import behind.
    expect(viewSrc).toContain("l.liquidationDirection");
  });
});
