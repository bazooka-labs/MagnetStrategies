"use client";

import { useState } from "react";
import Link from "next/link";
import { Landmark, Coins, Shield } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { PROTOCOL_LIVE, MAGNETFI_ADMIN_ADDRESS } from "@/lib/magnetfi";
import dynamic from "next/dynamic";

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
      {/* Hero */}
      <div className="relative mb-8 overflow-hidden rounded-2xl border border-white/10 bg-black/40 px-6 py-8 backdrop-blur-sm sm:px-10 sm:py-10">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-magnet-500/60 to-transparent" />
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="animate-blob-drift absolute -right-16 -top-16 h-56 w-56 rounded-full bg-magnet-600/20 blur-3xl" />
        </div>

        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-magnet-600 to-magnet-800 shadow-lg shadow-magnet-900/50">
              <Landmark className="h-7 w-7 text-white drop-shadow" />
            </div>
            <div>
              <h1 className="font-display magnet-glow-soft text-3xl font-bold text-white sm:text-4xl">
                MagnetFi
              </h1>
              <p className="mt-1 max-w-xl text-sm text-gray-300">
                Digital Asset Lending and Borrowing on Algorand
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
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
        </div>
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
