"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Lock } from "lucide-react";
import { toast } from "sonner";
import { useWallet } from "@/hooks/useWallet";
import { castVote } from "@/lib/governanceClient";
import {
  VOTE_BOX_MBR, choiceLetter, formatDate, isUnconfirmed,
  type Proposal,
} from "@/lib/governance";

interface Props {
  proposal: Proposal;
  choiceIndex: number;
  /** Base units of this proposal's voting asset; `null` when unknown. */
  balance: number | null;
  onClose: () => void;
  onSuccess: () => void;
  /**
   * The group was submitted but we never saw it confirm.
   *
   * Distinct from `onSuccess`, which re-reads the vote record — and that read
   * returns no box while the transaction is still in flight, so the card
   * concluded "not voted" and re-enabled the vote buttons on a vote that was
   * very likely about to land.
   */
  onUnconfirmed: () => void;
}

export function VoteModal({ proposal, choiceIndex, balance, onClose, onSuccess, onUnconfirmed }: Props) {
  // Decimals come from the proposal's own era. The live contract asserts
  // `amount % 10^6 == 0`; flooring with the wrong factor would build a group
  // the chain rejects, or lock 10x what the voter typed.
  const era = proposal.era;
  const factor = 10 ** era.decimals;
  const { activeAddress, signTransactions, algodClient } = useWallet();
  const [status, setStatus] = useState<"idle" | "signing" | "confirming" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  // Portal to body so the overlay escapes the proposal card's backdrop-filter
  // containing block + overflow-hidden (otherwise it's clipped inside the card).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const known = balance !== null;
  const maxWhole = known ? Math.floor(balance / factor) : 0; // whole tokens available
  const [amount, setAmount] = useState<string>(maxWhole > 0 ? String(maxWhole) : "");
  const voteCount = Math.min(Math.max(Math.floor(Number(amount) || 0), 0), maxWhole);
  const lockBaseUnits = voteCount * factor;
  const busy = status === "signing" || status === "confirming";

  async function handleVote() {
    if (!activeAddress || !algodClient || lockBaseUnits === 0) return;
    setStatus("signing");
    setErrorMsg("");
    try {
      // "Confirming on-chain…" was in the UI and unreachable, because nothing
      // ever moved past "signing". `castVote` prompts the wallet and then
      // waits for confirmation, and most of the wall-clock time is the wait.
      setStatus("confirming");
      await castVote(algodClient, signTransactions, activeAddress, proposal.id, choiceIndex, lockBaseUnits, era);
      setStatus("idle");
      toast.success(`Vote cast — ${era.unit} locked until the vote closes`);
      onSuccess();
    } catch (err) {
      // Submitted-but-unconfirmed is NOT a failure: the vote may have landed,
      // and a retry would be rejected by the one-vote-per-wallet check. Typed
      // rather than pattern-matched on the message, so an error from BEFORE
      // submission — a params fetch that timed out, a wallet reporting a
      // request already pending — still reports as the failure it is.
      if (isUnconfirmed(err)) {
        setStatus("idle");
        toast(err.message);
        onUnconfirmed();
        return;
      }
      const msg = err instanceof Error ? err.message : "Vote failed.";
      setErrorMsg(msg);
      setStatus("error");
      toast.error(msg);
    }
  }

  if (!mounted) return null;
  return createPortal(
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

          {!known ? (
            // Not "you need at least 1 mUSD" — that is a claim about their
            // wallet, and we failed to read their wallet.
            <p className="py-4 text-center text-sm text-gray-500">
              Couldn&apos;t read your {era.unit} balance. Close this and try again in a moment.
            </p>
          ) : maxWhole === 0 ? (
            <p className="py-4 text-center text-sm text-gray-500">You need at least 1 {era.unit} to vote.</p>
          ) : (
            <div className="space-y-4">
              <div className="rounded-xl border border-magnet-500/20 bg-magnet-950/30 p-4">
                <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-1">Your Choice</p>
                <p className="text-white font-semibold">
                  {choiceLetter(choiceIndex)}. {proposal.choices[choiceIndex]}
                </p>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold uppercase tracking-widest text-gray-500">
                    Voting power to lock
                  </label>
                  <button
                    onClick={() => setAmount(String(maxWhole))}
                    className="text-xs text-magnet-400 hover:text-magnet-300"
                  >
                    Max {maxWhole.toLocaleString()}
                  </button>
                </div>
                <div className="flex items-center rounded-lg border border-gray-700 bg-black/30 px-3 focus-within:border-magnet-500">
                  <input
                    type="number"
                    min={0}
                    max={maxWhole}
                    step={1}
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    // Snap the field to what will actually be locked. Typing
                    // 9999 against a 50 balance left the input saying 9999
                    // while the row below said 50.
                    onBlur={() => setAmount(String(voteCount))}
                    className="w-full bg-transparent py-2 text-sm text-white placeholder-gray-600 focus:outline-none"
                    placeholder="0"
                  />
                  <span className="text-sm font-medium text-gray-500">{era.unit}</span>
                </div>
              </div>

              <div className="rounded-xl border border-gray-800 bg-black/20 p-4 space-y-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-gray-500">Locked until vote ends</span>
                  <span className="text-yellow-400 font-medium">{voteCount.toLocaleString()} {era.unit}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-500">Box deposit (refunded)</span>
                  <span className="text-gray-400">{(VOTE_BOX_MBR / 1_000_000).toFixed(4)} ALGO</span>
                </div>
                {/* Named because "refunded" above could otherwise read as
                    "this costs nothing". Three txns now, one more on the
                    claim at triple fee; network fees are never refunded. */}
                <div className="flex items-center justify-between">
                  <span className="text-gray-500">Network fees (not refunded)</span>
                  <span className="text-gray-400">~0.006 ALGO</span>
                </div>
                <div className="flex items-start gap-2 pt-1 border-t border-gray-800 text-xs text-gray-500">
                  <Lock className="h-3 w-3 text-yellow-500 mt-0.5 flex-shrink-0" />
                  <span>Reclaim after <span className="text-yellow-400">{formatDate(proposal.endTime)}</span> — you get your {era.unit} and the deposit back.</span>
                </div>
              </div>

              <p className="text-xs text-gray-600 leading-relaxed">
                Only whole {era.unit} is locked. Fractional amounts stay in your wallet.
                A small ALGO box deposit is fully refunded when you reclaim.
              </p>
            </div>
          )}

          {status === "error" && <p className="mt-4 text-xs text-red-400">{errorMsg}</p>}

          <div className="mt-6 flex gap-3">
            <button
              onClick={handleVote}
              disabled={lockBaseUnits === 0 || busy}
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
    </div>,
    document.body,
  );
}
