"use client";

import { useCallback, useEffect, useState } from "react";
import { Vote as VoteIcon, Lock, Sparkles } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { AdminPanel } from "@/components/vote/AdminPanel";
import { ProposalCard } from "@/components/vote/ProposalCard";
import { listProposals, getUBalance } from "@/lib/uvoteReads";
import { UVOTE_LIVE, UVOTE_ADMIN_ADDRESS, formatU, isActive, type UVoteProposal } from "@/lib/uvote";

export default function VotePage() {
  const { address, isConnected, algodClient } = useWallet();
  const isAdmin = isConnected && address === UVOTE_ADMIN_ADDRESS;

  const [proposals, setProposals] = useState<UVoteProposal[]>([]);
  const [uBalance, setUBalance] = useState(0);
  const [loading, setLoading] = useState(UVOTE_LIVE);

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

  useEffect(() => { load(); }, [load]);

  const open = proposals.filter((p) => isActive(p));
  const closed = proposals.filter((p) => !isActive(p));

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 lg:px-8">
      {/* Hero */}
      <div className="relative mb-8 overflow-hidden rounded-2xl border border-white/10 bg-black/40 px-6 py-8 backdrop-blur-sm sm:px-10 sm:py-10">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-magnet-500/60 to-transparent" />
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="animate-blob-drift absolute -right-16 -top-16 h-56 w-56 rounded-full bg-magnet-600/20 blur-3xl" />
        </div>
        <div className="relative flex items-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-magnet-600 to-magnet-800 shadow-lg shadow-magnet-900/50 shrink-0">
            <VoteIcon className="h-7 w-7 text-white drop-shadow" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white sm:text-3xl">UVote</h1>
            <p className="mt-1 text-sm text-gray-400">
              Founder-led governance. Lock $U to help shape protocol direction.
            </p>
          </div>
        </div>

        <p className="relative mt-5 max-w-2xl text-sm leading-relaxed text-gray-400">
          The admin posts a direction question — liquidity, parameters, or where the protocol invests next.
          Holders signal by locking whole $U for the 7-day window; your $U (and a small refundable box
          deposit) come back in full when the vote closes. Votes are <span className="text-gray-300">advisory</span>:
          they guide the founder, who executes under the protocol&apos;s existing safeguards.
        </p>

        {isConnected && (
          <div className="relative mt-5 inline-flex items-center gap-2 rounded-full border border-magnet-500/20 bg-magnet-950/40 px-3 py-1.5 text-xs">
            <Lock className="h-3.5 w-3.5 text-magnet-400" />
            <span className="text-gray-400">Your voting power</span>
            <span className="font-mono font-semibold text-white">{formatU(uBalance)} $U</span>
          </div>
        )}
      </div>

      {/* Admin */}
      {isAdmin && (
        <div className="mb-8">
          <AdminPanel onProposalCreated={load} />
        </div>
      )}

      {/* Body */}
      {!UVOTE_LIVE ? (
        <div className="rounded-2xl border border-white/10 bg-black/30 px-6 py-12 text-center">
          <Sparkles className="mx-auto h-8 w-8 text-magnet-400" />
          <p className="mt-3 text-sm font-medium text-white">UVote is launching soon</p>
          <p className="mt-1 text-xs text-gray-500">
            {isAdmin ? "Deploy the contract above to open governance." : "Governance opens once the contract is live."}
          </p>
        </div>
      ) : loading ? (
        <p className="py-12 text-center text-sm text-gray-500">Loading proposals…</p>
      ) : proposals.length === 0 ? (
        <div className="rounded-2xl border border-white/10 bg-black/30 px-6 py-12 text-center">
          <VoteIcon className="mx-auto h-8 w-8 text-gray-600" />
          <p className="mt-3 text-sm font-medium text-white">No proposals yet</p>
          <p className="mt-1 text-xs text-gray-500">Check back when the founder opens the first vote.</p>
        </div>
      ) : (
        <div className="space-y-8">
          {open.length > 0 && (
            <section>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-gray-500">Open votes</h2>
              <div className="space-y-4">
                {open.map((p) => <ProposalCard key={p.id} proposal={p} uBalance={uBalance} onChanged={load} />)}
              </div>
            </section>
          )}
          {closed.length > 0 && (
            <section>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-gray-500">Closed</h2>
              <div className="space-y-4">
                {closed.map((p) => <ProposalCard key={p.id} proposal={p} uBalance={uBalance} onChanged={load} />)}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
