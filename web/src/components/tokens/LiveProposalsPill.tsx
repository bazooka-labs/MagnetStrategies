"use client";

/**
 * "Live proposals: N" in the mUSD hero, opening the Governance pill.
 *
 * ── Why the href is a full path and not a bare fragment ───────────────────
 * It was `#governance`, an anchor down to a section of the same page. On
 * 2026-11-04 the two parted company: the Magnet Token view moved under
 * /strategy and governance moved under /tokens, behind the mUSD page's
 * "Governance" pill — so a bare fragment pointed at an element that was not
 * in the document, which scrolls nowhere and reports nothing.
 *
 * `/tokens#governance` is read by `TokensView`, which selects the pill rather
 * than relying on the browser's anchor handling: behind a pill there is no
 * element to scroll to until the pill is chosen.
 *
 * ── It lives on the mUSD page since 2026-11-07 ────────────────────────────
 * It rode in the Magnet Token hero for three days, on a discovery argument —
 * that hero had the traffic and nothing else in the nav pointed at a vote.
 * Voting is weighted by mUSD, so the holder who can act on this is the one
 * reading the mUSD hero, and that is now where it sits: same page as the
 * Governance pill it opens, one pill away rather than one navigation.
 *
 * The href stays absolute. `/vote` and `/dao` still redirect to
 * `/tokens#governance`, the link works from anywhere if it moves again, and
 * `TokensView` keeps the URL in step with the selected pill so this is always
 * a real transition rather than a no-op from a stale hash.
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
import { useLiveProposalCount } from "@/hooks/useGovernanceProposals";
import { OPEN_GOVERNANCE } from "@/components/tokens/TokensView";

export function LiveProposalsPill() {
  /*
    The timer that keeps this honest as a window closes moved into
    `useLiveProposalCount` on 2026-11-08, when the Governance pill's dot
    became a third consumer of the same count. Its doc records the bug.
  */
  const { count: n, loading, incomplete, refresh } = useLiveProposalCount();

  // Nothing to point at before the contract is live.
  if (!GOVERNANCE_LIVE) return null;

  const open = n > 0;

  return (
    <Link
      href="/tokens#governance"
      /*
        The href handles arriving from ANOTHER page; the event handles being
        pressed on this one. Next routes a same-page hash change through the
        history API and fires no `hashchange`, so without this the URL would
        update and the Exchange pill would stay selected — a live count above
        a button that does nothing. Confirmed in a browser.

        `TokensView` ignores the event when it is not mounted, so this costs
        nothing from anywhere else.
      */
      onClick={() => window.dispatchEvent(new Event(OPEN_GOVERNANCE))}
      className={RAISED_MAGNET}
    >
      <VoteIcon className="h-3.5 w-3.5" />
      Live proposals:{" "}
      {/*
        A dash, not a zero, when a read failed.

        `incomplete` means an era could not be read, so `n` is a count of what
        we happened to receive — not of what exists. Printing it as "0" states
        a fact nobody established, and this pill's whole job is to be the one
        place that says whether a vote is open.
      */}
      <span className="font-mono font-semibold">
        {loading ? "…" : incomplete ? "—" : n}
      </span>
      {/* A quiet pulse only when something is actually open — a dot that always
          blinks stops meaning anything. */}
      {open && <span className="h-1.5 w-1.5 rounded-full bg-magnet-400 animate-pulse" />}
    </Link>
  );
}
