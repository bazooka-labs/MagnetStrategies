// Perps — numeric input.
//
// ── Why this is a whitelist and not a blocklist ──────────────────────────────
// Three separate audits found three instances of ONE defect here, and the first
// two were fixed by extending a blocklist:
//
//   "-5"    -> "5"       a negative became a real position       (audit 2)
//   "1e5"   -> "15"      notation became a different number      (audit 3)
//   "12,50" -> "1250"    a decimal comma became 100x the stake   (audit 4)
//
// The third is the worst: `inputMode="decimal"` renders a comma key on French,
// German, Spanish, Italian, Dutch and Brazilian phone keypads, so a user typing
// $12.50 the only way their keyboard offers opens a **$1,250** position. Every
// figure on the card is then internally consistent with $1,250 and the wallet
// prompt shows a 1,250 USDC transfer, so nothing looks wrong.
//
// The blocklist was always going to keep losing — `'` (Swiss), `٫` (U+066B,
// Arabic) and fullwidth digits all mis-cleaned too, and all were confirmed. So
// the rule is now structural and stated positively:
//
//   **Strip only what cannot change the number. Refuse everything else.**
//
// Currency symbols and whitespace are decoration: "$1 000" and "1000" are the
// same number, so they are stripped. A comma is NOT decoration — "1,000" is one
// thousand in en-US and one in de-DE, and no amount of cleverness resolves that
// from a keystroke — so it is refused rather than guessed at. A refusal is
// visible and recoverable; a silent reinterpretation is neither.

/** Why an input was refused, phrased for the person who typed it. */
export type InputVerdict =
  | { ok: true; value: string }
  | { ok: false; hint: string };

/** Pure decoration: removing these provably cannot change the value. */
const DECORATION = /[$\s  ]/g;

/**
 * Read a money field.
 *
 * Deliberately permissive about *incomplete* input — "", "." and "1." all come
 * back `ok` unchanged, because a field that fights the user mid-keystroke is
 * worse than one that accepts a string `parseMoney` will later decline. What it
 * will not do is return a number different from the one that was typed.
 */
export function readNumericInput(raw: string): InputVerdict {
  const s = raw.replace(DECORATION, "");
  if (s === "") return { ok: true, value: "" };

  if (s.includes("-")) {
    return { ok: false, hint: "Enter a positive amount." };
  }
  // A decimal comma, a Swiss apostrophe, an Arabic decimal separator, or a
  // thousands comma — all ambiguous, none guessable, every one of them capable
  // of moving the decimal point by three places.
  if (/[,'’٫ʼ]/.test(s)) {
    return { ok: false, hint: "Use a point for decimals — for example 12.50" };
  }
  if (/[eE]/.test(s)) {
    return { ok: false, hint: "Enter a plain number, not scientific notation." };
  }
  if (!/^[0-9.]*$/.test(s)) {
    // Catches letters and every non-ASCII digit, including fullwidth forms,
    // which `Number()` would otherwise happily accept.
    return { ok: false, hint: "Enter digits and a decimal point only." };
  }
  if ((s.match(/\./g) ?? []).length > 1) {
    // "1.2.3" used to collapse to "1.23" — which is, once again, a different
    // number than the one typed. There is no correct reading; refuse.
    return { ok: false, hint: "Only one decimal point." };
  }

  // Leading zeros ARE decoration: "007" and "7" are the same number.
  return { ok: true, value: s.replace(/^0+(?=\d)/, "") };
}

/**
 * Parse a money string to a finite, non-negative number.
 *
 * Returns null for anything else — empty, partial ("1."), NaN, Infinity.
 * Callers must not substitute 0: "not a number yet" and "zero" lead to
 * different screens.
 */
export function parseMoney(raw: string): number | null {
  if (raw === "" || raw === ".") return null;
  // Guard the notation `Number` accepts and we do not, in case a caller reaches
  // here without going through `readNumericInput`.
  if (!/^[0-9]*\.?[0-9]*$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}
