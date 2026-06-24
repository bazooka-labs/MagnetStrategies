"use client";

import { useState } from "react";
import algosdk from "algosdk";
import { toast } from "sonner";
import { Coins, Copy, ExternalLink, Loader2, CheckCircle2, AlertTriangle } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { MUSD, MUSD_ASA_ID } from "@/lib/magnetfi";
import { Panel, PrimaryButton } from "../shared";

// 500,000,000 mUSD at 6 decimals → base units. BigInt() (not a literal) keeps the
// build target happy.
const MUSD_TOTAL_BASE = BigInt(500_000_000_000_000);

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2 text-sm">
      <span className="text-gray-400">{label}</span>
      <span className={`text-white ${mono ? "font-mono" : "font-medium"}`}>{value}</span>
    </div>
  );
}

export function CreateMusd() {
  const { address, isConnected, transactionSigner, algodClient } = useWallet();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const alreadyCreated = MUSD_ASA_ID !== 0;

  async function handleCreate() {
    if (!address || !algodClient) return;
    setBusy(true);
    try {
      const sp = await algodClient.getTransactionParams().do();
      const txn = algosdk.makeAssetCreateTxnWithSuggestedParamsFromObject({
        sender: address,
        suggestedParams: sp,
        total: MUSD_TOTAL_BASE,
        decimals: MUSD.decimals,
        defaultFrozen: false,
        unitName: MUSD.ticker,
        assetName: MUSD.name,
        manager: address, // keep for metadata + Pera/Vestige verification
        reserve: address, // cosmetic; can point at the PSM later
        // freeze & clawback intentionally omitted → permanently renounced (trustless)
      });

      const signed = await transactionSigner([txn], [0]);
      await algodClient.sendRawTransaction(signed).do();
      const result = await algosdk.waitForConfirmation(algodClient, txn.txID(), 4);

      const assetId = result.assetIndex?.toString() ?? "";
      if (!assetId) throw new Error("No asset index returned");
      setCreatedId(assetId);
      toast.success(`mUSD created — ASA ${assetId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Transaction failed";
      toast.error(msg.includes("rejected") ? "Signing was cancelled" : `Create failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  }

  // Already created via config
  if (alreadyCreated) {
    return (
      <Panel className="p-6">
        <div className="flex items-center gap-3">
          <CheckCircle2 className="h-5 w-5 text-green-400" />
          <div>
            <p className="text-sm font-semibold text-white">mUSD already created</p>
            <p className="font-mono text-xs text-gray-400">ASA {MUSD_ASA_ID}</p>
          </div>
        </div>
      </Panel>
    );
  }

  // Success state for this session
  if (createdId) {
    return (
      <Panel className="p-6 glow-blue">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-400" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-white">mUSD created</p>
            <p className="mt-1 text-sm text-gray-400">
              Asset ID — wire this into <span className="font-mono">MUSD_ASA_ID</span> and submit it for
              Pera/Vestige verification from the manager wallet.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <code className="rounded-lg border border-white/10 bg-black/40 px-3 py-1.5 font-mono text-lg text-magnet-200">
                {createdId}
              </code>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(createdId);
                  toast.success("Copied");
                }}
                className="rounded-lg border border-white/10 bg-white/5 p-2 text-gray-300 hover:text-white"
                title="Copy ASA ID"
              >
                <Copy className="h-4 w-4" />
              </button>
              <a
                href={`https://allo.info/asset/${createdId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg border border-white/10 bg-white/5 p-2 text-gray-300 hover:text-white"
                title="View on allo.info"
              >
                <ExternalLink className="h-4 w-4" />
              </a>
            </div>
          </div>
        </div>
      </Panel>
    );
  }

  return (
    <Panel className="p-6">
      <div className="mb-5 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-magnet-600 to-magnet-800">
          <Coins className="h-5 w-5 text-white" />
        </div>
        <div>
          <p className="text-sm font-semibold text-white">Create the mUSD token</p>
          <p className="text-xs text-gray-500">Algorand mainnet · signed by the connected wallet</p>
        </div>
      </div>

      {/* Params confirmation */}
      <div className="divide-y divide-white/5 rounded-xl border border-white/5 bg-black/20 px-4">
        <Row label="Name / Unit" value={`${MUSD.name} · ${MUSD.ticker}`} />
        <Row label="Decimals" value={String(MUSD.decimals)} mono />
        <Row label="Total supply" value="500,000,000 mUSD" mono />
        <Row label="Default frozen" value="No" />
        <Row label="Freeze / Clawback" value="Renounced (blank)" />
        <Row label="Manager / Reserve" value="Creator wallet" />
      </div>

      {/* Creator wallet */}
      <div className="mt-4 rounded-xl border border-white/5 bg-black/20 p-4">
        <p className="text-xs uppercase tracking-wider text-gray-500">Creator wallet</p>
        <p className="mt-1 break-all font-mono text-xs text-magnet-200">
          {isConnected ? address : "— connect the admin wallet —"}
        </p>
      </div>

      <div className="mt-4 flex items-start gap-2 rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-3 py-2.5">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-yellow-400" />
        <p className="text-xs leading-relaxed text-yellow-200/90">
          This creates a real, permanent mainnet asset. The creator is fixed forever to the wallet
          above, and freeze/clawback cannot be added later. Verify the address before signing.
        </p>
      </div>

      <label className="mt-4 flex cursor-pointer items-center gap-2.5 text-sm text-gray-300">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="h-4 w-4 rounded border-white/20 bg-black/40 accent-magnet-500"
        />
        I confirm the creator wallet above is correct.
      </label>

      <div className="mt-4">
        <PrimaryButton onClick={handleCreate} disabled={!isConnected || !confirmed || busy}>
          {busy ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Confirm in your wallet…
            </span>
          ) : !isConnected ? (
            "Connect the admin wallet"
          ) : (
            "Create mUSD"
          )}
        </PrimaryButton>
      </div>
    </Panel>
  );
}
