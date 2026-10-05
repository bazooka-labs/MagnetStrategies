"use client";

import { useState } from "react";
import Link from "next/link";
import { Coins, Shield } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { PROTOCOL_LIVE, MAGNETFI_ADMIN_ADDRESS } from "@/lib/magnetfi";
import dynamic from "next/dynamic";
import { MagnetFiSplash } from "@/components/magnetfi/MagnetFiSplash";

const pulse = () => <div className="h-64 rounded-2xl border border-white/10 bg-black/40 animate-pulse" />;

const CompXMarkets = dynamic(
  () => import("@/components/magnetfi/CompXMarkets").then((m) => m.CompXMarkets),
  { ssr: false, loading: pulse }
);

// Borrower write-tabs pull in algokit-utils — lazy-load so the default view stays light.
const VaultsTab = dynamic(
  () => import("@/components/magnetfi/v2/VaultsTab").then((m) => m.VaultsTab),
  { ssr: false, loading: pulse }
);
// The mUSD swap lives on the combined /tokens page; the mUSD link below deep-links there.

// Admin panel pulls in algokit-utils — lazy-load so it only ships when an admin opens it.
const AdminTab = dynamic(
  () => import("@/components/magnetfi/v2/AdminTab").then((m) => m.AdminTab),
  { ssr: false, loading: () => <div className="h-64 rounded-2xl border border-white/10 bg-black/40 animate-pulse" /> }
);

export default function MagnetFiPage() {
  const { address, isConnected } = useWallet();
  const isAdmin = isConnected && address === MAGNETFI_ADMIN_ADDRESS;
  const [showAdmin, setShowAdmin] = useState(false);

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      {/* A sibling of the content, never a parent of it: the splash blurs the
          live page behind it, and an ancestor with a running opacity animation
          would become a backdrop root and leave it blurring nothing. */}
      <MagnetFiSplash />
      {/*
        No page header here on purpose.
        ──────────────────────────────────────────────────────────────────────
        This carried a bank icon, "MagnetFi", and the line "Digital Asset
        Lending and Borrowing on Algorand". The splash now says all three, a
        second earlier and at full attention — repeating them in a banner the
        user scrolls past is the kind of chrome that makes a product feel like a
        brochure. The subtext was MOVED, not duplicated.

        What was load-bearing in that block were the two controls, so they stay
        as a slim toolbar: right-aligned, out of the reading path, and the first
        thing at the top edge rather than a full-width card competing with the
        content under it.
      */}
      <div className="animate-enter mb-6 flex flex-wrap items-center justify-end gap-2">
        <Link
          href="/tokens?tab=musd"
          className="inline-flex w-fit items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-gray-300 transition-colors hover:border-magnet-500/50 hover:text-white"
        >
          <Coins className="h-3.5 w-3.5" /> mUSD
        </Link>
        {isAdmin && (
          <button
            onClick={() => setShowAdmin((v) => !v)}
            className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
              showAdmin
                ? "border-magnet-500/60 bg-magnet-500/10 text-white"
                : "border-white/10 bg-white/5 text-gray-300 hover:border-magnet-500/50 hover:text-white"
            }`}
          >
            <Shield className="h-3.5 w-3.5" /> Admin
          </button>
        )}
      </div>

      {/* Pre-launch banner for v2 vaults only */}
      {!PROTOCOL_LIVE && (
        <div className="mb-8 rounded-xl border border-magnet-500/20 bg-magnet-500/5 px-5 py-3.5 text-sm text-magnet-200">
          MagnetFi LP vaults are in final pre-launch — explore the vault types and run the numbers below.
          Single-token lending and borrowing is live now.
        </div>
      )}

      {isAdmin && showAdmin && <div className="mb-10"><AdminTab /></div>}

      <div className="space-y-12">
        <CompXMarkets />
        <VaultsTab />
      </div>
    </div>
  );
}
