"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Landmark, Vault, Coins, LayoutGrid, TrendingUp, Shield } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { PROTOCOL_LIVE, MAGNETFI_ADMIN_ADDRESS } from "@/lib/magnetfi";
import { OverviewTab } from "@/components/magnetfi/v2/OverviewTab";
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
// The mUSD swap now lives on the dedicated /musd page; the Bank tab deep-links there.

// Admin panel pulls in algokit-utils — lazy-load so it only ships when an admin opens it.
const AdminTab = dynamic(
  () => import("@/components/magnetfi/v2/AdminTab").then((m) => m.AdminTab),
  { ssr: false, loading: () => <div className="h-64 rounded-2xl border border-white/10 bg-black/40 animate-pulse" /> }
);

type Tab = "overview" | "markets" | "borrow" | "musd" | "admin";
type TabDef = { id: Tab; label: string; icon: React.ReactNode; badge?: string; href?: string };

const TABS: TabDef[] = [
  { id: "overview", label: "Overview", icon: <LayoutGrid className="h-4 w-4" /> },
  { id: "markets", label: "Single Token Markets", icon: <TrendingUp className="h-4 w-4" /> },
  { id: "borrow", label: "LP Collateral Vaults", icon: <Vault className="h-4 w-4" /> },
  { id: "musd", label: "mUSD", icon: <Coins className="h-4 w-4" />, href: "/musd" },
];

export default function MagnetFiPage() {
  const { address, isConnected } = useWallet();
  const isAdmin = isConnected && address === MAGNETFI_ADMIN_ADDRESS;
  const [activeTab, setActiveTab] = useState<Tab>("overview");

  // If the admin disconnects while on the Admin tab, fall back to Overview.
  useEffect(() => {
    if (!isAdmin && activeTab === "admin") setActiveTab("overview");
  }, [isAdmin, activeTab]);

  const tabs: TabDef[] = isAdmin
    ? [...TABS, { id: "admin", label: "Admin", icon: <Shield className="h-4 w-4" /> }]
    : TABS;

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

          <div className="flex flex-col gap-2">
            <span className="inline-flex w-fit items-center gap-2 rounded-full border border-magnet-500/30 bg-magnet-500/10 px-3 py-1.5 text-xs font-medium text-magnet-200">
              <span className="h-1.5 w-1.5 rounded-full bg-magnet-400 animate-pulse-slow" />
              {PROTOCOL_LIVE ? "LP Collateral Vaults live" : "LP Collateral Vaults — launching"}
            </span>
            <span className="inline-flex w-fit items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1.5 text-xs font-medium text-blue-200">
              <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
              Single Token Markets live
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
        {tabs.map((tab) => {
          const cls = `inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-medium transition-all ${
            activeTab === tab.id
              ? "border-magnet-500/60 bg-magnet-500/10 text-white"
              : "border-white/10 bg-black/30 text-gray-400 hover:border-white/20 hover:text-gray-200"
          }`;
          const inner = (
            <>
              {tab.icon}
              {tab.label}
              {tab.badge && (
                <span className="rounded-full bg-blue-500/20 border border-blue-500/30 px-1.5 py-0.5 text-[10px] font-semibold text-blue-300 leading-none">
                  {tab.badge}
                </span>
              )}
            </>
          );
          return tab.href ? (
            <Link key={tab.id} href={tab.href} className={cls}>{inner}</Link>
          ) : (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)} className={cls}>{inner}</button>
          );
        })}
      </div>

      {/* Content */}
      {activeTab === "overview" && (
        <OverviewTab
          onExploreMarkets={() => setActiveTab("markets")}
          onBorrow={() => setActiveTab("borrow")}
        />
      )}

      {activeTab === "markets" && (
        <div className="space-y-6">
          <CompXMarkets />
        </div>
      )}

      {activeTab === "borrow" && <VaultsTab />}
      {activeTab === "admin" && isAdmin && <AdminTab />}
    </div>
  );
}
