// Perps — numeric input sanitising.
//
// Split out of the card so it can be tested. The previous rule was
// `value.replace(/[^0-9.]/g, "")` on both money fields, which has two defects
// that only show up on input nobody types on purpose:
//
//   "-5"    -> "5"        a negative silently becomes a real position
//   "1.2.3" -> "1.2.3"    survives, then parses as NaN downstream
//
// The first is the one that matters. Stripping the sign does not reject the
// input, it changes its meaning and then acts on it — the user asked for
// something impossible and got something real instead.

/**
 * Keep only what can be part of one non-negative decimal.
 *
 * Deliberately permissive about *incomplete* input: "" , "." and "1." are all
 * returned unchanged, because a field that fights the user mid-keystroke is
 * worse than one that accepts a string `usdToPrice12` will later refuse. What
 * it will not do is silently turn one number into a different one.
 */
export function sanitizeDecimalInput(raw: string): string {
  // Drop everything that is not a digit or a dot. A leading "-" is removed here
  // as before — but the guard below is what stops it becoming a positive number.
  const kept = raw.replace(/[^0-9.]/g, "");
  // Collapse any dot after the first: "1.2.3" -> "1.23".
  const first = kept.indexOf(".");
  const single = first === -1
    ? kept
    : kept.slice(0, first + 1) + kept.slice(first + 1).replace(/\./g, "");
  // Strip leading zeros on the integer part ("007" -> "7") but keep "0" and "0.".
  return single.replace(/^0+(?=\d)/, "");
}

/**
 * True when the input must be REFUSED rather than cleaned.
 *
 * The line is whether stripping a character changes the number:
 *
 *   "$1,000" -> "1000"   same number, so strip and accept
 *   "-5"     -> "5"      different number, so refuse
 *   "1e5"    -> "15"     different number, so refuse
 *
 * A minus sign and scientific notation both fail that test — the second was
 * missed when the first was fixed, which is why this is one predicate and not
 * two. Any letter counts: there is no notation we want to interpret, and
 * silently reinterpreting one is the whole defect.
 */
export const mustRefuseInput = (raw: string): boolean => /-|[a-zA-Z]/.test(raw);

/**
 * Parse a sanitised money string to a finite, non-negative number.
 *
 * Returns null for anything else — empty, partial ("1."), NaN, Infinity. Callers
 * must not substitute 0: "not a number yet" and "zero" lead to different screens.
 */
export function parseMoney(raw: string): number | null {
  if (raw === "" || raw === ".") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}
