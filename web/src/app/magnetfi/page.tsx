"use client";

import { useEffect, useState } from "react";
import { Landmark, Vault, Coins, LayoutGrid, TrendingUp, Shield } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { PROTOCOL_LIVE, MAGNETFI_ADMIN_ADDRESS } from "@/lib/magnetfi";
import { OverviewTab } from "@/components/magnetfi/v2/OverviewTab";
import { VaultsTab } from "@/components/magnetfi/v2/VaultsTab";
import { MusdTab } from "@/components/magnetfi/v2/MusdTab";
import { AdminTab } from "@/components/magnetfi/v2/AdminTab";
import dynamic from "next/dynamic";

const CompXMarkets = dynamic(
  () => import("@/components/magnetfi/CompXMarkets").then((m) => m.CompXMarkets),
  { ssr: false, loading: () => <div className="h-64 rounded-2xl border border-white/10 bg-black/40 animate-pulse" /> }
);

type Tab = "overview" | "markets" | "borrow" | "musd" | "admin";

const TABS: { id: Tab; label: string; icon: React.ReactNode; badge?: string }[] = [
  { id: "overview", label: "Overview", icon: <LayoutGrid className="h-4 w-4" /> },
  { id: "markets", label: "Markets", icon: <TrendingUp className="h-4 w-4" />, badge: "Live" },
  { id: "borrow", label: "LP Vaults", icon: <Vault className="h-4 w-4" /> },
  { id: "musd", label: "mUSD", icon: <Coins className="h-4 w-4" /> },
];

export default function MagnetFiPage() {
  const { address, isConnected } = useWallet();
  const isAdmin = isConnected && address === MAGNETFI_ADMIN_ADDRESS;
  const [activeTab, setActiveTab] = useState<Tab>("overview");

  // If the admin disconnects while on the Admin tab, fall back to Overview.
  useEffect(() => {
    if (!isAdmin && activeTab === "admin") setActiveTab("overview");
  }, [isAdmin, activeTab]);

  const tabs: { id: Tab; label: string; icon: React.ReactNode; badge?: string }[] = isAdmin
    ? [...TABS, { id: "admin", label: "Admin", icon: <Shield className="h-4 w-4" /> }]
    : TABS;

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      {/* Hero */}
      <div className="relative mb-8 overflow-hidden rounded-2xl border border-white/10 bg-black/40 px-6 py-8 backdrop-blur-sm sm:px-10 sm:py-10">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-magnet-500/60 to-transparent" />
        <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-magnet-600/20 blur-3xl" />

        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-magnet-600 to-magnet-800 shadow-lg shadow-magnet-900/50">
              <Landmark className="h-7 w-7 text-white drop-shadow" />
            </div>
            <div>
              <h1
                className="glow-text text-3xl font-bold text-white sm:text-4xl"
                style={{ fontFamily: "'Times New Roman', Times, serif" }}
              >
                MagnetFi
              </h1>
              <p className="mt-1 max-w-xl text-sm text-gray-300">
                Single-token lending via <span className="font-semibold text-white">CompX</span> markets,
                plus LP-collateral vaults that let your liquidity keep earning while you borrow{" "}
                <span className="font-semibold text-white">mUSD</span>.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span className="inline-flex w-fit items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1.5 text-xs font-medium text-blue-200">
              <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
              Single-token markets live
            </span>
            <span className="inline-flex w-fit items-center gap-2 rounded-full border border-magnet-500/30 bg-magnet-500/10 px-3 py-1.5 text-xs font-medium text-magnet-200">
              <span className="h-1.5 w-1.5 rounded-full bg-magnet-400 animate-pulse-slow" />
              {PROTOCOL_LIVE ? "LP vaults live" : "LP vaults — mainnet launch incoming"}
            </span>
          </div>
        </div>
      </div>

      {/* Pre-launch banner for v2 vaults only */}
      {!PROTOCOL_LIVE && (
        <div className="mb-8 rounded-xl border border-magnet-500/20 bg-magnet-500/5 px-5 py-3.5 text-sm text-magnet-200">
          MagnetFi LP vaults are in final pre-launch — explore the vault types and run the numbers below.
          Single-token lending and borrowing is live now via the Markets tab.
        </div>
      )}

      {/* Tabs */}
      <div className="mb-8 flex flex-wrap gap-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-medium transition-all ${
              activeTab === tab.id
                ? "border-magnet-500/60 bg-magnet-500/10 text-white"
                : "border-white/10 bg-black/30 text-gray-400 hover:border-white/20 hover:text-gray-200"
            }`}
          >
            {tab.icon}
            {tab.label}
            {tab.badge && (
              <span className="rounded-full bg-blue-500/20 border border-blue-500/30 px-1.5 py-0.5 text-[10px] font-semibold text-blue-300 leading-none">
                {tab.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      {activeTab === "overview" && (
        <div className="space-y-12">
          {/* Single-token markets section */}
          <CompXMarkets />

          {/* Divider with label */}
          <div className="relative flex items-center gap-4">
            <div className="flex-1 h-px bg-white/10" />
            <span className="shrink-0 rounded-full border border-magnet-500/30 bg-magnet-500/10 px-3 py-1 text-xs font-medium text-magnet-300">
              MagnetFi v2 — LP Collateral Vaults
            </span>
            <div className="flex-1 h-px bg-white/10" />
          </div>

          {/* LP vault overview */}
          <OverviewTab onBorrow={() => setActiveTab("borrow")} />
        </div>
      )}

      {activeTab === "markets" && (
        <div className="space-y-6">
          <CompXMarkets />
        </div>
      )}

      {activeTab === "borrow" && <VaultsTab />}
      {activeTab === "musd" && <MusdTab />}
      {activeTab === "admin" && isAdmin && <AdminTab />}
    </div>
  );
}
