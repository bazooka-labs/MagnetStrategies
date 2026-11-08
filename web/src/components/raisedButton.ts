/**
 * Raised button styling for the token headers.
 *
 * These used to be pills, visually identical to the "Live on Algorand mainnet"
 * status badge sitting beside them — so a clickable control and a passive label
 * read as the same object, and nothing invited the click. The status pill is
 * gone and these now look pressable: a top-edge highlight, a hard shadow below
 * to give the face height, and a press that actually travels.
 *
 * `active:translate-y-[2px]` moves the button down by exactly the height of the
 * hard shadow, which collapses at the same moment — so the face lands flush
 * with where its own shadow was rather than drifting over it.
 *
 * Colour stays per-token: amber for About, Magnet purple for Proposals, teal
 * for Close on a position row.
 */
const BASE =
  "group inline-flex w-fit items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold " +
  "transition-all duration-100 active:translate-y-[2px] " +
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";

export const RAISED_AMBER =
  `${BASE} border border-amber-400/45 bg-gradient-to-b from-amber-400/25 to-amber-600/15 text-amber-100 ` +
  "shadow-[inset_0_1px_0_rgba(255,255,255,0.28),0_2px_0_rgba(146,64,14,0.85),0_5px_10px_rgba(0,0,0,0.45)] " +
  "hover:from-amber-400/35 hover:to-amber-600/22 hover:border-amber-300/60 " +
  "active:shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_0_0_rgba(0,0,0,0),0_2px_5px_rgba(0,0,0,0.4)] " +
  "focus-visible:outline-amber-400";

export const RAISED_MAGNET =
  `${BASE} border border-magnet-400/45 bg-gradient-to-b from-magnet-400/25 to-magnet-700/20 text-magnet-100 ` +
  "shadow-[inset_0_1px_0_rgba(255,255,255,0.28),0_2px_0_rgba(88,28,135,0.9),0_5px_10px_rgba(0,0,0,0.45)] " +
  "hover:from-magnet-400/35 hover:to-magnet-700/28 hover:border-magnet-300/60 " +
  "active:shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_0_0_rgba(0,0,0,0),0_2px_5px_rgba(0,0,0,0.4)] " +
  "focus-visible:outline-magnet-400";

/**
 * Teal: the Close button on a position row.
 *
 * It was an outline — `border-white/20` with `text-white/80` — sitting under a
 * dense block of figures, and it read as a caption rather than as the one
 * action the row offers. Filled so it is found.
 *
 * Teal rather than red: closing is not destructive. It realises a position the
 * user already owns and returns their collateral, and a red button says
 * "careful" about the ordinary outcome of a trade. Teal is already in the
 * house palette (`STAT_TONES.teal`) and is not spoken for by a state — green
 * is profit, red is loss and liquidation, amber is risk copy and warnings,
 * magnet is navigation. Teal is the only one left that means nothing yet,
 * which is what an action button should borrow.
 *
 * `disabled:` styling is carried here rather than at the call site, because
 * this button spends most of its life disabled: a quote PEX will not accept,
 * a close already in flight, or an unsupported collateral.
 */
export const RAISED_TEAL =
  `${BASE} border border-teal-400/45 bg-gradient-to-b from-teal-400/25 to-teal-700/20 text-teal-50 ` +
  "shadow-[inset_0_1px_0_rgba(255,255,255,0.28),0_2px_0_rgba(17,94,89,0.9),0_5px_10px_rgba(0,0,0,0.45)] " +
  "hover:from-teal-400/35 hover:to-teal-700/28 hover:border-teal-300/60 " +
  "active:shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_0_0_rgba(0,0,0,0),0_2px_5px_rgba(0,0,0,0.4)] " +
  "focus-visible:outline-teal-400 " +
  "disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none " +
  "disabled:hover:from-teal-400/25 disabled:hover:to-teal-700/20 disabled:hover:border-teal-400/45 " +
  "disabled:active:translate-y-0";

/** Amber, pressed-in: for a toggle that is currently ON. */
export const RAISED_AMBER_ON =
  `${BASE} border border-amber-300/70 bg-gradient-to-b from-amber-500/35 to-amber-700/25 text-amber-50 ` +
  "shadow-[inset_0_2px_5px_rgba(0,0,0,0.5),0_1px_0_rgba(146,64,14,0.5)] " +
  "focus-visible:outline-amber-400";
