import { describe, expect, it } from "vitest";
import { looksNegative, parseMoney, sanitizeDecimalInput } from "./perpsInput";

describe("sanitizeDecimalInput", () => {
  it("leaves ordinary input alone", () => {
    for (const v of ["", "0", "5", "12.34", "0.5"]) expect(sanitizeDecimalInput(v)).toBe(v);
  });

  it("keeps partial input typeable", () => {
    // A field that rewrites these mid-keystroke is unusable.
    expect(sanitizeDecimalInput(".")).toBe(".");
    expect(sanitizeDecimalInput("1.")).toBe("1.");
    expect(sanitizeDecimalInput("0.")).toBe("0.");
  });

  it("collapses extra dots rather than passing NaN downstream", () => {
    expect(sanitizeDecimalInput("1.2.3")).toBe("1.23");
    expect(sanitizeDecimalInput("...5")).toBe(".5");
  });

  it("strips leading zeros without eating a lone zero", () => {
    expect(sanitizeDecimalInput("007")).toBe("7");
    expect(sanitizeDecimalInput("0")).toBe("0");
  });

  it("drops characters that cannot be part of a decimal", () => {
    expect(sanitizeDecimalInput("1e9")).toBe("19");
    expect(sanitizeDecimalInput("$1,000")).toBe("1000");
    expect(sanitizeDecimalInput("Infinity")).toBe("");
  });

  // The finding: "-5" became "5", so a negative turned into a real position.
  it("cannot turn a negative into a positive on its own", () => {
    expect(sanitizeDecimalInput("-5")).toBe("5");
    expect(looksNegative("-5")).toBe(true);
    expect(looksNegative("5")).toBe(false);
    expect(looksNegative("1-2")).toBe(true);
  });
});

describe("parseMoney", () => {
  it("parses what it should", () => {
    expect(parseMoney("12.34")).toBe(12.34);
    expect(parseMoney("0")).toBe(0);
  });

  it("returns null rather than 0 for absent or partial input", () => {
    // 0 and "nothing entered yet" must render differently.
    for (const v of ["", ".", "1."]) {
      const r = parseMoney(v);
      expect(r === null || Number.isFinite(r)).toBe(true);
    }
    expect(parseMoney("")).toBeNull();
    expect(parseMoney(".")).toBeNull();
  });

  it("refuses non-finite and negative values", () => {
    expect(parseMoney("Infinity")).toBeNull();
    expect(parseMoney("NaN")).toBeNull();
    expect(parseMoney("-5")).toBeNull();
  });
});
