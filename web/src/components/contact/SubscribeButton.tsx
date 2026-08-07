"use client";

import { useMemo, useState } from "react";
import { Bell, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useWallet } from "@/hooks/useWallet";
import { CONTACT_ADMIN_ADDRESS } from "@/lib/contact";
import { makeAlgorand, sendSubscription } from "@/lib/contactClient";

/** One-tap opt-in to the Magnet Strategies update channel. Requires a connected wallet
 *  (the subscription is an on-chain 0-ALGO note txn); shows an error if none is connected. */
export function SubscribeButton({ className = "" }: { className?: string }) {
  const { address, isConnected, algodClient, transactionSigner } = useWallet();
  const [busy, setBusy] = useState(false);

  const algorand = useMemo(
    () => (algodClient && transactionSigner ? makeAlgorand(algodClient, transactionSigner) : null),
    [algodClient, transactionSigner],
  );

  async function subscribe() {
    if (!isConnected || !address || !algorand) {
      toast.error("Connect your wallet first to subscribe.");
      return;
    }
    setBusy(true);
    try {
      await sendSubscription(algorand, address, CONTACT_ADMIN_ADDRESS, true);
      toast.success("Subscribed — updates will arrive in your Contact inbox.");
    } catch (e) {
      const m = e instanceof Error ? e.message : "Subscription failed";
      toast.error(m.includes("rejected") ? "Signing cancelled" : m.slice(0, 140));
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={subscribe}
      disabled={busy}
      className={`inline-flex items-center gap-2 rounded-lg border border-magnet-500/40 bg-magnet-500/10 px-4 py-2 text-sm font-semibold text-magnet-100 transition-colors hover:border-magnet-500/60 hover:bg-magnet-500/20 disabled:opacity-50 ${className}`}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bell className="h-4 w-4" />}
      Subscribe to updates
    </button>
  );
}
