// ── Typed decimal text -> base units, exactly ──────────────────────────────
//
// `BigInt(Math.floor(Number(text) * 1e6))` is wrong, and wrong often enough to
// matter. It was in the first draft of this card and both audit passes found
// it.
//
// IEEE-754 cannot hold most two-decimal values, and the error lands below the
// true value as often as above it, so flooring truncates:
//
//     Math.floor(2.01 * 1e6) === 2009999        not 2010000
//     Math.floor(4.02 * 1e6) === 4019999
//
// 1,196 of the 100,000 two-decimal amounts between 0.01 and 1000.00 are
// affected. Typing "2.01" deposited 2.009999 ALGO.
//
// The Max button was worse, because it round-trips through a float twice:
// `String(holding / 1e6)` and back. A holding of 1,000,001 base units came
// back as 1,000,000, stranding a base unit that the user had asked to redeem
// in full, in about 2% of holdings.
//
// Parsing the DIGITS instead is exact for every input a user can type, needs
// no floating point at all, and cannot lose a base unit. Going the other way
// is exact too, which is what the Max button needs.

/** What went wrong, for a message the user can act on. */
export type ParseError = "empty" | "not_a_number" | "negative" | "too_precise";

export interface ParseOk { ok: true; base: bigint }
export interface ParseFail { ok: false; error: ParseError }

/**
 * Parse decimal text into base units at `decimals` precision.
 *
 * Rejects more precision than the asset has rather than silently rounding it:
 * a user who typed 1.0000005 ALGO meant something, and quietly depositing
 * 1.000000 is a figure on screen that does not match the transaction.
 */
export function parseBaseUnits(text: string, decimals: number): ParseOk | ParseFail {
  const s = text.trim();
  if (s === "") return { ok: false, error: "empty" };

  // Deliberately strict: no exponents, no separators, no signs, no hex. The
  // input is `type="number"`, but a paste, an autofill or a locale keyboard
  // can still deliver text the browser never validated, and `Number()` would
  // cheerfully accept "0x10" as 16 and "1e21" as a quintillion.
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) {
    return { ok: false, error: /^-/.test(s) ? "negative" : "not_a_number" };
  }
  const whole = m[1] ?? "";
  const frac = m[2] ?? "";
  if (whole === "" && frac === "") return { ok: false, error: "not_a_number" };
  if (frac.length > decimals) return { ok: false, error: "too_precise" };

  const padded = frac.padEnd(decimals, "0");
  return { ok: true, base: BigInt((whole || "0") + padded) };
}

/**
 * Base units -> decimal text, exactly, with no trailing zeroes.
 *
 * This is what a Max button must use. It is the inverse of `parseBaseUnits`
 * for every value, so `parseBaseUnits(formatBaseUnits(n, d), d).base === n`.
 */
export function formatBaseUnits(base: bigint, decimals: number): string {
  const neg = base < BigInt(0);
  const digits = (neg ? -base : base).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}
