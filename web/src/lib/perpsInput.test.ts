import { describe, expect, it } from "vitest";
import { mustRefuseInput, parseMoney, sanitizeDecimalInput } from "./perpsInput";

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
    expect(mustRefuseInput("-5")).toBe(true);
    expect(mustRefuseInput("5")).toBe(false);
    expect(mustRefuseInput("1-2")).toBe(true);
  });

  // Audit 3, L-4: the same family, missed when the minus was fixed.
  it("refuses scientific notation rather than rewriting it", () => {
    // "1e5" sanitises to "15", a completely different number.
    expect(sanitizeDecimalInput("1e5")).toBe("15");
    expect(mustRefuseInput("1e5")).toBe(true);
    expect(mustRefuseInput("1E5")).toBe(true);
    expect(mustRefuseInput("Infinity")).toBe(true);
    expect(mustRefuseInput("NaN")).toBe(true);
  });

  it("still accepts formatting that does not change the number", () => {
    // Stripping these is safe: "$1,000" and "1000" are the same number.
    for (const v of ["$1,000", "1 000", "12.34", "0.5"]) {
      expect(mustRefuseInput(v)).toBe(false);
    }
    expect(sanitizeDecimalInput("$1,000")).toBe("1000");
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
