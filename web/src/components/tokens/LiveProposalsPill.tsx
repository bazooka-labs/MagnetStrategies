"use client";

/**
 * "Live proposals: N" in the Magnet Token hero, linking ACROSS to Governance.
 *
 * ── Why the link leaves the page ───────────────────────────────────────────
 * It used to be `#governance`, an anchor down to a section of the same page.
 * On 2026-11-04 the two parted company: the Magnet Token view moved under
 * /strategy and governance moved under /tokens, behind the mUSD page's
 * "Governance" pill. A bare `#governance` from /strategy now points at an
 * element that is not in the document, which scrolls nowhere and reports
 * nothing — so this is a real cross-page link, and `/tokens#governance` is
 * read by TokensView to open the Governance pill on arrival.
 *
 * Voting is weighted by mUSD since 2026-11-05, so the holder this pill concerns
 * is an mUSD holder — not the $U holder reading the hero it sits in. It stays
 * here anyway, because discovery is the job: a visitor on the Magnet Token page
 * is a protocol participant, and this is the only standing pointer to an open
 * vote anywhere in the nav.
 *
 * It shares its count with the section itself through `useGovernanceProposals`,
 * so a pill claiming an open vote above a list showing none is not a state the
 * app can reach. Both apply the same `era.accepting && isActive(p)` predicate;
 * they disagreed once, when only one of them checked the era.
 *
 * It stays visible at zero. The number is the point either way: "0" says
 * governance exists and nothing needs you right now, which is a different and
 * more useful message than an absent pill, and it means the hero does not
 * change shape when a vote opens.
 *
 * One colour — Magnet purple — whatever the count. An earlier version went grey
 * at zero, which made the pill read as disabled rather than as a live figure
 * that currently says none. The pulsing dot, present only when something is
 * actually open, carries that difference instead: a dot that always blinks
 * stops meaning anything, and a pill that changes colour reads as two controls.
 */

import Link from "next/link";
import { Vote as VoteIcon } from "lucide-react";
import { RAISED_MAGNET } from "../raisedButton";
import { GOVERNANCE_LIVE } from "@/lib/governance";
import { liveCount, useGovernanceProposals } from "@/hooks/useGovernanceProposals";

export function LiveProposalsPill() {
  const { proposals, loading } = useGovernanceProposals();
  // Nothing to point at before the contract is live.
  if (!GOVERNANCE_LIVE) return null;

  const n = liveCount(proposals);
  const open = n > 0;

  return (
    <Link
      href="/tokens#governance"
      className={RAISED_MAGNET}
    >
      <VoteIcon className="h-3.5 w-3.5" />
      Live proposals:{" "}
      <span className="font-mono font-semibold">{loading ? "…" : n}</span>
      {/* A quiet pulse only when something is actually open — a dot that always
          blinks stops meaning anything. */}
      {open && <span className="h-1.5 w-1.5 rounded-full bg-magnet-400 animate-pulse" />}
    </Link>
  );
}
