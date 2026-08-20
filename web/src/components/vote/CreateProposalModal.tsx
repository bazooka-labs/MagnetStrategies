"use client";

import { useState } from "react";
import { X, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useWallet } from "@/hooks/useWallet";
import { createProposal } from "@/lib/uvoteAdmin";
import { QUESTION_MAX, CHOICE_MAX, choiceLetter } from "@/lib/uvote";

export function CreateProposalModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const { activeAddress, signTransactions, algodClient } = useWallet();
  const [question, setQuestion] = useState("");
  const [choices, setChoices] = useState(["", ""]);
  const [status, setStatus] = useState<"idle" | "signing" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const setChoice = (i: number, v: string) => setChoices((c) => c.map((x, idx) => (idx === i ? v : x)));
  const addChoice = () => choices.length < 4 && setChoices((c) => [...c, ""]);
  const removeChoice = (i: number) => choices.length > 2 && setChoices((c) => c.filter((_, idx) => idx !== i));

  const ready =
    !!activeAddress &&
    question.trim().length > 0 && question.trim().length <= QUESTION_MAX &&
    choices[0].trim().length > 0 && choices[1].trim().length > 0 &&
    choices.every((c) => c.trim().length <= CHOICE_MAX);

  async function handleSubmit() {
    if (!ready || !activeAddress || !algodClient) return;
    setStatus("signing");
    setErrorMsg("");
    try {
      await createProposal(algodClient, signTransactions, activeAddress, question, choices);
      toast.success("Proposal created — voting is open for 7 days");
      onSuccess();
    } catch (err) {
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
                maxLength={QUESTION_MAX}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                className={inputClass}
              />
              <p className="mt-1 text-right text-xs text-gray-700">{question.length}/{QUESTION_MAX}</p>
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
                      maxLength={CHOICE_MAX}
                      value={choice}
                      onChange={(e) => setChoice(i, e.target.value)}
                      className={inputClass}
                    />
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

          <div className="mt-6 flex gap-3">
            <button
              onClick={handleSubmit}
              disabled={!ready || status === "signing"}
              className="flex-1 rounded-lg bg-gradient-to-r from-magnet-600 to-magnet-500 py-2.5 text-sm font-semibold text-white hover:from-magnet-500 hover:to-magnet-400 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {status === "signing" ? "Confirming…" : "Create Proposal"}
            </button>
            <button onClick={onClose} className="rounded-lg border border-gray-700 px-4 py-2.5 text-sm text-gray-400 hover:text-white transition-colors">
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
