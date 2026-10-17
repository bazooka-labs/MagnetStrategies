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

/**
 * The categories a NEW ticket can be filed under.
 *
 * Deliberately not the same list as the stored values. "Farm" is gone from
 * here: that product was retired, and its successor — the $U liquidity pools —
 * lives inside the Magnet Token page, so a question about pools belongs under
 * Token rather than in a category of its own. Offering a route to a product
 * that no longer exists sends the ticket somewhere nobody is looking.
 *
 * `SupportApp` in lib/contact.ts still accepts "Farm" and APP_LABEL still
 * renders it, so tickets already filed under it stay readable. Dropping it from
 * the type instead would have orphaned them.
 */
export const APP_OPTIONS = ["General", "Token", "Bank"] as const;

/**
 * What a reader sees. Separate from the value above precisely so the product
 * can be renamed without touching stored data — which is why this map exists at
 * all rather than the select rendering its own values.
 *
 * Lives here, not in InboxTab, because the compose dropdown and the inbox badge
 * both label the same thing and had already drifted once (the inbox mapped
 * Token -> "Magnet Token" while the dropdown showed a bare "Token").
 */
export const APP_LABEL: Record<string, string> = {
  General: "General",
  Token: "Magnet Token",
  Bank: "Finance",
  // Retired. Kept so historical tickets still render with a name rather than a
  // blank badge; it is absent from APP_OPTIONS, so nothing new lands here.
  Farm: "Farm",
};
