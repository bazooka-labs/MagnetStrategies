"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { Vault, Coins, ShieldCheck, ArrowRight } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import {
  VAULT_TYPES, PROTOCOL_LIVE, PSM_REDEEM_FEE_BPS, pct, formatUsd, type VaultType,
} from "@/lib/magnetfi";
import { getProtocolStats, type ProtocolStats } from "@/lib/magnetfiReads";
import { Panel, Stat, PairGlyph, SoonBadge, LaunchingBadge } from "./shared";

function VaultTypeCard({ v, onBorrow }: { v: VaultType; onBorrow: () => void }) {
  const launching = v.status === "launching";
  return (
    <Panel className={`p-6 ${launching ? "ring-1 ring-magnet-500/30" : ""}`}>
      <div className="mb-5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <PairGlyph tokens={v.tokens} />
          <div>
            <p className="font-display text-base font-semibold text-white">{v.pair}</p>
            <p className="text-xs text-gray-500">Tinyman LP collateral</p>
          </div>
        </div>
        {launching ? <LaunchingBadge /> : <SoonBadge />}
      </div>
      <p className="mb-5 text-sm leading-relaxed text-gray-400">{v.blurb}</p>
      <div className="grid grid-cols-3 gap-3 border-t border-white/5 pt-4">
        <div><p className="text-[11px] uppercase tracking-wider text-gray-500">Max LTV</p>
          <p className="mt-1 font-mono text-lg font-bold text-white">{pct(v.ltvBps)}%</p></div>
        <div><p className="text-[11px] uppercase tracking-wider text-gray-500">Liq. at</p>
          <p className="mt-1 font-mono text-lg font-bold text-white">{pct(v.liqThresholdBps)}%</p></div>
        <div><p className="text-[11px] uppercase tracking-wider text-gray-500">Rate</p>
          <p className="mt-1 font-mono text-lg font-bold text-magnet-300">{pct(v.rateBps)}%</p></div>
      </div>
      {launching && (
        <button onClick={onBorrow}
          className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-magnet-300 transition-colors hover:text-magnet-200">
          Open a vault <ArrowRight className="h-3.5 w-3.5" />
        </button>
      )}
    </Panel>
  );
}

function HowItWorks() {
  const steps = [
    { icon: <Vault className="h-5 w-5" />, title: "Deposit LP collateral",
      body: "Supply your Tinyman LP tokens. They keep earning trading fees while they back your loan." },
    { icon: <Coins className="h-5 w-5" />, title: "Borrow mUSD",
      body: "Draw mUSD up to the vault's LTV. Interest-only — repay principal whenever you like." },
    { icon: <ShieldCheck className="h-5 w-5" />, title: "Stay healthy",
      body: "A live LP price oracle tracks your health factor. Repay or add collateral to stay above the line." },
  ];
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {steps.map((s, i) => (
        <Panel key={i} className="p-6">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-magnet-600 to-magnet-800 text-white">{s.icon}</div>
          <p className="text-sm font-semibold text-white">{s.title}</p>
          <p className="mt-1.5 text-sm leading-relaxed text-gray-400">{s.body}</p>
        </Panel>
      ))}
    </div>
  );
}

export function OverviewTab({ onBorrow }: { onBorrow: () => void }) {
  const { algodClient } = useWallet();
  const [stats, setStats] = useState<ProtocolStats | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    if (!PROTOCOL_LIVE || !algodClient) return;
    getProtocolStats(algodClient).then(setStats).catch(() => setErr(true));
  }, [algodClient]);

  const val = (n?: number, dp = 0) => (PROTOCOL_LIVE ? (stats ? formatUsd(n ?? 0, dp) : err ? "—" : "…") : "Soon");
  const price = PROTOCOL_LIVE ? (stats ? `$${formatUsd(stats.oracle.price, 4)}` : err ? "—" : "…") : "Soon";

  return (
    <div className="space-y-10">
      <section>
        <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-gray-500">Protocol</h2>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="mUSD Circulating" value={val(stats?.circulating)} sub="Outstanding stablecoin" />
          <Stat label="Vault Ceiling" value={val(stats?.ceiling)} sub="mUSD borrowable" accent="purple" />
          <Stat label="LP Oracle Price" value={price}
            sub={stats ? (stats.oracle.fresh ? "fresh" : "stale") : "mUSD per LP"}
            accent={stats && !stats.oracle.fresh ? undefined : "green"} />
          <Stat label="mUSD Peg" value="$1.00" sub="USDC-backed 1:1" accent="green" />
        </div>
      </section>

      <section>
        <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-gray-500">How it works</h2>
        <HowItWorks />
      </section>

      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Vault types</h2>
          <p className="text-xs text-gray-500">Liquidation threshold 75% across all pools</p>
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          {VAULT_TYPES.map((v) => <VaultTypeCard key={v.id} v={v} onBorrow={onBorrow} />)}
        </div>
      </section>

      <section>
        <Panel className="p-6">
          <div className="flex items-center gap-4">
            <div className="h-11 w-11 shrink-0 overflow-hidden rounded-xl">
              <Image src="/musd-icon.png" alt="mUSD" width={44} height={44} className="h-full w-full object-cover" />
            </div>
            <div>
              <p className="font-display text-base font-semibold text-white">mUSD — the Magnet dollar</p>
              <p className="mt-0.5 text-sm text-gray-400">
                Fully USDC-backed. Mint at 1:1 with no fee; redeem any time for a {pct(PSM_REDEEM_FEE_BPS)}% fee.
              </p>
            </div>
          </div>
        </Panel>
      </section>
    </div>
  );
}
