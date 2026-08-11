"use client";

import { useEffect, useState } from "react";
import { TrendingUp, Vault, ArrowRight } from "lucide-react";
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
  const [borrowApy, setBorrowApy] = useState<number | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    if (!PROTOCOL_LIVE || !algodClient) return;
    getProtocolStats(algodClient).then(setStats).catch(() => setErr(true));
    getTotalVaultDebt(algodClient).then(setBorrowed).catch(() => {});
  }, [algodClient]);

  // Client-only CompX read for the $U borrow APY (dynamic import keeps the SDK off SSR).
  useEffect(() => {
    let alive = true;
    import("@compx/sdk")
      .then(({ LendingClient }) => new LendingClient({ network: "mainnet" }).getMarket(COMPX_MAGNET_APP_ID))
      .then((m) => { if (alive) setBorrowApy(m.borrowApy); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const money = (n?: number) =>
    !PROTOCOL_LIVE ? "Soon" : stats ? `$${formatUsd(n ?? 0, 0)}` : err ? "—" : "…";
  const borrowVal = borrowApy !== null ? `${borrowApy.toFixed(2)}%` : "…";
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
          <Stat label="$U Borrow Rate" value={borrowVal} sub="Current $U borrow APY · via CompX" accent="green" />
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
    </div>
  );
}
