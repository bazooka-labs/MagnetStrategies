"use client";

import { useMemo, useState } from "react";
import { Loader2, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { useWallet } from "@/hooks/useWallet";
import { Panel, PrimaryButton } from "@/components/magnetfi/v2/shared";
import { CONTACT_ADMIN_ADDRESS, MSG_MAX, explorerTxUrl, type SupportApp } from "@/lib/contact";
import { makeAlgorand, sendTicket } from "@/lib/contactClient";
import { SecurityNotice, APP_OPTIONS } from "./shared";

export function CreateTab() {
  const { address, isConnected, algodClient, transactionSigner, network } = useWallet();
  const [msg, setMsg] = useState("");
  const [txnId, setTxnId] = useState("");
  const [app, setApp] = useState<SupportApp>("General");
  const [subscribe, setSubscribe] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sentId, setSentId] = useState<string | null>(null);

  const algorand = useMemo(
    () => (algodClient && transactionSigner ? makeAlgorand(algodClient, transactionSigner) : null),
    [algodClient, transactionSigner]
  );

  const trimmed = msg.trim();
  const overLimit = trimmed.length > MSG_MAX;
  const canSubmit = isConnected && !!algorand && !!address && trimmed.length > 0 && !overLimit && !busy;

  async function submit() {
    if (!algorand || !address || !canSubmit) return;
    setBusy(true);
    try {
      const id = await sendTicket(
        algorand, address, CONTACT_ADMIN_ADDRESS,
        { msg: trimmed, txnId: txnId.trim() || undefined, app },
        subscribe
      );
      setSentId(id);
      setMsg(""); setTxnId(""); setApp("General"); setSubscribe(false);
    } catch (e) {
      const m = e instanceof Error ? e.message : "Failed to send";
      toast.error(m.includes("rejected") ? "Signing cancelled" : m.slice(0, 140));
    } finally {
      setBusy(false);
    }
  }

  if (sentId) {
    return (
      <Panel className="p-8 text-center">
        <CheckCircle2 className="mx-auto mb-3 h-10 w-10 text-green-400" />
        <p className="font-display text-lg font-semibold text-white">Sent on-chain</p>
        <p className="mt-2 text-sm text-gray-400">
          Your message has been submitted. The admin will review it and reply — check the Inbox tab.
        </p>
        <a
          href={explorerTxUrl(sentId, network)}
          target="_blank" rel="noopener noreferrer"
          className="mt-4 inline-block font-mono text-xs text-magnet-300 hover:text-magnet-200"
        >
          {sentId.slice(0, 12)}…{sentId.slice(-6)}
        </a>
        <div className="mt-6">
          <button
            onClick={() => setSentId(null)}
            className="rounded-lg border border-white/10 bg-black/30 px-4 py-2 text-sm font-medium text-gray-300 hover:border-white/20 hover:text-white"
          >
            Send another message
          </button>
        </div>
      </Panel>
    );
  }

  return (
    <div className="space-y-5">
      <SecurityNotice />
      <Panel className="p-6">
        <div className="mb-1.5 flex items-center justify-between">
          <label className="text-xs font-medium uppercase tracking-wider text-gray-500">Your message</label>
          <span className={`text-xs ${overLimit ? "text-red-400" : "text-gray-500"}`}>
            {trimmed.length}/{MSG_MAX}
          </span>
        </div>
        <textarea
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          rows={5}
          placeholder="Describe what's going on — include as much detail as you can."
          className="w-full resize-none rounded-xl border border-white/10 bg-black/40 px-4 py-3.5 text-sm text-white outline-none placeholder:text-gray-600 focus:border-magnet-500/50"
        />

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-gray-500">
              Transaction ID <span className="normal-case text-gray-600">(optional)</span>
            </label>
            <input
              value={txnId}
              onChange={(e) => setTxnId(e.target.value)}
              placeholder="The txn you're referencing"
              className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 font-mono text-xs text-white outline-none placeholder:text-gray-600 focus:border-magnet-500/50"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-gray-500">
              Related to
            </label>
            <select
              value={app}
              onChange={(e) => setApp(e.target.value as SupportApp)}
              className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white outline-none focus:border-magnet-500/50"
            >
              {APP_OPTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
        </div>

        <label className="mt-4 flex items-center gap-2.5 text-sm text-gray-400">
          <input
            type="checkbox"
            checked={subscribe}
            onChange={(e) => setSubscribe(e.target.checked)}
            className="h-4 w-4 rounded border-white/20 bg-black/40 accent-magnet-500"
          />
          Also subscribe me to Magnet Strategies updates
        </label>

        <div className="mt-5">
          <PrimaryButton onClick={submit} disabled={!canSubmit}>
            {busy ? (
              <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Confirm in wallet…</span>
            ) : !isConnected ? "Connect wallet to send" : overLimit ? "Message too long" : "Send message"}
          </PrimaryButton>
          <p className="mt-3 text-center text-xs text-gray-500">
            Costs only the Algorand network fee (0.001 ALGO) — subscribing adds one more.
          </p>
        </div>
      </Panel>
    </div>
  );
}
