/**
 * One metric in the four-up row at the top of a token page.
 *
 * ── Why the colours live here ──────────────────────────────────────────────
 * The row reads left to right as green → amber → teal → magnet. Those are
 * positional, not semantic: every figure in the row is neutral information, so
 * the colour is there to break up a wall of four identical numbers, nothing
 * more. Elsewhere on this page green DOES carry meaning — the APR figures and
 * the Farming badge — which is exactly why these are named by position here
 * rather than by a mood like "good" or "warn" that would invite reuse.
 *
 * All four sit at the -400 weight on purpose. Mixing weights across a row of
 * equal-sized numbers makes the brighter ones read as more important, and
 * nothing in this row outranks anything else.
 *
 * Exported because two boxes in the row are not `StatCell`s: `TvlRankStat`,
 * which owns a popover, and `TreasuryStat`, which owns a link. Both have to
 * take their colour from here or the row drifts the first time one is touched.
 *
 * GREEN NOW APPEARS TWICE — price and treasury — which breaks the one-colour-
 * per-position rule above. Deliberate: those two are the only figures in the
 * row denominated in dollars the project actually holds or trades at, and
 * pairing them is the point. If a sixth box ever lands, this is the rule that
 * is already bent and should be reconsidered rather than bent further.
 */
export const STAT_TONES = {
  green: "text-green-400",
  amber: "text-amber-400",
  teal: "text-teal-400",
  /** The brand accent — the same family as the nav's "M" button. */
  magnet: "text-magnet-400",
} as const;

export type StatTone = keyof typeof STAT_TONES;

export function StatCell({
  label,
  value,
  sub,
  tone = "green",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: StatTone;
}) {
  return (
    <div className="p-5">
      <p className="text-xs font-medium uppercase tracking-wider text-gray-500">{label}</p>
      <p className={`mt-2 font-mono text-2xl font-bold ${STAT_TONES[tone]}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-gray-500">{sub}</p>}
    </div>
  );
}
