"use client";

import { useCallback, useEffect, useState } from "react";
import { Inbox, Megaphone, RefreshCw } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { Panel } from "@/components/magnetfi/v2/shared";
import { EmptyState } from "@/components/ui";
import {
  fetchAccountContactMessages, buildThreads,
  type ContactMessage, type Thread,
} from "@/lib/contact";
import { SecurityNotice, formatTimestamp } from "./shared";

const APP_LABEL: Record<string, string> = { Token: "Magnet Token", Bank: "Bank", Farm: "Farm", General: "General" };

function ThreadCard({ thread }: { thread: Thread }) {
  return (
    <Panel className="p-5">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[11px] font-medium text-gray-400">
          {APP_LABEL[thread.root.app ?? "General"]}
        </span>
        <span className="text-xs text-gray-500">{formatTimestamp(thread.root.roundTime)}</span>
      </div>
      <p className="text-sm leading-relaxed text-white">{thread.root.msg}</p>
      {thread.root.txnId && (
        <p className="mt-2 font-mono text-[11px] text-gray-500">Ref: {thread.root.txnId}</p>
      )}

      {thread.replies.length > 0 && (
        <div className="mt-4 space-y-3 border-t border-white/5 pt-4">
          {thread.replies.map((r) => (
            <div key={r.id} className="rounded-lg border border-magnet-500/20 bg-magnet-500/5 p-3.5">
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-magnet-300">
                  Magnet Strategies
                </span>
                <span className="text-[11px] text-gray-500">{formatTimestamp(r.roundTime)}</span>
              </div>
              <p className="text-sm leading-relaxed text-gray-200">{r.msg}</p>
            </div>
          ))}
        </div>
      )}
      {thread.replies.length === 0 && (
        <p className="mt-3 text-xs text-gray-500">Waiting on a reply.</p>
      )}
    </Panel>
  );
}

export function InboxTab() {
  const { address, isConnected, network } = useWallet();
  const [messages, setMessages] = useState<ContactMessage[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    if (!address) return;
    setLoading(true);
    fetchAccountContactMessages(address, network)
      .then(setMessages)
      .finally(() => setLoading(false));
  }, [address, network]);

  useEffect(() => { load(); }, [load]);

  if (!isConnected) {
    return (
      <EmptyState
        title="Connect your wallet"
        description="Your inbox is read straight from your wallet's on-chain activity — connect to view it."
      />
    );
  }

  const threads = buildThreads((messages ?? []).filter((m) => m.type === "support" || m.type === "reply"))
    .filter((t) => t.root.sender === address);
  const announcements = (messages ?? []).filter((m): m is Extract<ContactMessage, { type: "update" }> => m.type === "update")
    .sort((a, b) => b.round - a.round);

  return (
    <div className="space-y-6">
      <SecurityNotice />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-white">
          <Inbox className="h-4 w-4 text-magnet-400" /> Your messages
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-400 hover:text-white disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {messages === null ? (
        <div className="h-40 rounded-2xl border border-white/10 bg-black/40 animate-pulse" />
      ) : threads.length === 0 ? (
        <EmptyState title="No messages yet" description="Send a message from the Create tab to start a conversation." />
      ) : (
        <div className="space-y-4">
          {threads.map((t) => <ThreadCard key={t.id} thread={t} />)}
        </div>
      )}

      {announcements.length > 0 && (
        <div>
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-white">
            <Megaphone className="h-4 w-4 text-magnet-400" /> Announcements
          </div>
          <div className="space-y-3">
            {announcements.map((a) => (
              <Panel key={a.id} className="p-4">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-magnet-300">Magnet Strategies</span>
                  <span className="text-[11px] text-gray-500">{formatTimestamp(a.roundTime)}</span>
                </div>
                <p className="text-sm leading-relaxed text-gray-200">{a.msg}</p>
              </Panel>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

