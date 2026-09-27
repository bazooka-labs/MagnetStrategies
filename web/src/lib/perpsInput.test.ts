import { describe, expect, it } from "vitest";
import { parseMoney, readNumericInput } from "./perpsInput";

const val = (raw: string) => {
  const v = readNumericInput(raw);
  return v.ok ? v.value : null;
};
const refused = (raw: string) => !readNumericInput(raw).ok;

describe("readNumericInput — strips only what cannot change the number", () => {
  it("leaves ordinary input alone", () => {
    for (const v of ["", "0", "5", "12.34", "0.5"]) expect(val(v)).toBe(v);
  });

  it("keeps partial input typeable", () => {
    // A field that rewrites these mid-keystroke is unusable.
    for (const v of [".", "1.", "0."]) expect(val(v)).toBe(v);
  });

  it("strips decoration that provably cannot change the value", () => {
    expect(val("$5")).toBe("5");
    expect(val("1 000")).toBe("1000");      // ordinary space
    expect(val("1 000")).toBe("1000"); // non-breaking space
    expect(val("007")).toBe("7");
    expect(val("0")).toBe("0");
  });

  // ── The three instances of the one defect ────────────────────────────────

  it("refuses a negative rather than stripping the sign (audit 2)", () => {
    expect(refused("-5")).toBe(true);
    expect(refused("1-2")).toBe(true);
    expect(val("5")).toBe("5");
  });

  it("refuses scientific notation rather than rewriting it (audit 3)", () => {
    // "1e5" used to sanitise to "15".
    for (const v of ["1e5", "1E5", "Infinity", "NaN"]) expect(refused(v)).toBe(true);
  });

  it("refuses a decimal comma rather than deleting it (audit 4)", () => {
    // "12,50" used to become "1250" — 100x the intended stake, on the comma
    // key that French/German/Spanish/Italian/Dutch/Brazilian phone keypads
    // render for inputMode="decimal".
    expect(refused("12,50")).toBe(true);
    expect(refused("1,5")).toBe(true);
    expect(refused("0,05")).toBe(true);
    // Ambiguous rather than wrong — one thousand in en-US, one in de-DE. Both
    // readings are defensible, which is exactly why this is refused, not guessed.
    expect(refused("1,000")).toBe(true);
    expect(readNumericInput("12,50")).toMatchObject({
      ok: false, hint: "Use a point for decimals — for example 12.50",
    });
  });

  it("refuses the other separators that mis-cleaned the same way", () => {
    expect(refused("1'5")).toBe(true);        // Swiss apostrophe
    expect(refused("1’5")).toBe(true);   // right single quote
    expect(refused("1٫5")).toBe(true);   // Arabic decimal separator
  });

  it("refuses non-ASCII digits, which used to vanish entirely", () => {
    expect(refused("５")).toBe(true);      // fullwidth 5
    expect(refused("١٢")).toBe(true); // Arabic-Indic 12
  });

  it("refuses multiple decimal points rather than collapsing them", () => {
    // "1.2.3" used to become "1.23" — a different number, silently.
    expect(refused("1.2.3")).toBe(true);
    expect(refused("...5")).toBe(true);
  });

  it("never returns a value that parses to a different number than was typed", () => {
    // The whole contract, stated as a property.
    const inputs = [
      "12.34", "0.5", "$5", "1 000", "007", "-5", "1e5", "12,50", "1,000",
      "1'5", "1.2.3", "５", "abc", "", "1.", ".",
    ];
    for (const raw of inputs) {
      const v = readNumericInput(raw);
      if (!v.ok) continue;
      const cleanedDigits = v.value.replace(/[^0-9.]/g, "");
      const rawDigits = raw.replace(/[$\s ]/g, "").replace(/^0+(?=\d)/, "");
      // Everything kept is a digit or the single point, in the original order.
      expect(cleanedDigits).toBe(v.value);
      expect(rawDigits).toBe(v.value);
    }
  });
});

describe("parseMoney", () => {
  it("parses what it should", () => {
    expect(parseMoney("12.34")).toBe(12.34);
    expect(parseMoney("0")).toBe(0);
  });

  it("returns null rather than 0 for absent or partial input", () => {
    // 0 and "nothing entered yet" must render differently.
    expect(parseMoney("")).toBeNull();
    expect(parseMoney(".")).toBeNull();
  });

  it("refuses notation even if a caller bypasses readNumericInput", () => {
    for (const v of ["Infinity", "NaN", "-5", "1e5", "0x10"]) {
      expect(parseMoney(v)).toBeNull();
    }
  });
});
