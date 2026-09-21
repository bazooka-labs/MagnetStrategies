"use client";

import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, Lock, Globe } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { Panel } from "@/components/magnetfi/v2/shared";
import { VPL_ADMIN_ADDRESS, VPL_APP_ID } from "@/lib/vpl";
import { makeAlgorand, readGlobals } from "@/lib/vplOps";
import { DeployPanel } from "./admin/DeployPanel";
import { StatusPanel } from "./admin/StatusPanel";
import { ControlsPanel } from "./admin/ControlsPanel";

function NotAuthorized() {
  return (
    <Panel className="p-10">
      <div className="flex flex-col items-center text-center">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl border border-white/10 bg-black/40">
          <Lock className="h-6 w-6 text-gray-500" />
        </div>
        <p className="text-sm font-medium text-gray-300">Admin access required</p>
        <p className="mt-1 max-w-sm text-xs text-gray-500">
          Connect the VPL admin wallet. This panel is hidden from other wallets, and every
          action is additionally enforced on-chain by the contract&apos;s own admin checks.
        </p>
      </div>
    </Panel>
  );
}

export function AdminTab() {
  const { address, isConnected, algodClient, transactionSigner, network } = useWallet();
  const isAdmin = isConnected && address === VPL_ADMIN_ADDRESS;
  const [paused, setPausedState] = useState(false);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(async () => {
    if (!VPL_APP_ID || !algodClient || !address) return;
    try {
      const g = await readGlobals(makeAlgorand(algodClient, transactionSigner!), BigInt(VPL_APP_ID), address);
      setPausedState(g.paused);
    } catch { /* not deployed yet */ }
  }, [address, algodClient, transactionSigner]);

  useEffect(() => { void refresh(); }, [refresh, tick]);

  if (!isAdmin) return <NotAuthorized />;

  return (
    <div className="space-y-8">
      <Panel className="p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-magnet-600 to-magnet-800">
              <ShieldCheck className="h-6 w-6 text-white" />
            </div>
            <div>
              <p className="font-display text-base font-semibold text-white">VPL Admin</p>
              <p className="mt-0.5 text-sm text-gray-400">
                Built here, signed by your connected wallet — no key ever sits in a file.
              </p>
            </div>
          </div>
          <span className={`inline-flex items-center gap-2 rounded-xl border px-3 py-1.5 text-xs font-semibold capitalize ${
            network === "testnet"
              ? "border-blue-500/30 bg-blue-500/10 text-blue-200"
              : "border-red-500/30 bg-red-500/10 text-red-200"}`}>
            <Globe className="h-3.5 w-3.5" />{network}
          </span>
        </div>
      </Panel>

      {!VPL_APP_ID && (
        <section>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Deploy</h3>
          <DeployPanel />
        </section>
      )}

      <section>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Status</h3>
        <StatusPanel />
      </section>

      {!!VPL_APP_ID && (
        <section>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Controls</h3>
          <ControlsPanel paused={paused} onDone={() => setTick((t) => t + 1)} />
        </section>
      )}
    </div>
  );
}
