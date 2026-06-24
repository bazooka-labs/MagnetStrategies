"use client";

import { ShieldCheck, Lock, Rocket, SlidersHorizontal } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { MAGNETFI_ADMIN_ADDRESS } from "@/lib/magnetfi";
import { Panel } from "./shared";
import { CreateMusd } from "./admin/CreateMusd";

function NotAuthorized() {
  return (
    <Panel className="p-10">
      <div className="flex flex-col items-center text-center">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl border border-white/10 bg-black/40">
          <Lock className="h-6 w-6 text-gray-500" />
        </div>
        <p className="text-sm font-medium text-gray-300">Admin access required</p>
        <p className="mt-1 max-w-sm text-xs text-gray-500">
          Connect the MagnetFi admin wallet to manage the protocol. This panel is hidden from all
          other wallets.
        </p>
      </div>
    </Panel>
  );
}

function FutureTool({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <Panel className="p-6 opacity-70">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/5 text-gray-400">
          {icon}
        </div>
        <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-xs text-gray-500">
          Next
        </span>
      </div>
      <p className="text-sm font-semibold text-white">{title}</p>
      <p className="mt-1.5 text-sm leading-relaxed text-gray-500">{body}</p>
    </Panel>
  );
}

export function AdminTab() {
  const { address, isConnected } = useWallet();
  const isAdmin = isConnected && address === MAGNETFI_ADMIN_ADDRESS;

  if (!isAdmin) return <NotAuthorized />;

  return (
    <div className="space-y-8">
      {/* Header */}
      <Panel className="p-6">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-magnet-600 to-magnet-800">
            <ShieldCheck className="h-6 w-6 text-white" />
          </div>
          <div>
            <p className="text-base font-semibold text-white">Admin</p>
            <p className="mt-0.5 text-sm text-gray-400">
              Bazooka operations — every action is built here and signed by your connected wallet.
            </p>
          </div>
        </div>
      </Panel>

      {/* Token setup */}
      <section>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
          Token setup
        </h3>
        <CreateMusd />
      </section>

      {/* Coming next */}
      <section>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
          Deploy &amp; operate
        </h3>
        <div className="grid gap-5 md:grid-cols-2">
          <FutureTool
            icon={<Rocket className="h-5 w-5" />}
            title="Deploy & initialize"
            body="Deploy the LP Oracle, PSM, and Vault with the guardian, wire them together, set risk params, and open the vault ceiling — all as signed steps."
          />
          <FutureTool
            icon={<SlidersHorizontal className="h-5 w-5" />}
            title="Operations"
            body="Rates, liquidations, pause / unpause, oracle re-anchoring, and fee collection once the contracts are live."
          />
        </div>
      </section>
    </div>
  );
}
