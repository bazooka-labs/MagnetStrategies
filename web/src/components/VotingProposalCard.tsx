"use client";

import { useState } from "react";
import { Clock, ExternalLink, Lock } from "lucide-react";
import { toast } from "sonner";
import { useWallet } from "@/hooks/useWallet";
import algosdk from "algosdk";
import { VoteModal } from "./VoteModal";
import { VOTING_APP_ID, MAGNET_TOKEN, ALGOD_URLS, VOTING_NETWORK } from "@/lib/constants";

const { decimalFactor } = MAGNET_TOKEN;
import type { VotingProposal, VoterRecord } from "@/types/dao";

interface Props {
  proposal: VotingProposal;
  voterRecord: VoterRecord | null;
  onRefresh: () => void;
}

function timeRemaining(endTime: number): string {
  const diff = endTime - Math.floor(Date.now() / 1000);
  if (diff <= 0) return "Ended";
  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h remaining`;
  const mins = Math.floor((diff % 3600) / 60);
  return `${hours}h ${mins}m remaining`;
}

function formatDate(ts: number) {
  return new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function VotingProposalCard({ proposal, voterRecord, onRefresh }: Props) {
  const { activeAddress, algodClient } = useWallet();
  const [voteModalChoice, setVoteModalChoice] = useState<number | null>(null);
  const [magnetBalance, setMagnetBalance] = useState(0);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState("");
  const { signTransactions } = useWallet();

  const isActive = Math.floor(Date.now() / 1000) < proposal.endTime;
  const isEnded = !isActive;
  // votes are stored in base units; convert to display $U for all rendering
  const votesDisplay = proposal.votes.map((v) => Math.floor(v / decimalFactor));
  const totalVotes = votesDisplay.reduce((a, b) => a + b, 0);

  async function openVoteModal(choiceIndex: number) {
    if (!activeAddress) return;
    try {
      const client = algodClient ?? new algosdk.Algodv2("", ALGOD_URLS[VOTING_NETWORK], "");
      const info = await client.accountAssetInformation(activeAddress, MAGNET_TOKEN.asaId).do();
      const bal = Number(info.assetHolding?.amount ?? 0);
      setMagnetBalance(bal);
      setVoteModalChoice(choiceIndex);
    } catch {
      setMagnetBalance(0);
      setVoteModalChoice(choiceIndex);
    }
  }

  async function handleClaim() {
    if (!activeAddress || !voterRecord) return;
    setClaiming(true);
    setClaimError("");
    try {
      const client = algodClient ?? new algosdk.Algodv2("", ALGOD_URLS[VOTING_NETWORK], "");
      const sp = await client.getTransactionParams().do();
      const enc = new TextEncoder();
      const proposalIdBytes = algosdk.encodeUint64(proposal.id);
      const senderPubKey = algosdk.decodeAddress(activeAddress).publicKey;

      const propBoxName = new Uint8Array([...enc.encode("prop_"), ...proposalIdBytes]);
      const voteBoxName = new Uint8Array([...enc.encode("vote_"), ...proposalIdBytes, ...senderPubKey]);

      // claim_tokens does an inner ASA transfer with fee=0; outer covers both via fee pooling
      sp.flatFee = true;
      sp.fee = BigInt(2000);

      const txn = algosdk.makeApplicationNoOpTxnFromObject({
        sender: activeAddress,
        appIndex: VOTING_APP_ID,
        appArgs: [enc.encode("claim_tokens"), proposalIdBytes],
        boxes: [
          { appIndex: VOTING_APP_ID, name: propBoxName },
          { appIndex: VOTING_APP_ID, name: voteBoxName },
        ],
        foreignAssets: [MAGNET_TOKEN.asaId],
        suggestedParams: sp,
      });

      const signed = await signTransactions([algosdk.encodeUnsignedTransaction(txn)]);
      if (!signed?.[0]) throw new Error("Signing cancelled.");
      const result = await client.sendRawTransaction(signed[0]).do();
      await algosdk.waitForConfirmation(client, result.txid, 4);
      toast.success(`${Math.floor(voterRecord.lockedAmount / decimalFactor).toLocaleString()} $U returned to your wallet`);
      onRefresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Claim failed.";
      setClaimError(msg);
      toast.error(msg);
    } finally {
      setClaiming(false);
    }
  }

  return (
    <>
      <div className="rounded-xl border border-gray-800/60 bg-surface-light p-6 hover:border-gray-700/60 transition-colors">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 mb-5">
          <h3 className="text-base font-semibold text-white leading-snug">{proposal.question}</h3>
          <div className={`flex-shrink-0 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
            isActive
              ? "bg-green-500/10 border border-green-500/20 text-green-400"
              : "bg-gray-800 border border-gray-700 text-gray-500"
          }`}>
            <span className={`h-1.5 w-1.5 rounded-full ${isActive ? "bg-green-400 animate-pulse" : "bg-gray-500"}`} />
            {isActive ? timeRemaining(proposal.endTime) : "Ended"}
          </div>
        </div>

        {/* Choices */}
        <div className="space-y-3">
          {proposal.choices.map((choice, i) => {
            if (!choice.trim()) return null;
            const weight = votesDisplay[i] ?? 0;
            const pct = totalVotes > 0 ? Math.round((weight / totalVotes) * 100) : 0;
            const isMyVote = voterRecord?.choice === i;

            return (
              <div key={i}>
                <div className="flex items-center justify-between text-sm mb-1.5">
                  <div className="flex items-center gap-2">
                    <span className="w-5 text-center text-xs font-bold text-gray-600">
                      {String.fromCharCode(65 + i)}
                    </span>
                    <span className={`${isMyVote ? "text-magnet-300 font-semibold" : "text-gray-300"}`}>
                      {choice}
                    </span>
                    {isMyVote && (
                      <span className="text-xs text-magnet-500">← your vote</span>
                    )}
                  </div>
                  <span className="text-gray-500 text-xs">{pct}%</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-2 rounded-full bg-gray-800/80 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        isMyVote
                          ? "bg-gradient-to-r from-magnet-600 to-magnet-400"
                          : "bg-gray-700"
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="w-24 text-right text-xs text-gray-600">
                    {weight.toLocaleString()} $U
                  </span>
                </div>

                {/* Vote button per choice */}
                {isActive && activeAddress && !voterRecord && (
                  <button
                    onClick={() => openVoteModal(i)}
                    className="mt-2 ml-7 rounded-lg border border-magnet-700/30 bg-magnet-900/10 px-4 py-1.5 text-xs font-semibold text-magnet-400 hover:bg-magnet-900/20 hover:border-magnet-600/40 transition-all"
                  >
                    Vote {String.fromCharCode(65 + i)}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="mt-5 pt-4 border-t border-gray-800/60 flex items-center justify-between text-xs text-gray-600">
          <div className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            <span>{formatDate(proposal.startTime)} → {formatDate(proposal.endTime)}</span>
          </div>
          <div className="flex items-center gap-3">
            <span>{totalVotes.toLocaleString()} $U cast</span>
            <a
              href={`https://lora.algokit.io/mainnet/application/${VOTING_APP_ID}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-magnet-400 transition-colors"
            >
              Contract <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>

        {/* Wallet states */}
        {!activeAddress && isActive && (
          <p className="mt-3 text-xs text-gray-600">Connect wallet to vote</p>
        )}

        {voterRecord && isActive && (
          <div className="mt-3 flex items-center gap-1.5 text-xs text-yellow-500">
            <Lock className="h-3 w-3" />
            <span>Your {Math.floor(voterRecord.lockedAmount / decimalFactor).toLocaleString()} $U are locked until voting ends</span>
          </div>
        )}

        {voterRecord && isEnded && (
          <div className="mt-3">
            <button
              onClick={handleClaim}
              disabled={claiming}
              className="rounded-lg bg-gradient-to-r from-magnet-600 to-magnet-500 px-4 py-2 text-xs font-semibold text-white hover:from-magnet-500 hover:to-magnet-400 transition-all disabled:opacity-50"
            >
              {claiming ? "Claiming…" : `Claim ${Math.floor(voterRecord.lockedAmount / decimalFactor).toLocaleString()} $U`}
            </button>
            {claimError && <p className="mt-1.5 text-xs text-red-400">{claimError}</p>}
          </div>
        )}
      </div>

      {voteModalChoice !== null && (
        <VoteModal
          proposal={proposal}
          choiceIndex={voteModalChoice}
          magnetBalance={magnetBalance}
          onClose={() => setVoteModalChoice(null)}
          onSuccess={() => { setVoteModalChoice(null); onRefresh(); }}
        />
      )}
    </>
  );
}
