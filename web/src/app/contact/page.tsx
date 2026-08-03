"use client";

import { useEffect, useState } from "react";
import { Mail, PenSquare, Inbox as InboxIcon, Shield } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { CONTACT_ADMIN_ADDRESS } from "@/lib/contact";
import { CreateTab } from "@/components/contact/CreateTab";
import { InboxTab } from "@/components/contact/InboxTab";
import { AdminTab } from "@/components/contact/AdminTab";

type Tab = "create" | "inbox" | "admin";

export default function ContactPage() {
  const { address, isConnected } = useWallet();
  const isAdmin = isConnected && address === CONTACT_ADMIN_ADDRESS;
  const [activeTab, setActiveTab] = useState<Tab>("create");

  useEffect(() => {
    if (!isAdmin && activeTab === "admin") setActiveTab("create");
  }, [isAdmin, activeTab]);

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "create", label: "Create", icon: <PenSquare className="h-4 w-4" /> },
    { id: "inbox", label: "Inbox", icon: <InboxIcon className="h-4 w-4" /> },
    ...(isAdmin ? [{ id: "admin" as Tab, label: "Admin", icon: <Shield className="h-4 w-4" /> }] : []),
  ];

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 lg:px-8">
      {/* Hero */}
      <div className="relative mb-8 overflow-hidden rounded-2xl border border-white/10 bg-black/40 px-6 py-8 backdrop-blur-sm sm:px-10 sm:py-10">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-magnet-500/60 to-transparent" />
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="animate-blob-drift absolute -right-16 -top-16 h-56 w-56 rounded-full bg-magnet-600/20 blur-3xl" />
        </div>
        <div className="relative flex items-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-magnet-600 to-magnet-800 shadow-lg shadow-magnet-900/50 shrink-0">
            <Mail className="h-7 w-7 text-white drop-shadow" />
          </div>
          <div>
            <h1 className="font-display magnet-glow-soft text-3xl font-bold text-white sm:text-4xl">Contact</h1>
            <p className="mt-1 max-w-xl text-sm text-gray-300">
              Message the Magnet Strategies admin directly on Algorand, and get replies back the same way.
            </p>
          </div>
        </div>
      </div>

      {/* How it works */}
      <div className="mb-8 rounded-2xl border border-white/10 bg-black/30 px-6 py-5">
        <h2 className="font-display mb-2 text-sm font-semibold text-white">How this works</h2>
        <p className="text-sm leading-relaxed text-gray-400">
          There&apos;s no server or database behind this — every message is a free Algorand transaction with
          your text attached, sent straight to the admin wallet. The admin&apos;s inbox reads those transactions
          directly off the public blockchain, and replies come back to you the same way: a transaction, sent to
          your wallet. That also means it&apos;s all public on-chain data, and replies are only ever accepted from
          the real admin wallet — anything else is discarded automatically.
        </p>
      </div>

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
          </button>
        ))}
      </div>

      {/* Content */}
      {activeTab === "create" && <CreateTab />}
      {activeTab === "inbox" && <InboxTab />}
      {activeTab === "admin" && isAdmin && <AdminTab />}
    </div>
  );
}
