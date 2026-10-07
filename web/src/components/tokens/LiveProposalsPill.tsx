"use client";

/**
 * "Live proposals: N" in the $U hero, linking down to Governance.
 *
 * Governance moved to the foot of this page, which is the right place to read
 * it and the wrong place to DISCOVER it — a visitor who never scrolls past the
 * pools never learns there is a vote open. This pill carries that fact to the
 * top without moving the section.
 *
 * It shares its count with the section itself through `useUVoteProposals`, so a
 * pill claiming an open vote above a list showing none is not a state this page
 * can reach.
 *
 * It stays visible at zero. The number is the point either way: "0" says
 * governance exists and nothing needs you right now, which is a different and
 * more useful message than an absent pill, and it means the hero does not
 * change shape when a vote opens.
 */

import { Vote as VoteIcon } from "lucide-react";
import { UVOTE_LIVE } from "@/lib/uvote";
import { liveCount, useUVoteProposals } from "@/hooks/useUVoteProposals";

export function LiveProposalsPill() {
  const { proposals, loading } = useUVoteProposals();
  // Nothing to point at before the contract is live.
  if (!UVOTE_LIVE) return null;

  const n = liveCount(proposals);
  const open = n > 0;

  return (
    <a
      href="#governance"
      className={`inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
        open
          ? "border-magnet-500/40 bg-magnet-500/10 text-magnet-200 hover:border-magnet-400/60 hover:bg-magnet-500/15 hover:text-magnet-100"
          : "border-white/10 bg-white/[0.03] text-white/50 hover:border-white/20 hover:text-white/70"
      }`}
    >
      <VoteIcon className="h-3.5 w-3.5" />
      Live proposals:{" "}
      <span className="font-mono font-semibold">{loading ? "…" : n}</span>
      {/* A quiet pulse only when something is actually open — a dot that always
          blinks stops meaning anything. */}
      {open && <span className="h-1.5 w-1.5 rounded-full bg-magnet-400 animate-pulse" />}
    </a>
  );
}
