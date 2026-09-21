"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
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
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      <header className="mb-8">
        <h1 className="font-display text-3xl font-semibold text-white">Predict</h1>
        <p className="mt-2 max-w-2xl text-sm text-gray-400">
          Volatility Prediction Ladder — a daily market on how far Bitcoin moves during the US
          session. Stake mUSD on a band; whichever band the price finishes in takes the pot,
          split pro-rata by stake.
        </p>
      </header>

      <div className="mb-6 flex gap-1 border-b border-white/10">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
              tab === t.id
                ? "border-magnet-500 text-white"
                : "border-transparent text-gray-500 hover:text-gray-300"}`}>
            {t.icon}{t.label}
          </button>
        ))}
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
    </main>
  );
}
