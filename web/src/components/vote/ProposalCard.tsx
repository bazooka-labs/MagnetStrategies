"use client";

import { useCallback, useEffect, useState } from "react";
import { Clock, CheckCircle2, Lock, Trophy } from "lucide-react";
import { toast } from "sonner";
import { useWallet } from "@/hooks/useWallet";
import { Panel } from "@/components/magnetfi/v2/shared";
import { VoteModal } from "@/components/vote/VoteModal";
import { getVoteRecord } from "@/lib/governanceReads";
import { claimTokens } from "@/lib/governanceClient";
import {
  choiceLetter, formatDate, formatWeight, isActive, leadingChoice, totalVotes,
  type Proposal, type VoteRecord,
} from "@/lib/governance";

/**
 * One proposal, from whichever contract generation it belongs to.
 *
 * Every weight on this card is formatted through `proposal.era`, never through
 * a module constant. The retired $U contract and the live mUSD one write the
 * same bytes at the same box offsets with different decimals and different
 * meanings, so a card that took its unit from config would print the legacy
 * proposal's 35 $U as "35 mUSD" on a page about mUSD.
 */
export function ProposalCard({
  proposal, balance, onChanged,
}: {
  proposal: Proposal;
  /**
   * The voter's balance of THIS proposal's voting asset, in base units.
   * `null` means unknown — either not read yet, or the read failed. It does
   * not mean zero.
   */
  balance: number | null;
  onChanged: () => void;
}) {
  const { activeAddress, signTransactions, algodClient } = useWallet();
  const [record, setRecord] = useState<VoteRecord | null>(null);
  /**
   * Whether we actually know the answer about this wallet's vote.
   *
   * `record === null` used to carry two meanings at once — "they have not
   * voted" and "the read threw" — and the second one is dangerous after the
   * window closes, because the Reclaim button is gated on having a record. A
   * voter with locked mUSD was shown no way to get it back.
   */
  const [recordState, setRecordState] = useState<"loading" | "loaded" | "error">("loading");
  const era = proposal.era;
  const [voteChoice, setVoteChoice] = useState<number | null>(null);
  const [claiming, setClaiming] = useState(false);

  const active = isActive(proposal);
  const total = totalVotes(proposal);
  const winner = leadingChoice(proposal);

  const refreshRecord = useCallback(async () => {
    if (!activeAddress || !algodClient) {
      setRecord(null);
      setRecordState("loaded");   // nothing to know without a wallet
      return;
    }
    setRecordState("loading");
    try {
      setRecord(await getVoteRecord(algodClient, era, proposal.id, activeAddress));
      setRecordState("loaded");
    } catch {
      setRecord(null);
      setRecordState("error");
    }
  }, [activeAddress, algodClient, era, proposal.id]);

  useEffect(() => {
    // Clear FIRST, synchronously, on a wallet change. `setRecord` only ran
    // after the await, so switching accounts left the previous wallet's
    // "You locked N" line and its Reclaim button sitting under the new one —
    // and racing responses could land out of order. Same fix, and the same
    // reason, as the owner-change clear in usePerpsPositions.
    setRecord(null);
    setRecordState("loading");
    void refreshRecord();
  }, [refreshRecord]);

  async function handleClaim() {
    if (!activeAddress || !algodClient) return;
    setClaiming(true);
    try {
      await claimTokens(algodClient, signTransactions, activeAddress, proposal.id, era);
      toast.success(`Reclaimed your locked ${era.unit}`);
      await refreshRecord();
      onChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/confirm|timeout|timed out|pending/i.test(msg)) {
        // The group was submitted and may yet land. Saying "Claim failed" here
        // would be a confident false statement about money — CLAUDE.md's
        // "report outcomes faithfully" is exactly this case.
        toast(`Submitted, but we couldn't confirm it in time. Check your wallet before retrying.`);
        await refreshRecord();
        onChanged();
      } else {
        toast.error(msg || "Claim failed.");
      }
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

      {/* Which contract this was voted on. Shown only for the retired one:
          labelling every current proposal "mVote" is noise, but a $U-weighted
          tally sitting in a list on the mUSD page needs to say why. */}
      <div>
        {!era.accepting && (
          <span className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-amber-400/25 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-medium text-amber-200">
            {era.name} · weighted by {era.unit}
          </span>
        )}
      </div>

      <p className="mt-1 flex items-center gap-1.5 text-xs text-gray-500">
        <Clock className="h-3 w-3" />
        {active ? `Closes ${formatDate(proposal.endTime)}` : `Ended ${formatDate(proposal.endTime)}`}
        <span className="text-gray-700">·</span>
        {formatWeight(era, total)} {era.unit} voted
      </p>

      {/* Choices */}
      <div className="mt-4 space-y-2">
        {proposal.choices.map((label, i) => {
          const weight = proposal.votes[i];
          const share = total > 0 ? (weight / total) * 100 : 0;
          const isMine = record?.choice === i;
          const isWinner = !active && i === winner && total > 0;
          // A retired era is readable and claimable, never votable.
          // `recordState === "loaded"` is required: offering a vote while the
          // record is unknown sends someone who already voted into a wallet
          // prompt the contract rejects on its one-vote-per-wallet check.
          const canVote = active && era.accepting && recordState === "loaded"
            && !record && !!activeAddress;
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
                  {share.toFixed(0)}% · {formatWeight(era, weight)}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Footer state */}
      {/*
        Unknown, said out loud — and the Reclaim button offered anyway once the
        window has closed.

        The alternative is hiding it, which is what the code did before: a
        voter with locked mUSD and a flaky connection saw a closed proposal
        with no way to reclaim and no explanation. Offering it costs a rejected
        transaction at worst, and the contract refuses a claim with no vote on
        record. Showing nothing costs someone their funds in appearance, which
        is the error that matters.
      */}
      {recordState === "error" && activeAddress && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2.5">
          <span className="text-xs text-amber-200">
            Couldn&apos;t check whether you voted on this one.{" "}
            <button onClick={() => void refreshRecord()} className="underline underline-offset-2 hover:text-amber-100">
              Retry
            </button>
          </span>
          {!active && (
            <button
              onClick={handleClaim}
              disabled={claiming}
              className="rounded-lg border border-amber-400/40 px-3 py-1.5 text-xs font-semibold text-amber-100 hover:bg-amber-500/15 disabled:opacity-40"
            >
              {claiming ? "Reclaiming…" : `Try reclaim ${era.unit}`}
            </button>
          )}
        </div>
      )}

      {record && (
        <div className="mt-4 flex items-center justify-between rounded-xl border border-magnet-500/20 bg-magnet-950/30 px-3 py-2.5">
          <span className="flex items-center gap-2 text-xs text-gray-300">
            <CheckCircle2 className="h-4 w-4 text-magnet-400" />
            You locked {formatWeight(era, record.lockedAmount)} {era.unit} on {choiceLetter(record.choice)}
          </span>
          {!active && (
            <button
              onClick={handleClaim}
              disabled={claiming}
              className="rounded-lg bg-gradient-to-r from-magnet-600 to-magnet-500 px-3 py-1.5 text-xs font-semibold text-white hover:from-magnet-500 hover:to-magnet-400 disabled:opacity-40"
            >
              {claiming ? "Reclaiming…" : `Reclaim ${era.unit}`}
            </button>
          )}
        </div>
      )}

      {active && era.accepting && !record && !activeAddress && (
        <p className="mt-4 text-center text-xs text-gray-500">Connect a wallet to vote.</p>
      )}

      {active && era.accepting && activeAddress && recordState === "loading" && (
        <p className="mt-4 text-center text-xs text-gray-500">Checking whether you have voted…</p>
      )}

      {voteChoice !== null && (
        <VoteModal
          proposal={proposal}
          choiceIndex={voteChoice}
          balance={balance}
          onClose={() => setVoteChoice(null)}
          onSuccess={() => { setVoteChoice(null); refreshRecord(); onChanged(); }}
        />
      )}
    </Panel>
  );
}
