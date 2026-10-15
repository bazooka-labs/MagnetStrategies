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
 * Colour stays per-token: amber for About, Magnet purple for Proposals.
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

/** Amber, pressed-in: for a toggle that is currently ON. */
export const RAISED_AMBER_ON =
  `${BASE} border border-amber-300/70 bg-gradient-to-b from-amber-500/35 to-amber-700/25 text-amber-50 ` +
  "shadow-[inset_0_2px_5px_rgba(0,0,0,0.5),0_1px_0_rgba(146,64,14,0.5)] " +
  "focus-visible:outline-amber-400";
