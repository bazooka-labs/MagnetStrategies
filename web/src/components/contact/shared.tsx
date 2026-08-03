"use client";

import { ShieldAlert } from "lucide-react";

/** Persistent disclosure + anti-phishing line shown on Create and Inbox. */
export function SecurityNotice() {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-magnet-500/20 bg-magnet-500/5 p-4 text-xs leading-relaxed text-magnet-200">
      <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5 text-magnet-400" />
      <p>
        Messages are sent as public Algorand transactions — anyone can read them on-chain, so don&apos;t
        include private keys, passwords, or anything you wouldn&apos;t post publicly.{" "}
        <span className="font-semibold text-white">
          Magnet Strategies will never ask you to send ALGO or share a seed phrase to &quot;verify&quot; anything.
        </span>
      </p>
    </div>
  );
}

export function formatTimestamp(roundTime: number): string {
  if (!roundTime) return "";
  return new Date(roundTime * 1000).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export const APP_OPTIONS = ["General", "Token", "Bank", "Farm"] as const;
