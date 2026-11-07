/**
 * Exact decimal parsing, against the float arithmetic it replaced.
 *
 * The first test is the whole argument: it asserts the specific values the
 * old `BigInt(Math.floor(n * 1e6))` got wrong, so if anyone reintroduces the
 * float path it fails here rather than silently depositing 2.009999 ALGO for
 * a user who typed 2.01.
 */

import { describe, expect, it } from "vitest";
import { formatBaseUnits, parseBaseUnits } from "./amount";

const base = (t: string, d = 6) => {
  const r = parseBaseUnits(t, d);
  if (!r.ok) throw new Error(`expected ${t} to parse, got ${r.error}`);
  return r.base;
};
const err = (t: string, d = 6) => {
  const r = parseBaseUnits(t, d);
  return r.ok ? null : r.error;
};

describe("the float bug this module exists to remove", () => {
  it("parses the values Math.floor(n * 1e6) truncated", () => {
    // Each of these is a real, reachable user input whose old result was one
    // base unit short. Verified: Math.floor(2.01 * 1e6) === 2009999.
    for (const [text, want] of [
      ["2.01", 2_010_000], ["2.03", 2_030_000], ["2.05", 2_050_000],
      ["4.02", 4_020_000], ["8.29", 8_290_000], ["2.07", 2_070_000],
    ] as const) {
      expect(Math.floor(Number(text) * 1e6)).toBe(want - 1);  // the old way
      expect(base(text)).toBe(BigInt(want));                  // the new way
    }
  });

  it("round-trips every base unit the Max button could offer", () => {
    // `String(holding / 1e6)` then floor lost a unit in about 2% of holdings.
    // This is the property that button now relies on.
    for (const n of [
      1, 999_999, 1_000_000, 1_000_001, 1_000_004, 1_000_009,
      353_286_105, 49_319_479_854, 9_999_950_680_520_146,
    ]) {
      const b = BigInt(n);
      expect(base(formatBaseUnits(b, 6))).toBe(b);
    }
  });

  it("is exact across a dense sweep, where the float path was not", () => {
    let floatWrong = 0;
    for (let i = 1; i <= 20_000; i++) {
      const b = BigInt(i) * BigInt(7_919);          // a prime stride
      const text = formatBaseUnits(b, 6);
      expect(base(text)).toBe(b);                   // never wrong
      if (BigInt(Math.floor(Number(text) * 1e6)) !== b) floatWrong++;
    }
    // The point of the sweep: the thing it replaced really does fail.
    expect(floatWrong).toBeGreaterThan(0);
  });
});

describe("parsing", () => {
  it("handles the ordinary shapes", () => {
    expect(base("1")).toBe(BigInt(1_000_000));
    expect(base("0.5")).toBe(BigInt(500_000));
    expect(base(".5")).toBe(BigInt(500_000));
    expect(base("1.")).toBe(BigInt(1_000_000));
    expect(base("0.000001")).toBe(BigInt(1));
    expect(base(" 12.5 ")).toBe(BigInt(12_500_000));
    expect(base("0")).toBe(BigInt(0));
  });

  it("respects the asset's decimals", () => {
    // $U has five, magnetALGO six. Passing the wrong one is a 10x error, so
    // the function never assumes.
    expect(base("1", 5)).toBe(BigInt(100_000));
    expect(base("0.00001", 5)).toBe(BigInt(1));
    expect(err("0.000001", 5)).toBe("too_precise");
  });

  it("rejects more precision than the asset has, rather than rounding it", () => {
    // Silently truncating means the transaction does not match the input.
    expect(err("1.0000005")).toBe("too_precise");
  });

  it("rejects what Number() would have accepted", () => {
    expect(err("1e21")).toBe("not_a_number");       // Number -> 1e21
    expect(err("0x10")).toBe("not_a_number");       // Number -> 16
    expect(err("Infinity")).toBe("not_a_number");
    expect(err("1,000")).toBe("not_a_number");
    expect(err("1 000")).toBe("not_a_number");
    expect(err("+1")).toBe("not_a_number");
  });

  it("rejects empty and negative", () => {
    expect(err("")).toBe("empty");
    expect(err("   ")).toBe("empty");
    expect(err("-1")).toBe("negative");
    expect(err("-0.5")).toBe("negative");
  });

  it("handles amounts far beyond Number's exact range", () => {
    // 2^53 microALGO is about 9e9 ALGO — below the 65M cap, but the formatter
    // and parser must not be the thing that breaks first.
    expect(base("9007199254.740993")).toBe(BigInt("9007199254740993"));
  });
});

describe("formatting", () => {
  it("drops trailing zeroes without dropping value", () => {
    expect(formatBaseUnits(BigInt(1_000_000), 6)).toBe("1");
    expect(formatBaseUnits(BigInt(1_500_000), 6)).toBe("1.5");
    expect(formatBaseUnits(BigInt(1), 6)).toBe("0.000001");
    expect(formatBaseUnits(BigInt(0), 6)).toBe("0");
    expect(formatBaseUnits(BigInt(11_020), 5)).toBe("0.1102");
  });
});
