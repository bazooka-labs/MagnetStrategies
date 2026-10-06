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
 * ── The treasury is NOT here ───────────────────────────────────────────────
 * It is the fifth metric box at the top of both tabs now. It used to be a panel
 * beside "How it works", and showing the same balance twice on one page would
 * invite the reader to wonder which one is current.
 */

import { useCallback, useEffect, useState } from "react";
import { Lock, ShieldCheck, Sparkles, Vote as VoteIcon } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { AboutModal } from "@/components/tokens/AboutModal";
import { AdminPanel } from "@/components/vote/AdminPanel";
import { ProposalCard } from "@/components/vote/ProposalCard";
import { listProposals, getUBalance } from "@/lib/uvoteReads";
import { UVOTE_LIVE, UVOTE_ADMIN_ADDRESS, formatU, isActive, type UVoteProposal } from "@/lib/uvote";

export function GovernanceSection() {
  const { address, isConnected, algodClient } = useWallet();
  const isAdmin = isConnected && address === UVOTE_ADMIN_ADDRESS;

  const [proposals, setProposals] = useState<UVoteProposal[]>([]);
  const [uBalance, setUBalance] = useState(0);
  const [loading, setLoading] = useState(UVOTE_LIVE);
  /** Admin tooling is opt-in even for the admin — it is not what they come here to read. */
  const [adminOpen, setAdminOpen] = useState(false);

  const load = useCallback(async () => {
    if (!algodClient) return;
    setLoading(true);
    try {
      const [props, bal] = await Promise.all([
        listProposals(algodClient),
        address ? getUBalance(algodClient, address) : Promise.resolve(0),
      ]);
      setProposals(props);
      setUBalance(bal);
    } finally {
      setLoading(false);
    }
  }, [algodClient, address]);

  useEffect(() => { void load(); }, [load]);

  const open = proposals.filter((p) => isActive(p));
  const closed = proposals.filter((p) => !isActive(p));

  return (
    <section id="governance" className="mt-8 scroll-mt-24">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <VoteIcon className="h-5 w-5 text-magnet-400" />
          <h2 className="font-display text-xl font-bold text-white">Governance</h2>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* The explanation is a modal in the page's own informative-text
              style, not a wall of body copy. It was a 90-word paragraph under a
              white heading, which is the only place on this page that explained
              itself that way. */}
          <AboutModal triggerLabel="How voting works" heading="How voting works">
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
              Your $U — and a small refundable box deposit — come back in full when the vote
              closes.
            </p>
          </AboutModal>

          {isConnected && (
            <span className="inline-flex items-center gap-2 rounded-full border border-magnet-500/20 bg-magnet-950/40 px-3 py-1.5 text-xs">
              <Lock className="h-3.5 w-3.5 text-magnet-400" />
              <span className="text-gray-400">Your voting power</span>
              <span className="font-mono font-semibold text-white">{formatU(uBalance)} $U</span>
            </span>
          )}

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
      </div>

      {isAdmin && adminOpen && (
        <div className="mb-6">
          <AdminPanel onProposalCreated={load} />
        </div>
      )}

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
      ) : proposals.length === 0 ? (
        <div className="rounded-2xl border border-white/10 bg-black/30 px-6 py-12 text-center">
          <VoteIcon className="mx-auto h-8 w-8 text-gray-600" />
          <p className="mt-3 text-sm font-medium text-white">No open proposals</p>
          <p className="mt-1 text-xs text-gray-500">
            Holding $U is what gives you a vote when the next one opens.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {open.length > 0 && (
            <div>
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-gray-500">Open votes</h3>
              <div className="grid gap-4 lg:grid-cols-2">
                {open.map((p) => <ProposalCard key={p.id} proposal={p} uBalance={uBalance} onChanged={load} />)}
              </div>
            </div>
          )}
          {closed.length > 0 && (
            <div>
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-gray-500">Closed</h3>
              <div className="grid gap-4 lg:grid-cols-2">
                {closed.map((p) => <ProposalCard key={p.id} proposal={p} uBalance={uBalance} onChanged={load} />)}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
