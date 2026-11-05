"use client";

import { useState } from "react";
import { X, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useWallet } from "@/hooks/useWallet";
import { createProposal } from "@/lib/governanceAdmin";
import { QUESTION_MAX, CHOICE_MAX, choiceLetter, isUnconfirmed } from "@/lib/governance";
import { byteLen } from "@/lib/governanceAdmin";

export function CreateProposalModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const { activeAddress, signTransactions, algodClient } = useWallet();
  const [question, setQuestion] = useState("");
  const [choices, setChoices] = useState(["", ""]);
  const [status, setStatus] = useState<"idle" | "signing" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const setChoice = (i: number, v: string) => setChoices((c) => c.map((x, idx) => (idx === i ? v : x)));
  const addChoice = () => choices.length < 4 && setChoices((c) => [...c, ""]);
  const removeChoice = (i: number) => choices.length > 2 && setChoices((c) => c.filter((_, idx) => idx !== i));

  /**
   * Byte lengths, because that is what the contract measures.
   *
   * `maxLength` on the inputs and `String.length` here both count UTF-16 code
   * units. The contract asserts `Len(arg) <= 256`, and Len counts BYTES — one
   * emoji is 2 units and 4 bytes, "é" is 1 and 2. So a question that looked
   * well inside the limit could be rejected on chain after the founder had
   * already signed and paid for the group.
   */
  const qBytes = byteLen(question.trim());
  const choiceBytes = choices.map((c) => byteLen(c.trim()));
  const ready =
    !!activeAddress &&
    question.trim().length > 0 && qBytes <= QUESTION_MAX &&
    choices[0].trim().length > 0 && choices[1].trim().length > 0 &&
    choiceBytes.every((n) => n <= CHOICE_MAX);

  /** Second click confirms; the first only shows what will be posted. */
  const [reviewing, setReviewing] = useState(false);

  async function handleSubmit() {
    if (!ready || !activeAddress || !algodClient) return;
    setStatus("signing");
    setErrorMsg("");
    try {
      await createProposal(algodClient, signTransactions, activeAddress, question, choices);
      toast.success("Proposal created — voting is open for 7 days");
      onSuccess();
    } catch (err) {
      // Submitted-but-unconfirmed is not a failure. Resubmitting is caught by
      // the one-window-at-a-time guard, but telling the founder it failed
      // invites the attempt and hides a proposal that may be open.
      if (isUnconfirmed(err)) {
        setStatus("idle");
        toast(err.message);
        onSuccess();
        return;
      }
      const msg = err instanceof Error ? err.message : "Submission failed.";
      setErrorMsg(msg);
      setStatus("error");
      toast.error(msg);
    }
  }

  const inputClass =
    "w-full rounded-lg border border-gray-700 bg-black/30 px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-magnet-500 focus:outline-none focus:ring-1 focus:ring-magnet-500";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl border border-magnet-500/20 bg-gray-950 shadow-2xl overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-magnet-500/50 to-transparent" />
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-lg font-bold text-white">Create Proposal</h2>
              <p className="mt-0.5 text-xs text-gray-500">Advisory · voting opens immediately for 7 days</p>
            </div>
            <button onClick={onClose} className="text-gray-600 hover:text-gray-300 transition-colors">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-widest text-gray-500 mb-1.5">Question</label>
              <textarea
                rows={3}
                placeholder="What direction should the protocol take? (liquidity, parameters, investments…)"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                className={inputClass}
              />
              {/* No `maxLength`: it counts the wrong unit, so it would cut off
                  plain text early or let multi-byte text through. The counter
                  below shows bytes, which is what will be checked. */}
              <p className={`mt-1 text-right text-xs ${qBytes > QUESTION_MAX ? "text-red-400" : "text-gray-700"}`}>
                {qBytes}/{QUESTION_MAX} bytes
              </p>
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">Choices</label>
              <div className="space-y-2">
                {choices.map((choice, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="w-5 flex-shrink-0 text-center text-xs font-bold text-gray-600">{choiceLetter(i)}</span>
                    <input
                      type="text"
                      placeholder={`Choice ${choiceLetter(i)}`}
                      value={choice}
                      onChange={(e) => setChoice(i, e.target.value)}
                      className={inputClass}
                      aria-invalid={choiceBytes[i] > CHOICE_MAX}
                    />
                    {choiceBytes[i] > CHOICE_MAX && (
                      <span className="shrink-0 text-xs text-red-400">{choiceBytes[i]}/{CHOICE_MAX}b</span>
                    )}
                    {i >= 2 && (
                      <button onClick={() => removeChoice(i)} className="flex-shrink-0 text-gray-700 hover:text-red-400 transition-colors">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {choices.length < 4 && (
                <button onClick={addChoice} className="mt-2 flex items-center gap-1.5 text-xs text-gray-600 hover:text-magnet-400 transition-colors">
                  <Plus className="h-3.5 w-3.5" /> Add choice
                </button>
              )}
            </div>
          </div>

          {status === "error" && <p className="mt-4 text-xs text-red-400">{errorMsg}</p>}

          {/*
            A review step, because posting is irreversible in a way that is easy
            to underestimate: the window cannot be cancelled, a typo in the
            question stands for seven days, and the one-at-a-time guard means
            it also blocks the next proposal for those seven days. One click was
            not a proportionate amount of friction for that.

            It shows the text EXACTLY as the contract will store it, trimmed,
            so a stray trailing space or a lost line break is visible before
            signing rather than after.
          */}
          {reviewing && (
            <div className="mt-5 rounded-xl border border-amber-400/30 bg-amber-500/[0.07] p-4">
              <p className="text-xs font-semibold uppercase tracking-widest text-amber-200">
                Posting this, exactly as written
              </p>
              <p className="mt-2 whitespace-pre-wrap text-sm text-white">{question.trim()}</p>
              <ul className="mt-2 space-y-1">
                {choices.map((c, i) => c.trim() && (
                  <li key={i} className="text-xs text-gray-300">
                    <span className="font-bold text-gray-500">{choiceLetter(i)}</span>  {c.trim()}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-amber-200/90 leading-relaxed">
                Voting opens immediately for 7 days. It cannot be cancelled or edited, and no
                other proposal can be opened until it closes.
              </p>
            </div>
          )}

          <div className="mt-6 flex gap-3">
            <button
              onClick={() => (reviewing ? void handleSubmit() : setReviewing(true))}
              disabled={!ready || status === "signing"}
              className="flex-1 rounded-lg bg-gradient-to-r from-magnet-600 to-magnet-500 py-2.5 text-sm font-semibold text-white hover:from-magnet-500 hover:to-magnet-400 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {status === "signing" ? "Confirming…" : reviewing ? "Post proposal" : "Review"}
            </button>
            <button
              onClick={() => (reviewing ? setReviewing(false) : onClose())}
              className="rounded-lg border border-gray-700 px-4 py-2.5 text-sm text-gray-400 hover:text-white transition-colors"
            >
              {reviewing ? "Back" : "Cancel"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
