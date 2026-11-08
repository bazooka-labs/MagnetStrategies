import type { ReactNode } from "react";
import { STAT_TONES, type StatTone } from "@/components/tokens/StatCell";

/**
 * One figure inside the amber "How voting works" panel.
 *
 * ── Why this is a component and not two hand-built boxes ───────────────────
 * The panel holds two of them side by side — the treasury, and your own vote
 * power — and they are the same object seen twice: same frame, same label
 * size, same figure size, same sub-line. Built by hand they would be two
 * copies of six classes, and the first edit to one of them would misalign the
 * baselines of a pair whose whole job is to be compared at a glance.
 *
 * ── Why the label is white and the metric row's is grey ────────────────────
 * This is the inverse of `StatCell`: there, the label is grey and the colour
 * carries the number. These boxes sit on an amber-tinted panel rather than on
 * the card's black, and a grey label against that tint reads as disabled. The
 * figure keeps its tone from `STAT_TONES` so the two palettes cannot drift.
 *
 * ── `sub` is a node, not a string ──────────────────────────────────────────
 * The treasury's sub-line is a link to the account on allo.info. That is the
 * same reason `TreasuryStat` was never a `StatCell`.
 */
export function GovFigure({
  label,
  value,
  tone,
  sub,
}: {
  label: string;
  value: string;
  tone: StatTone;
  /** The line under the figure. A node, so it can hold a link. */
  sub: ReactNode;
}) {
  return (
    /* `h-full` so a two-line sub-line on one box does not leave the other
       floating at a different height inside the grid row. */
    <div className="flex h-full flex-col rounded-xl border border-white/10 bg-black/30 px-5 py-4">
      <p className="text-xs font-medium uppercase tracking-wider text-white">{label}</p>
      <p className={`mt-1.5 font-mono text-2xl font-bold ${STAT_TONES[tone]}`}>{value}</p>
      <div className="mt-0.5 text-xs leading-relaxed text-gray-500">{sub}</div>
    </div>
  );
}
