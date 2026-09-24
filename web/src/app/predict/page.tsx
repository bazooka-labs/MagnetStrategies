"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import Image from "next/image";
import { LayoutGrid, Shield, TrendingUp } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { VPL_ADMIN_ADDRESS } from "@/lib/vpl";

const pulse = () => <div className="h-64 rounded-2xl border border-white/10 bg-black/40 animate-pulse" />;

// Pulls in algokit-utils — lazy-load so it only ships when an admin opens it.
const AdminTab = dynamic(
  () => import("@/components/predict/AdminTab").then((m) => m.AdminTab),
  { ssr: false, loading: pulse }
);

type Tab = "ladder" | "admin";

export default function PredictPage() {
  const { address, isConnected } = useWallet();
  const isAdmin = isConnected && address === VPL_ADMIN_ADDRESS;
  const [tab, setTab] = useState<Tab>("ladder");

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "ladder", label: "Ladder", icon: <TrendingUp className="h-4 w-4" /> },
    ...(isAdmin ? [{ id: "admin" as Tab, label: "Admin", icon: <Shield className="h-4 w-4" /> }] : []),
  ];

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      {/* Product toggle — same control as Tokens and Strategy */}
      <div className="mb-8 flex justify-center sm:justify-start">
        <div className="inline-flex rounded-full border border-white/10 bg-black/40 p-1 backdrop-blur-sm">
          {tabs.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                tab === t.id
                  ? "bg-gradient-to-r from-magnet-600 to-magnet-500 text-white shadow-lg shadow-magnet-900/40"
                  : "text-white/60 hover:text-white"}`}>
              <span className="flex h-5 w-5 shrink-0 items-center justify-center">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Hero */}
      <div className="relative mb-8 overflow-hidden rounded-2xl border border-white/10 bg-black/40 px-6 py-8 backdrop-blur-sm sm:px-10 sm:py-10">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-magnet-500/60 to-transparent" />
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="animate-blob-drift absolute -right-16 -top-16 h-56 w-56 rounded-full bg-magnet-600/20 blur-3xl" />
        </div>

        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <div className="h-14 w-14 shrink-0 overflow-hidden rounded-2xl shadow-lg shadow-magnet-900/50">
              <Image src="/musd-icon.png" alt="" width={56} height={56}
                className="h-full w-full object-cover" priority />
            </div>
            <div>
              <h1 className="font-display magnet-glow-soft text-3xl font-bold text-white sm:text-4xl">
                Predict
              </h1>
              <p className="mt-1 max-w-xl text-sm text-gray-300">
                Volatility Prediction Ladder — a daily market on how far Bitcoin moves during the
                US session. Stake mUSD on a band; whichever band the price finishes in takes the
                pot, split pro-rata by stake.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <span className="inline-flex w-fit items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1.5 text-xs font-medium text-blue-200">
              <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
              Rounds starting soon
            </span>
          </div>
        </div>
      </div>

      {tab === "admin" && isAdmin ? (
        <AdminTab />
      ) : (
        <div className="rounded-2xl border border-white/10 bg-black/40 p-10 text-center">
          <LayoutGrid className="mx-auto mb-3 h-8 w-8 text-gray-600" />
          <p className="text-sm font-medium text-gray-300">Coming soon</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-gray-500">
            The public ladder — live bands, current multiples and entry — lands once the first
            rounds have run cleanly.
          </p>
        </div>
      )}
    </div>
  );
}
