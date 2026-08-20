"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { ArrowDownUp, ShieldCheck, Scale, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useWallet } from "@/hooks/useWallet";
import { PROTOCOL_LIVE, pct, formatUsd } from "@/lib/magnetfi";
import { makeAlgorand, optIn, mintMusd, redeemMusd } from "@/lib/magnetfiClient";
import { getBalances, getProtocolStats, MUSD_ID, USDC_ID, REDEEM_FEE_BPS, type Balances } from "@/lib/magnetfiReads";
import { Panel, PrimaryButton, NotLiveNote, tokenIcon, LivePill } from "./shared";

type Mode = "mint" | "redeem";

function AssetBadge({ asset }: { asset: string }) {
  const icon = tokenIcon(asset);
  return (
    <span className="flex items-center gap-1.5 rounded-lg bg-surface-lighter px-3 py-1.5 text-sm font-semibold text-white">
      {icon && (
        <span className="h-4 w-4 overflow-hidden rounded-full shrink-0">
          <Image src={icon} alt="" width={16} height={16} className="h-full w-full object-cover" />
        </span>
      )}
      {asset}
    </span>
  );
}

export function MusdTab() {
  const { address, isConnected, algodClient, transactionSigner } = useWallet();
  const [mode, setMode] = useState<Mode>("mint");
  const [amount, setAmount] = useState("");
  const [bal, setBal] = useState<Balances | null>(null);
  const [psmUsdc, setPsmUsdc] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const algorand = useMemo(
    () => (algodClient && transactionSigner ? makeAlgorand(algodClient, transactionSigner) : null),
    [algodClient, transactionSigner]);

  const refresh = useCallback(() => {
    if (!PROTOCOL_LIVE || !algodClient) return;
    if (address) getBalances(algodClient, address).then(setBal).catch(() => {});
    getProtocolStats(algodClient).then((s) => setPsmUsdc(s.psmUsdc)).catch(() => {});
  }, [algodClient, address]);
  useEffect(() => { refresh(); }, [refresh]);

  const amt = Math.max(0, Number(amount) || 0);
  const fee = mode === "mint" ? 0 : amt * (REDEEM_FEE_BPS / 10_000);
  const out = amt - fee;
  const fromAsset = mode === "mint" ? "USDC" : "mUSD";
  const toAsset = mode === "mint" ? "mUSD" : "USDC";

  async function run() {
    if (!algorand || !address) return;
    setBusy(true);
    try {
      // Fetch balances if not loaded yet so a required opt-in is never skipped (H-2).
      let b = bal;
      if (!b && algodClient) b = await getBalances(algodClient, address);
      if (mode === "mint") {
        if (b && !b.optedMusd) { await optIn(algorand, address, MUSD_ID); toast.success("Opted into mUSD"); }
        await mintMusd(algorand, address, amt);
        toast.success(`Minted ${formatUsd(out)} mUSD`);
      } else {
        if (b && !b.optedUsdc) { await optIn(algorand, address, USDC_ID); toast.success("Opted into USDC"); }
        await redeemMusd(algorand, address, amt);
        toast.success(`Redeemed for ${formatUsd(out)} USDC`);
      }
      refresh();
    } catch (e) {
      const m = e instanceof Error ? e.message : "Transaction failed";
      toast.error(m.includes("rejected") ? "Signing cancelled" : m.slice(0, 140));
    } finally { setBusy(false); }
  }

  const insufficient = !!bal && PROTOCOL_LIVE &&
    (mode === "mint" ? bal.usdc < amt : bal.musd < amt);
  // Redeem cannot exceed the PSM's USDC reserve (M-1).
  const lowReserve = mode === "redeem" && psmUsdc !== null && amt > psmUsdc;

  return (
    <div className="grid gap-8 lg:grid-cols-5">
      <div className="lg:col-span-3">
        <Panel className="p-6">
          <div className="mb-5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <p className="font-display text-base font-semibold text-white">Stablecoin Swap</p>
              {PROTOCOL_LIVE && <LivePill />}
            </div>
            <span className="rounded-full border border-white/10 bg-black/40 px-2.5 py-1 font-mono text-[11px] text-gray-400">
              {fromAsset} → {toAsset}
            </span>
          </div>

          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-xs font-medium uppercase tracking-wider text-gray-500">You pay</label>
            {bal && PROTOCOL_LIVE && (
              <span className="flex items-center gap-2 text-xs text-gray-500">
                Balance: {formatUsd(mode === "mint" ? bal.usdc : bal.musd)} {fromAsset}
                <button type="button" onClick={() => setAmount(String(mode === "mint" ? bal.usdc : bal.musd))}
                  className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-magnet-300 hover:text-magnet-200">
                  Max
                </button>
              </span>
            )}
          </div>
          <div className="flex items-center rounded-xl border border-white/10 bg-black/40 px-4 focus-within:border-magnet-500/50">
            <input type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)}
              className="w-full bg-transparent px-1 py-3.5 font-mono text-xl text-white outline-none" placeholder="0" />
            <AssetBadge asset={fromAsset} />
          </div>

          <div className="my-2 flex justify-center">
            <button type="button" onClick={() => setMode((m) => (m === "mint" ? "redeem" : "mint"))}
              aria-label="Switch swap direction"
              className="group flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-black/40 text-magnet-300 transition-all hover:border-magnet-500/50 hover:bg-magnet-500/10 hover:text-magnet-200">
              <ArrowDownUp className="h-4 w-4 transition-transform duration-300 group-hover:rotate-180" />
            </button>
          </div>

          <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-gray-500">You receive</label>
          <div className="flex items-center rounded-xl border border-white/10 bg-black/30 px-4">
            <input readOnly value={out ? formatUsd(out) : "0.00"}
              className="w-full bg-transparent px-1 py-3.5 font-mono text-xl text-white outline-none" />
            <AssetBadge asset={toAsset} />
          </div>

          <div className="mt-5 space-y-2 rounded-xl border border-white/5 bg-black/20 p-4 text-sm">
            <div className="flex justify-between"><span className="text-gray-400">Rate</span>
              <span className="font-mono text-white">1 {fromAsset} = 1 {toAsset}</span></div>
            <div className="flex justify-between"><span className="text-gray-400">Fee</span>
              <span className="font-mono text-white">
                {mode === "mint" ? "0%" : `${pct(REDEEM_FEE_BPS)}%`}{fee > 0 && <span className="text-gray-500"> · {formatUsd(fee)} USDC</span>}
              </span></div>
          </div>

          <div className="mt-5">
            <PrimaryButton onClick={run} disabled={!PROTOCOL_LIVE || !isConnected || busy || amt <= 0 || insufficient || lowReserve}>
              {busy ? <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Confirm in wallet…</span>
                : !isConnected ? "Connect wallet"
                : !PROTOCOL_LIVE ? "Launching on mainnet soon"
                : insufficient ? `Insufficient ${fromAsset}`
                : lowReserve ? "Exceeds PSM reserve"
                : mode === "mint" ? "Mint mUSD" : "Redeem mUSD"}
            </PrimaryButton>
            {!PROTOCOL_LIVE && <NotLiveNote />}
          </div>
        </Panel>
      </div>

      <div className="space-y-4 lg:col-span-2">
        <Panel className="p-6">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-magnet-600 to-magnet-800 text-white"><ShieldCheck className="h-5 w-5" /></div>
          <p className="text-sm font-semibold text-white">Backed 1:1 by USDC</p>
          <p className="mt-1.5 text-sm leading-relaxed text-gray-400">
            Every mUSD in circulation is covered by USDC in the Peg Stability Module. The protocol can
            never mint more mUSD than its USDC reserve backs.
          </p>
        </Panel>
        <Panel className="p-6">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-magnet-600 to-magnet-800 text-white"><Scale className="h-5 w-5" /></div>
          <p className="text-sm font-semibold text-white">Always redeemable</p>
          <p className="mt-1.5 text-sm leading-relaxed text-gray-400">
            Mint with USDC at no fee, or redeem mUSD back to USDC any time for a flat {pct(REDEEM_FEE_BPS)}%.
            The two-way peg keeps mUSD anchored at $1.00.
          </p>
        </Panel>
      </div>
    </div>
  );
}
