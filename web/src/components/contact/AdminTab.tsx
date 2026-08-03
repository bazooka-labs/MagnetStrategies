"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Lock, Loader2, Send, Users, AlertTriangle, Megaphone } from "lucide-react";
import { toast } from "sonner";
import { useWallet } from "@/hooks/useWallet";
import { Panel, PrimaryButton } from "@/components/magnetfi/v2/shared";
import { EmptyState } from "@/components/ui";
import {
  CONTACT_ADMIN_ADDRESS, MSG_MAX,
  fetchAccountContactMessages, fetchImpersonationAttempts,
  buildThreads, computeSubscribers,
  type ContactMessage, type Thread,
} from "@/lib/contact";
import { makeAlgorand, sendReply, sendBroadcast } from "@/lib/contactClient";
import { formatTimestamp } from "./shared";

function NotAuthorized() {
  return (
    <Panel className="p-10">
      <div className="flex flex-col items-center text-center">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl border border-white/10 bg-black/40">
          <Lock className="h-6 w-6 text-gray-500" />
        </div>
        <p className="text-sm font-semibold text-white">Admin access required</p>
        <p className="mt-1 max-w-sm text-xs text-gray-500">
          Connect the Magnet Strategies admin wallet to view tickets and manage the update channel.
        </p>
      </div>
    </Panel>
  );
}

function TicketRow({ thread, onReply }: { thread: Thread; onReply: (thread: Thread, msg: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);

  async function send() {
    const trimmed = reply.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await onReply(thread, trimmed);
      setReply("");
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel className="p-5">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-xs text-gray-500">{thread.root.sender.slice(0, 8)}…{thread.root.sender.slice(-6)}</span>
        <span className="text-xs text-gray-500">{formatTimestamp(thread.root.roundTime)}</span>
      </div>
      {thread.root.app && (
        <span className="mt-2 inline-block rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[11px] font-medium text-gray-400">
          {thread.root.app}
        </span>
      )}
      <p className="mt-2 text-sm leading-relaxed text-white">{thread.root.msg}</p>
      {thread.root.txnId && <p className="mt-2 font-mono text-[11px] text-gray-500">Ref: {thread.root.txnId}</p>}

      {thread.replies.length > 0 && (
        <div className="mt-4 space-y-2 border-t border-white/5 pt-4">
          {thread.replies.map((r) => (
            <div key={r.id} className="rounded-lg border border-magnet-500/20 bg-magnet-500/5 p-3 text-sm text-gray-200">
              {r.msg}
            </div>
          ))}
        </div>
      )}

      {open ? (
        <div className="mt-4 space-y-2 border-t border-white/5 pt-4">
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value.slice(0, MSG_MAX))}
            rows={3}
            placeholder="Write a reply…"
            className="w-full resize-none rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-white outline-none placeholder:text-gray-600 focus:border-magnet-500/50"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={send}
              disabled={busy || !reply.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-magnet-600 to-magnet-500 px-4 py-2 text-xs font-semibold text-white disabled:opacity-40"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              Send reply
            </button>
            <button onClick={() => setOpen(false)} className="text-xs text-gray-500 hover:text-gray-300">Cancel</button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="mt-4 text-xs font-semibold text-magnet-300 hover:text-magnet-200"
        >
          Reply
        </button>
      )}
    </Panel>
  );
}

export function AdminTab() {
  const { address, isConnected, algodClient, transactionSigner, network } = useWallet();
  const isAdmin = isConnected && address === CONTACT_ADMIN_ADDRESS;

  const [messages, setMessages] = useState<ContactMessage[] | null>(null);
  const [impersonations, setImpersonations] = useState<ContactMessage[] | null>(null);
  const [broadcastMsg, setBroadcastMsg] = useState("");
  const [broadcastBusy, setBroadcastBusy] = useState(false);
  const [broadcastProgress, setBroadcastProgress] = useState<{ sent: number; total: number } | null>(null);

  const algorand = useMemo(
    () => (isAdmin && algodClient && transactionSigner ? makeAlgorand(algodClient, transactionSigner) : null),
    [isAdmin, algodClient, transactionSigner]
  );

  const load = useCallback(() => {
    if (!isAdmin) return;
    fetchAccountContactMessages(CONTACT_ADMIN_ADDRESS, network).then(setMessages);
    fetchImpersonationAttempts(network).then(setImpersonations);
  }, [isAdmin, network]);

  useEffect(() => { load(); }, [load]);

  if (!isAdmin) return <NotAuthorized />;

  const threads = buildThreads((messages ?? []).filter((m) => m.type === "support" || m.type === "reply"));
  const subscribers = computeSubscribers(messages ?? []);

  async function handleReply(thread: Thread, msg: string) {
    if (!algorand || !address) return;
    try {
      await sendReply(algorand, address, thread.root.sender, msg, thread.root.id);
      toast.success("Reply sent");
      load();
    } catch (e) {
      const m = e instanceof Error ? e.message : "Failed to send reply";
      toast.error(m.includes("rejected") ? "Signing cancelled" : m.slice(0, 140));
    }
  }

  async function handleBroadcast() {
    if (!algorand || !address) return;
    const trimmed = broadcastMsg.trim();
    if (!trimmed || subscribers.size === 0) return;
    setBroadcastBusy(true);
    setBroadcastProgress({ sent: 0, total: subscribers.size });
    try {
      await sendBroadcast(algorand, address, Array.from(subscribers), trimmed, (sent, total) => setBroadcastProgress({ sent, total }));
      toast.success(`Sent to ${subscribers.size} subscriber${subscribers.size === 1 ? "" : "s"}`);
      setBroadcastMsg("");
    } catch (e) {
      const m = e instanceof Error ? e.message : "Broadcast failed";
      toast.error(m.includes("rejected") ? "Signing cancelled" : m.slice(0, 140));
    } finally {
      setBroadcastBusy(false);
      setBroadcastProgress(null);
    }
  }

  return (
    <div className="space-y-10">
      <section>
        <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-gray-500">Tickets</h2>
        {messages === null ? (
          <div className="h-40 rounded-2xl border border-white/10 bg-black/40 animate-pulse" />
        ) : threads.length === 0 ? (
          <EmptyState title="No tickets yet" description="Support messages sent to the admin wallet will show up here." />
        ) : (
          <div className="space-y-4">
            {threads.map((t) => <TicketRow key={t.id} thread={t} onReply={handleReply} />)}
          </div>
        )}
      </section>

      <section>
        <div className="mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
          <Users className="h-3.5 w-3.5" /> Subscribers — {subscribers.size}
        </div>
        <Panel className="p-6">
          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-xs font-medium uppercase tracking-wider text-gray-500">Broadcast an update</label>
            <span className="text-xs text-gray-500">{broadcastMsg.length}/{MSG_MAX}</span>
          </div>
          <textarea
            value={broadcastMsg}
            onChange={(e) => setBroadcastMsg(e.target.value.slice(0, MSG_MAX))}
            rows={3}
            placeholder="Write an announcement for subscribers…"
            className="w-full resize-none rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white outline-none placeholder:text-gray-600 focus:border-magnet-500/50"
          />
          <div className="mt-4">
            <PrimaryButton onClick={handleBroadcast} disabled={broadcastBusy || !broadcastMsg.trim() || subscribers.size === 0}>
              {broadcastBusy ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {broadcastProgress ? `Sending ${broadcastProgress.sent}/${broadcastProgress.total}…` : "Confirm in wallet…"}
                </span>
              ) : (
                <span className="inline-flex items-center gap-2"><Megaphone className="h-4 w-4" /> Send to {subscribers.size} subscriber{subscribers.size === 1 ? "" : "s"}</span>
              )}
            </PrimaryButton>
            <p className="mt-3 text-center text-xs text-gray-500">
              Sent in signed batches of up to 16 — large lists need more than one signature.
            </p>
          </div>
        </Panel>
      </section>

      <section>
        <div className="mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
          <AlertTriangle className="h-3.5 w-3.5" /> Impersonation attempts
        </div>
        {impersonations === null ? (
          <div className="h-16 rounded-2xl border border-white/10 bg-black/40 animate-pulse" />
        ) : impersonations.length === 0 ? (
          <Panel className="p-5">
            <p className="text-sm text-gray-400">No messages found claiming to be a reply or update from an address other than this one.</p>
          </Panel>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-gray-500">
              These are messages sent to other wallets pretending to be from Magnet Strategies. They&apos;re already
              blocked from showing in recipients&apos; inboxes — this is for awareness only.
            </p>
            {impersonations.map((m) => (
              <Panel key={m.id} className="border-red-500/20 p-4">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="font-mono text-red-300">{m.sender.slice(0, 8)}…{m.sender.slice(-6)}</span>
                  <span className="text-gray-500">{m.type === "reply" || m.type === "update" ? formatTimestamp(m.roundTime) : ""}</span>
                </div>
                {(m.type === "reply" || m.type === "update") && <p className="mt-2 text-sm text-gray-300">{m.msg}</p>}
              </Panel>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
