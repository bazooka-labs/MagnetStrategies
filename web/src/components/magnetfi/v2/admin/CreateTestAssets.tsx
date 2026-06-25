"use client";

import { useState } from "react";
import algosdk from "algosdk";
import { toast } from "sonner";
import { Copy, Loader2, FlaskConical, CheckCircle2 } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { Panel } from "../shared";

type Preset = { key: string; name: string; unit: string; decimals: number; total: string; note: string };

const PRESETS: Preset[] = [
  { key: "musd", name: "Magnet USD", unit: "mUSD", decimals: 6, total: "500000000000000", note: "→ wizard 'mUSD ASA ID'" },
  { key: "usdc", name: "USD Coin (test)", unit: "USDC", decimals: 6, total: "1000000000000", note: "→ wizard 'USDC ASA ID'" },
  { key: "lp", name: "U/tALGO LP (test)", unit: "TMPOOL2", decimals: 6, total: "1000000000000", note: "→ wizard 'LP token ASA ID'" },
];

export function CreateTestAssets() {
  const { address, algodClient, transactionSigner } = useWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const [created, setCreated] = useState<Record<string, string>>({});

  async function create(p: Preset) {
    if (!address || !algodClient || !transactionSigner) return;
    setBusy(p.key);
    try {
      const sp = await algodClient.getTransactionParams().do();
      const txn = algosdk.makeAssetCreateTxnWithSuggestedParamsFromObject({
        sender: address,
        suggestedParams: sp,
        total: BigInt(p.total),
        decimals: p.decimals,
        defaultFrozen: false,
        unitName: p.unit,
        assetName: p.name,
        manager: address,
        reserve: address,
      });
      const signed = await transactionSigner([txn], [0]);
      await algodClient.sendRawTransaction(signed).do();
      const res = await algosdk.waitForConfirmation(algodClient, txn.txID(), 4);
      const id = res.assetIndex?.toString() ?? "";
      if (!id) throw new Error("No asset index returned");
      setCreated((c) => ({ ...c, [p.key]: id }));
      toast.success(`${p.unit} created — ASA ${id}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Transaction failed";
      toast.error(msg.includes("rejected") ? "Signing cancelled" : msg.slice(0, 120));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel className="p-6">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-500/15 border border-blue-500/20">
          <FlaskConical className="h-5 w-5 text-blue-300" />
        </div>
        <div>
          <p className="text-sm font-semibold text-white">Testnet stand-in assets</p>
          <p className="text-xs text-gray-500">Create the three test ASAs, then paste each ID into the wizard.</p>
        </div>
      </div>

      <div className="space-y-2">
        {PRESETS.map((p) => {
          const id = created[p.key];
          return (
            <div key={p.key} className="flex items-center gap-3 rounded-xl border border-white/5 bg-black/20 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-white">
                  {p.name} <span className="text-gray-500">· {p.unit} · {p.decimals} dp</span>
                </p>
                <p className="text-[11px] text-gray-600">{p.note}</p>
              </div>
              {id ? (
                <span className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-green-400" />
                  <code className="font-mono text-sm text-magnet-200">{id}</code>
                  <button
                    onClick={() => { navigator.clipboard.writeText(id); toast.success("Copied"); }}
                    className="text-gray-500 hover:text-white"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => create(p)}
                  disabled={!address || busy !== null}
                  className="shrink-0 rounded-lg bg-gradient-to-r from-magnet-600 to-magnet-500 px-3.5 py-1.5 text-xs font-semibold text-white disabled:opacity-30"
                >
                  {busy === p.key ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
