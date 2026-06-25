"use client";

import { ShieldCheck, Lock, SlidersHorizontal, Globe } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { MAGNETFI_ADMIN_ADDRESS } from "@/lib/magnetfi";
import { Panel } from "./shared";
import { CreateMusd } from "./admin/CreateMusd";
import { CreateTestAssets } from "./admin/CreateTestAssets";
import { DeployWizard } from "./admin/DeployWizard";

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

export function AdminTab() {
  const { address, isConnected, network } = useWallet();
  const isAdmin = isConnected && address === MAGNETFI_ADMIN_ADDRESS;
  const isTestnet = network === "testnet";

  if (!isAdmin) return <NotAuthorized />;

  return (
    <div className="space-y-8">
      {/* Header */}
      <Panel className="p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-magnet-600 to-magnet-800">
              <ShieldCheck className="h-6 w-6 text-white" />
            </div>
            <div>
              <p className="text-base font-semibold text-white">Admin</p>
              <p className="mt-0.5 text-sm text-gray-400">
                Every action is built here and signed by your connected wallet.
              </p>
            </div>
          </div>

          {/* Network indicator (fixed at startup via NEXT_PUBLIC_ALGO_NETWORK) */}
          <span
            className={`inline-flex items-center gap-2 rounded-xl border px-3 py-1.5 text-xs font-semibold capitalize ${
              isTestnet
                ? "border-blue-500/30 bg-blue-500/10 text-blue-200"
                : "border-red-500/30 bg-red-500/10 text-red-200"
            }`}
          >
            <Globe className="h-3.5 w-3.5" />
            {network}
          </span>
        </div>
      </Panel>

      {/* Asset setup — testnet stand-ins vs mainnet mUSD */}
      <section>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
          {isTestnet ? "Testnet rehearsal — stand-in assets" : "Token setup"}
        </h3>
        {isTestnet ? <CreateTestAssets /> : <CreateMusd />}
      </section>

      {/* Deploy & initialize */}
      <section>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
          Deploy &amp; initialize
        </h3>
        <DeployWizard />
      </section>

      {/* Operations (next) */}
      <section>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
          Operations
        </h3>
        <Panel className="p-6 opacity-70">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-white/5 text-gray-400">
            <SlidersHorizontal className="h-5 w-5" />
          </div>
          <p className="text-sm font-semibold text-white">Operations</p>
          <p className="mt-1.5 text-sm leading-relaxed text-gray-500">
            Rates, liquidations, pause / unpause, oracle re-anchoring, and fee collection — coming
            once the contracts are live.
          </p>
        </Panel>
      </section>
    </div>
  );
}
