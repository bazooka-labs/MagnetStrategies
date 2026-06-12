"use client";

import { useState } from "react";
import { X, Lock } from "lucide-react";
import { toast } from "sonner";
import { useWallet } from "@/hooks/useWallet";
import algosdk from "algosdk";
import { VOTING_APP_ID, MAGNET_TOKEN, ALGOD_URLS, VOTING_NETWORK } from "@/lib/constants";
import type { VotingProposal } from "@/types/dao";

interface Props {
  proposal: VotingProposal;
  choiceIndex: number;
  magnetBalance: number;
  onClose: () => void;
  onSuccess: () => void;
}

function formatDate(ts: number) {
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function VoteModal({ proposal, choiceIndex, magnetBalance, onClose, onSuccess }: Props) {
  const { activeAddress, signTransactions, algodClient } = useWallet();
  const [status, setStatus] = useState<"idle" | "signing" | "confirming" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const choiceLabel = proposal.choices[choiceIndex];
  const lockUntil = formatDate(proposal.endTime);

  // Approach 2: only whole $U locked — fractional dust stays in wallet
  const { decimalFactor } = MAGNET_TOKEN;
  const depositBaseUnits = Math.floor(magnetBalance / decimalFactor) * decimalFactor;
  const voteCount = depositBaseUnits / decimalFactor;
  const dustBaseUnits = magnetBalance - depositBaseUnits;
  const dustDisplay = (dustBaseUnits / decimalFactor).toFixed(5).replace(/\.?0+$/, "");
  const hasDust = dustBaseUnits > 0;

  async function handleVote() {
    if (!activeAddress || depositBaseUnits === 0) return;
    setStatus("signing");
    setErrorMsg("");

    try {
      const client = algodClient ?? new algosdk.Algodv2("", ALGOD_URLS[VOTING_NETWORK], "");
      const sp = await client.getTransactionParams().do();

      const enc = new TextEncoder();
      const proposalIdBytes = algosdk.encodeUint64(proposal.id);
      const senderPubKey = algosdk.decodeAddress(activeAddress).publicKey;

      const propBoxName = new Uint8Array([...enc.encode("prop_"), ...proposalIdBytes]);
      const voteBoxName = new Uint8Array([...enc.encode("vote_"), ...proposalIdBytes, ...senderPubKey]);

      // [0] AppCall: cast_vote(proposal_id, choice_index)
      const appCallTxn = algosdk.makeApplicationNoOpTxnFromObject({
        sender: activeAddress,
        appIndex: VOTING_APP_ID,
        appArgs: [
          enc.encode("cast_vote"),
          proposalIdBytes,
          algosdk.encodeUint64(choiceIndex),
        ],
        boxes: [
          { appIndex: VOTING_APP_ID, name: propBoxName },
          { appIndex: VOTING_APP_ID, name: voteBoxName },
        ],
        foreignAssets: [MAGNET_TOKEN.asaId],
        suggestedParams: sp,
      });

      // [1] AssetTransfer: lock whole-token amount only (no fractional dust)
      const transferTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: activeAddress,
        receiver: algosdk.getApplicationAddress(VOTING_APP_ID),
        assetIndex: MAGNET_TOKEN.asaId,
        amount: depositBaseUnits,
        suggestedParams: sp,
      });

      algosdk.assignGroupID([appCallTxn, transferTxn]);

      const signed = await signTransactions([
        algosdk.encodeUnsignedTransaction(appCallTxn),
        algosdk.encodeUnsignedTransaction(transferTxn),
      ]);
      if (!signed?.[0] || !signed?.[1]) throw new Error("Transaction signing cancelled.");

      setStatus("confirming");
      const result = await client.sendRawTransaction([signed[0], signed[1]]).do();
      await algosdk.waitForConfirmation(client, result.txid, 4);

      setStatus("idle");
      toast.success("Vote cast — tokens locked until voting ends");
      onSuccess();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Vote failed.";
      setErrorMsg(msg);
      setStatus("error");
      toast.error(msg);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      <div className="relative w-full max-w-sm rounded-2xl border border-magnet-500/20 bg-gray-950 shadow-2xl overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-magnet-500/50 to-transparent" />

        <div className="p-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-lg font-bold text-white">Confirm Vote</h2>
            <button onClick={onClose} className="text-gray-600 hover:text-gray-300 transition-colors">
              <X className="h-5 w-5" />
            </button>
          </div>

          {depositBaseUnits === 0 ? (
            <p className="py-4 text-center text-sm text-gray-500">
              You need at least 1 $U to vote.
            </p>
          ) : (
            <div className="space-y-4">
              <div className="rounded-xl border border-magnet-500/20 bg-magnet-950/30 p-4">
                <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-1">Your Choice</p>
                <p className="text-white font-semibold">{String.fromCharCode(65 + choiceIndex)}. {choiceLabel}</p>
              </div>

              <div className="rounded-xl border border-gray-800 bg-black/20 p-4 space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-500">Voting power</span>
                  <span className="font-semibold text-white">{voteCount.toLocaleString()} $U</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-500">Locked until vote ends</span>
                  <span className="text-yellow-400 font-medium">{voteCount.toLocaleString()} $U</span>
                </div>
                {hasDust && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-gray-500">Stays in your wallet</span>
                    <span className="text-gray-400">{dustDisplay} $U</span>
                  </div>
                )}
                <div className="flex items-start gap-2 pt-1 border-t border-gray-800 text-xs text-gray-500">
                  <Lock className="h-3 w-3 text-yellow-500 mt-0.5 flex-shrink-0" />
                  <span>Unlocks: <span className="text-yellow-400">{lockUntil}</span></span>
                </div>
              </div>

              <p className="text-xs text-gray-600 leading-relaxed">
                Only whole $U tokens are locked. Fractional amounts stay in your wallet and remain accessible during the vote.
              </p>
            </div>
          )}

          {status === "error" && (
            <p className="mt-4 text-xs text-red-400">{errorMsg}</p>
          )}

          <div className="mt-6 flex gap-3">
            <button
              onClick={handleVote}
              disabled={depositBaseUnits === 0 || status === "signing" || status === "confirming"}
              className="flex-1 rounded-lg bg-gradient-to-r from-magnet-600 to-magnet-500 py-2.5 text-sm font-semibold text-white hover:from-magnet-500 hover:to-magnet-400 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {status === "signing" && "Waiting for signature…"}
              {status === "confirming" && "Confirming on-chain…"}
              {(status === "idle" || status === "error") && "Lock & Vote"}
            </button>
            <button
              onClick={onClose}
              className="rounded-lg border border-gray-700 px-4 py-2.5 text-sm text-gray-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
