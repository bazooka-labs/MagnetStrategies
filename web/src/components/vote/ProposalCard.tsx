"use client";

import { useCallback, useEffect, useState } from "react";
import { Clock, CheckCircle2, Lock, Trophy } from "lucide-react";
import { toast } from "sonner";
import { useWallet } from "@/hooks/useWallet";
import { Panel } from "@/components/magnetfi/v2/shared";
import { VoteModal } from "@/components/vote/VoteModal";
import { getVoteRecord } from "@/lib/uvoteReads";
import { claimTokens } from "@/lib/uvoteClient";
import {
  choiceLetter, formatDate, formatU, isActive, leadingChoice, totalVotes,
  type UVoteProposal, type UVoteRecord,
} from "@/lib/uvote";

export function ProposalCard({
  proposal, uBalance, onChanged,
}: {
  proposal: UVoteProposal;
  uBalance: number;
  onChanged: () => void;
}) {
  const { activeAddress, signTransactions, algodClient } = useWallet();
  const [record, setRecord] = useState<UVoteRecord | null>(null);
  const [voteChoice, setVoteChoice] = useState<number | null>(null);
  const [claiming, setClaiming] = useState(false);

  const active = isActive(proposal);
  const total = totalVotes(proposal);
  const winner = leadingChoice(proposal);

  const refreshRecord = useCallback(async () => {
    if (!activeAddress || !algodClient) { setRecord(null); return; }
    setRecord(await getVoteRecord(algodClient, proposal.id, activeAddress));
  }, [activeAddress, algodClient, proposal.id]);

  useEffect(() => { refreshRecord(); }, [refreshRecord]);

  async function handleClaim() {
    if (!activeAddress || !algodClient) return;
    setClaiming(true);
    try {
      await claimTokens(algodClient, signTransactions, activeAddress, proposal.id);
      toast.success("Reclaimed your locked $U");
      await refreshRecord();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Claim failed.");
    } finally {
      setClaiming(false);
    }
  }

  return (
    <Panel className="p-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-base font-semibold text-white leading-snug">{proposal.question}</h3>
        {active ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-green-500/30 bg-green-500/10 px-2.5 py-0.5 text-xs font-medium text-green-400">
            <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse-slow" /> Open
          </span>
        ) : (
          <span className="inline-flex shrink-0 items-center rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-xs font-medium text-gray-400">
            Closed
          </span>
        )}
      </div>

      <p className="mt-1 flex items-center gap-1.5 text-xs text-gray-500">
        <Clock className="h-3 w-3" />
        {active ? `Closes ${formatDate(proposal.endTime)}` : `Ended ${formatDate(proposal.endTime)}`}
        <span className="text-gray-700">·</span>
        {formatU(total)} $U voted
      </p>

      {/* Choices */}
      <div className="mt-4 space-y-2">
        {proposal.choices.map((label, i) => {
          const weight = proposal.votes[i];
          const share = total > 0 ? (weight / total) * 100 : 0;
          const isMine = record?.choice === i;
          const isWinner = !active && i === winner && total > 0;
          const canVote = active && !record && !!activeAddress;
          return (
            <button
              key={i}
              disabled={!canVote}
              onClick={() => canVote && setVoteChoice(i)}
              className={`relative w-full overflow-hidden rounded-xl border px-3 py-2.5 text-left transition-colors ${
                canVote ? "border-gray-700 hover:border-magnet-500 cursor-pointer" : "border-gray-800 cursor-default"
              } ${isMine ? "border-magnet-500/60" : ""}`}
            >
              {/* result fill */}
              <div
                className={`absolute inset-y-0 left-0 ${isWinner ? "bg-green-500/15" : "bg-magnet-500/10"}`}
                style={{ width: `${share}%` }}
              />
              <div className="relative flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-sm text-white">
                  <span className="text-xs font-bold text-gray-500">{choiceLetter(i)}</span>
                  {label}
                  {isMine && <Lock className="h-3 w-3 text-magnet-400" />}
                  {isWinner && <Trophy className="h-3.5 w-3.5 text-green-400" />}
                </span>
                <span className="shrink-0 font-mono text-xs text-gray-400">
                  {share.toFixed(0)}% · {formatU(weight)}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Footer state */}
      {record && (
        <div className="mt-4 flex items-center justify-between rounded-xl border border-magnet-500/20 bg-magnet-950/30 px-3 py-2.5">
          <span className="flex items-center gap-2 text-xs text-gray-300">
            <CheckCircle2 className="h-4 w-4 text-magnet-400" />
            You locked {formatU(record.lockedAmount)} $U on {choiceLetter(record.choice)}
          </span>
          {!active && (
            <button
              onClick={handleClaim}
              disabled={claiming}
              className="rounded-lg bg-gradient-to-r from-magnet-600 to-magnet-500 px-3 py-1.5 text-xs font-semibold text-white hover:from-magnet-500 hover:to-magnet-400 disabled:opacity-40"
            >
              {claiming ? "Reclaiming…" : "Reclaim $U"}
            </button>
          )}
        </div>
      )}

      {active && !record && !activeAddress && (
        <p className="mt-4 text-center text-xs text-gray-500">Connect a wallet to vote.</p>
      )}

      {voteChoice !== null && (
        <VoteModal
          proposal={proposal}
          choiceIndex={voteChoice}
          uBalance={uBalance}
          onClose={() => setVoteChoice(null)}
          onSuccess={() => { setVoteChoice(null); refreshRecord(); onChanged(); }}
        />
      )}
    </Panel>
  );
}
