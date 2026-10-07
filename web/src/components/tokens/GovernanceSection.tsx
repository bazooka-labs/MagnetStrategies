"use client";

/**
 * UVote, as a section of the $U page rather than a page of its own.
 *
 * ── Why it moved ───────────────────────────────────────────────────────────
 * One proposal had ever been opened. A standing nav entry that usually leads to
 * "check back when the founder opens the first vote" costs more than it buys,
 * and everything $U — swap, pools, governance — now reads in one place.
 *
 * ── Why it is a section and not a third tab ────────────────────────────────
 * The tabs above are ASSETS: Magnet ($U) and mUSD. Voting is an activity, and
 * sitting it beside two tokens as though it were a third one misdescribes it.
 * The cost of being a section instead is that its empty state lands on the
 * page; that is paid for by keeping it at the bottom, under the pools.
 *
 * ── Why "How voting works" is permanent and not a modal ────────────────────
 * It was briefly an `AboutModal`, matching how the token blurbs explain
 * themselves. Wrong call: those modals answer a question a reader may already
 * know the answer to, while this one explains a mechanism that locks their
 * tokens for seven days. Rules you must understand BEFORE acting do not belong
 * one click away. It keeps the amber treatment so it still reads as the page's
 * informative voice.
 *
 * ── The treasury is NOT here ───────────────────────────────────────────────
 * It is the fifth metric box at the top of both tabs now. It used to be a panel
 * beside "How it works", and showing the same balance twice on one page would
 * invite the reader to wonder which one is current.
 */

import { useCallback, useEffect, useState } from "react";
import { Info, ShieldCheck, Sparkles, Vote as VoteIcon } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { AdminPanel } from "@/components/vote/AdminPanel";
import { ProposalCard } from "@/components/vote/ProposalCard";
import { getUBalance } from "@/lib/uvoteReads";
import { useUVoteProposals } from "@/hooks/useUVoteProposals";
import { UVOTE_LIVE, UVOTE_ADMIN_ADDRESS, formatU, isActive } from "@/lib/uvote";

export function GovernanceSection() {
  const { address, isConnected, algodClient } = useWallet();
  const isAdmin = isConnected && address === UVOTE_ADMIN_ADDRESS;

  /**
   * The proposals come from the shared store, not a fetch of our own: the hero
   * pill counts the same list, and two reads would be two numbers that can
   * disagree about whether a vote is open.
   */
  const { proposals, loading, refresh } = useUVoteProposals();
  /** The balance is per-wallet, so it stays local — nothing else on the page shows it. */
  const [uBalance, setUBalance] = useState(0);
  /** Admin tooling is opt-in even for the admin — it is not what they come here to read. */
  const [adminOpen, setAdminOpen] = useState(false);

  useEffect(() => {
    if (!algodClient || !address) { setUBalance(0); return; }
    let alive = true;
    void getUBalance(algodClient, address).then((b) => { if (alive) setUBalance(b); });
    return () => { alive = false; };
  }, [algodClient, address]);

  /** After a vote or a claim: re-read the proposals AND this wallet's balance. */
  const load = useCallback(() => {
    refresh();
    if (algodClient && address) void getUBalance(algodClient, address).then(setUBalance);
  }, [refresh, algodClient, address]);

  /*
   * Live: soonest to close first — the one with a deadline is the one that
   * needs a decision. History: most recently ended first, so the newest result
   * is at the top and the list grows downward into the past.
   */
  const live = proposals.filter((p) => isActive(p)).sort((a, b) => a.endTime - b.endTime);
  const history = proposals.filter((p) => !isActive(p)).sort((a, b) => b.endTime - a.endTime);

  return (
    <section id="governance" className="mt-8 scroll-mt-24">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <VoteIcon className="h-5 w-5 text-magnet-400" />
          <h2 className="font-display text-xl font-bold text-white">Governance</h2>
        </div>

        {/* Admin, as a pill — the same treatment MagnetFi gives its own, and
            invisible to everyone else. */}
        {isAdmin && (
          <button
            type="button"
            onClick={() => setAdminOpen((v) => !v)}
            aria-expanded={adminOpen}
            className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/30 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-200 transition-colors hover:border-amber-400/50 hover:bg-amber-500/15 hover:text-amber-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500"
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            Admin
          </button>
        )}
      </div>

      {isAdmin && adminOpen && (
        <div className="mb-6">
          <AdminPanel onProposalCreated={load} />
        </div>
      )}

      {/* ── How voting works ──────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-amber-400/25 bg-amber-500/[0.06] p-5 sm:p-6">
        <div className="flex items-center gap-2">
          <Info className="h-4 w-4 shrink-0 text-amber-300" />
          <h3 className="font-display text-base font-semibold text-amber-200">How voting works</h3>
        </div>
        <div className="mt-3 space-y-3 text-sm leading-relaxed text-gray-400">
          <p>
            The Founder posts an open question that impacts a particular outcome of Magnet
            Strategies. Holders can then exercise their voice by utilizing held $U tokens,
            signaling their preference on the open proposal.
          </p>
          <p>
            Only whole $U tokens can be used, where one token is equal to one vote in weight.
            Tokens are accepted as voting power by being locked within the voting contract, and
            remain locked for the remainder of the voting window.
          </p>
          <p>
            Your $U — and a small refundable box deposit — come back in full when the vote closes.
          </p>
        </div>

        {/* Vote power, full width inside the explanation.
            It sits HERE rather than in the header row because the number only
            means anything next to the sentence that says one whole token is one
            vote. As a lone pill it was a figure without a unit. */}
        <div className="mt-5 rounded-xl border border-white/10 bg-black/30 px-5 py-4">
          {/* White label, Magnet-purple figure — the inverse of the metric row
              above, where the label is grey and the colour carries the number.
              Here the box sits inside an amber panel, so a grey label would
              read as disabled against it. */}
          <p className="text-xs font-medium uppercase tracking-wider text-white">
            Current vote power
          </p>
          <p className="mt-1.5 font-mono text-2xl font-bold text-magnet-400">
            {isConnected ? `${formatU(uBalance)} $U` : "—"}
          </p>
          <p className="mt-0.5 text-xs text-gray-500">
            {isConnected
              ? "Whole $U only — fractions do not count toward a vote"
              : "Connect a wallet to see your voting power"}
          </p>
        </div>
      </div>

      {/* ── Live proposals ────────────────────────────────────────────────── */}
      <h3 className="mb-3 mt-8 text-xs font-semibold uppercase tracking-widest text-gray-500">
        Live proposals
      </h3>
      {!UVOTE_LIVE ? (
        <div className="rounded-2xl border border-white/10 bg-black/30 px-6 py-12 text-center">
          <Sparkles className="mx-auto h-8 w-8 text-magnet-400" />
          <p className="mt-3 text-sm font-medium text-white">UVote is launching soon</p>
          <p className="mt-1 text-xs text-gray-500">
            {isAdmin ? "Deploy the contract to open governance." : "Governance opens once the contract is live."}
          </p>
        </div>
      ) : loading ? (
        <p className="py-12 text-center text-sm text-gray-500">Loading proposals…</p>
      ) : live.length === 0 ? (
        /* Named, not blank. A reader who cannot tell the difference between
           "nothing to vote on" and "this is broken" assumes the latter. */
        <div className="rounded-2xl border border-white/10 bg-black/30 px-6 py-12 text-center">
          <VoteIcon className="mx-auto h-8 w-8 text-gray-600" />
          <p className="mt-3 text-sm font-medium text-white">Nothing to vote on right now</p>
          <p className="mt-1 text-xs text-gray-500">
            There are no live proposals. Holding $U is what gives you a vote when the next one opens.
          </p>
        </div>
      ) : (
        /* Full width and stacked rather than two across: a proposal is a
           question with choices and a tally, and halving its width wrapped the
           question before the reader got to the options. */
        <div className="space-y-4">
          {live.map((p) => <ProposalCard key={p.id} proposal={p} uBalance={uBalance} onChanged={load} />)}
        </div>
      )}

      {/* ── Voting history ────────────────────────────────────────────────── */}
      {history.length > 0 && (
        <>
          <h3 className="mb-3 mt-8 text-xs font-semibold uppercase tracking-widest text-gray-500">
            Voting history
          </h3>
          <div className="space-y-4">
            {history.map((p) => <ProposalCard key={p.id} proposal={p} uBalance={uBalance} onChanged={load} />)}
          </div>
        </>
      )}
    </section>
  );
}
