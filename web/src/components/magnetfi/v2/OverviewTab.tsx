"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TrendingUp, Vault, Coins, ArrowRight } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { PROTOCOL_LIVE, formatUsd } from "@/lib/magnetfi";
import { getProtocolStats, getTotalVaultDebt, type ProtocolStats } from "@/lib/magnetfiReads";
import { Panel, Stat } from "./shared";
import { LpVaultLearnMore } from "./LpVaultLearnMore";

// CompX $U (Magnet) single-token market — source of the headline lend yield.
const COMPX_MAGNET_APP_ID = 3607827540;

export function OverviewTab({
  onExploreMarkets,
  onBorrow,
}: {
  onExploreMarkets: () => void;
  onBorrow: () => void;
}) {
  const { algodClient } = useWallet();
  const [stats, setStats] = useState<ProtocolStats | null>(null);
  const [borrowed, setBorrowed] = useState<number | null>(null);
  const [lendApy, setLendApy] = useState<number | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    if (!PROTOCOL_LIVE || !algodClient) return;
    getProtocolStats(algodClient).then(setStats).catch(() => setErr(true));
    getTotalVaultDebt(algodClient).then(setBorrowed).catch(() => {});
  }, [algodClient]);

  // Client-only CompX read for the $U supply APY (dynamic import keeps the SDK off SSR).
  useEffect(() => {
    let alive = true;
    import("@compx/sdk")
      .then(({ LendingClient }) => new LendingClient({ network: "mainnet" }).getMarket(COMPX_MAGNET_APP_ID))
      .then((m) => { if (alive) setLendApy(m.supplyApy); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const money = (n?: number) =>
    !PROTOCOL_LIVE ? "Soon" : stats ? `$${formatUsd(n ?? 0, 0)}` : err ? "—" : "…";
  const lendVal = lendApy !== null ? `${lendApy.toFixed(2)}%` : "…";
  // Utilization = true vault debt (loans against LP) ÷ USDC reserve. Uses actual borrowed
  // principal, NOT circulating mUSD (which also counts minted mUSD + fees) — so zero loans
  // correctly reads 0%.
  const util = stats && borrowed !== null && stats.psmUsdc > 0 ? (borrowed / stats.psmUsdc) * 100 : 0;
  const utilVal = !PROTOCOL_LIVE ? "Soon"
    : stats && borrowed !== null ? `${util.toFixed(1)}%`
    : err ? "—" : "…";

  return (
    <div className="space-y-10">
      {/* Metrics at a glance */}
      <section>
        <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-gray-500">Protocol at a glance</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <Stat label="Single-Token Lend Yield" value={lendVal} sub="$U supply APY · via CompX" accent="green" />
          <Stat label="Available to Borrow" value={money(stats?.ceiling)} sub="mUSD against LP collateral" accent="purple" />
          <Stat label="LP Vault Utilization" value={utilVal} sub="Borrowing capacity in use" />
        </div>
      </section>

      {/* What you can do */}
      <section className="grid gap-5 md:grid-cols-2">
        <Panel className="flex flex-col p-6">
          <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-blue-500/20 bg-blue-500/15 text-blue-400">
            <TrendingUp className="h-5 w-5" />
          </div>
          <h3 className="font-display text-base font-semibold text-white">Single Token Markets</h3>
          <p className="mt-2 flex-1 text-sm leading-relaxed text-gray-400">
            Lend and borrow individual assets — $U and USDC — through CompX&apos;s money markets on Algorand.
            Supply to earn yield, or borrow against your deposit. Rates float with utilization, and everything
            settles on-chain.
          </p>
          <button onClick={onExploreMarkets}
            className="mt-5 inline-flex w-fit items-center gap-1.5 text-sm font-semibold text-blue-300 transition-colors hover:text-blue-200">
            Explore Single Token Markets <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </Panel>

        <Panel className="flex flex-col p-6">
          <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-magnet-600 to-magnet-800 text-white">
            <Vault className="h-5 w-5" />
          </div>
          <h3 className="font-display text-base font-semibold text-white">LP Collateral Vaults</h3>
          <p className="mt-2 flex-1 text-sm leading-relaxed text-gray-400">
            Deposit your Tinyman LP tokens as collateral and borrow mUSD against them — while the LP keeps
            earning trading fees. Interest-only loans you can repay any time, with a live oracle tracking your
            health factor so you always know your buffer.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2">
            <button onClick={onBorrow}
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-magnet-300 transition-colors hover:text-magnet-200">
              Open an LP Collateral Vault <ArrowRight className="h-3.5 w-3.5" />
            </button>
            <LpVaultLearnMore />
          </div>
        </Panel>
      </section>

      {/* mUSD pointer */}
      <Panel className="p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-magnet-600 to-magnet-800 text-white">
              <Coins className="h-5 w-5" />
            </div>
            <p className="text-sm text-gray-300">
              <span className="font-semibold text-white">mUSD</span> — the fully USDC-backed Magnet dollar. Mint 1:1,
              redeem any time, and track the reserves.
            </p>
          </div>
          <Link href="/musd"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-black/30 px-3.5 py-2 text-xs font-semibold text-magnet-200 transition-colors hover:border-magnet-500/40 hover:text-white">
            Go to mUSD <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </Panel>
    </div>
  );
}
