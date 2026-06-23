"use client";

import { useEffect, useState } from "react";
import algosdk from "algosdk";
import { CompXSDK } from "@compx/sdk";
import type { MarketData } from "@compx/sdk";
import { ExternalLink, TrendingUp, Wallet, CircleDollarSign, Coins } from "lucide-react";
import { Panel } from "./v2/shared";

const COMPX_MAGNET_APP_ID = 3607827540;
const COMPX_USDC_APP_ID = 3491050310;

const algod = new algosdk.Algodv2("", "https://mainnet-api.algonode.cloud", "");
const sdk = new CompXSDK({ algodClient: algod, network: "mainnet" });

const POOL_META: Record<number, { name: string; ticker: string; icon: React.ReactNode; compxUrl: string }> = {
  [COMPX_MAGNET_APP_ID]: {
    name: "Magnet",
    ticker: "$U",
    icon: <Coins className="h-5 w-5 text-white" />,
    compxUrl: `https://compx.io/lending/${COMPX_MAGNET_APP_ID}`,
  },
  [COMPX_USDC_APP_ID]: {
    name: "USD Coin",
    ticker: "USDC",
    icon: <CircleDollarSign className="h-5 w-5 text-white" />,
    compxUrl: `https://compx.io/lending/${COMPX_USDC_APP_ID}`,
  },
};

function fmt(n: number, dp = 2) {
  if (!isFinite(n)) return "—";
  return n.toFixed(dp);
}

function fmtUsd(n: number) {
  if (!isFinite(n) || n === 0) return "$0";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function PoolCard({ market, loading }: { market: MarketData | null; loading: boolean }) {
  const meta = market ? POOL_META[market.appId] : null;

  const skeleton = (w: string) => (
    <span className={`inline-block h-5 ${w} animate-pulse rounded bg-white/10`} />
  );

  const utilPct = market ? market.utilizationRate : 0;
  const utilColor =
    utilPct > 80 ? "bg-red-500" : utilPct > 60 ? "bg-yellow-500" : "bg-magnet-500";

  return (
    <Panel className="p-6 flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-magnet-600 to-magnet-800 shrink-0">
            {meta?.icon ?? <Coins className="h-5 w-5 text-white" />}
          </div>
          <div>
            {loading || !market ? (
              <>{skeleton("w-16")} <br /> {skeleton("w-10")}</>
            ) : (
              <>
                <p className="text-sm font-semibold text-white">{meta?.name}</p>
                <p className="text-xs text-gray-500">{meta?.ticker}</p>
              </>
            )}
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-500/30 bg-blue-500/10 px-2.5 py-0.5 text-xs font-medium text-blue-300">
          <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
          Live
        </span>
      </div>

      {/* APY row */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-white/5 bg-white/5 px-4 py-3">
          <p className="text-[11px] uppercase tracking-wider text-gray-500">Supply APY</p>
          <p className="mt-1 font-mono text-2xl font-bold text-green-400">
            {loading || !market ? skeleton("w-16") : `${fmt(market.supplyApy)}%`}
          </p>
        </div>
        <div className="rounded-xl border border-white/5 bg-white/5 px-4 py-3">
          <p className="text-[11px] uppercase tracking-wider text-gray-500">Borrow APY</p>
          <p className="mt-1 font-mono text-2xl font-bold text-magnet-300">
            {loading || !market ? skeleton("w-16") : `${fmt(market.borrowApy)}%`}
          </p>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-2 border-t border-white/5 pt-4 text-center">
        <div>
          <p className="text-[11px] uppercase tracking-wider text-gray-500">Total Supply</p>
          <p className="mt-1 font-mono text-sm font-semibold text-white">
            {loading || !market ? skeleton("w-12") : fmtUsd(market.totalDepositsUSD)}
          </p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wider text-gray-500">Total Borrow</p>
          <p className="mt-1 font-mono text-sm font-semibold text-white">
            {loading || !market ? skeleton("w-12") : fmtUsd(market.totalBorrowsUSD)}
          </p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wider text-gray-500">Available</p>
          <p className="mt-1 font-mono text-sm font-semibold text-white">
            {loading || !market ? skeleton("w-12") : fmtUsd(market.availableToBorrowUSD)}
          </p>
        </div>
      </div>

      {/* Utilization bar */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <p className="text-[11px] uppercase tracking-wider text-gray-500">Utilization</p>
          <p className="font-mono text-xs text-gray-400">
            {loading || !market ? "—" : `${fmt(market.utilizationRate)}%`}
          </p>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          {!loading && market && (
            <div
              className={`h-full rounded-full transition-all duration-700 ${utilColor}`}
              style={{ width: `${Math.min(market.utilizationRate, 100)}%` }}
            />
          )}
        </div>
      </div>

      {/* CTA */}
      {meta && (
        <a
          href={meta.compxUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-auto inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-medium text-gray-300 transition-all hover:border-magnet-500/40 hover:bg-magnet-500/10 hover:text-white"
        >
          Open on CompX <ExternalLink className="h-3.5 w-3.5" />
        </a>
      )}
    </Panel>
  );
}

export function CompXMarkets() {
  const [markets, setMarkets] = useState<MarketData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    sdk.lending
      .getMarkets([COMPX_MAGNET_APP_ID, COMPX_USDC_APP_ID])
      .then(setMarkets)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  const getMarket = (appId: number) =>
    markets.find((m) => m.appId === appId) ?? null;

  return (
    <section>
      {/* Section header */}
      <div className="mb-5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/15 border border-blue-500/20">
            <TrendingUp className="h-4 w-4 text-blue-400" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-white">Single-Token Markets</h2>
            <p className="text-xs text-gray-500">Powered by CompX · lend or borrow individual assets</p>
          </div>
        </div>
        <a
          href="https://compx.io/lending"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          View all on CompX <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      {error ? (
        <Panel className="p-6 text-center">
          <p className="text-sm text-gray-400">Failed to load market data. Try refreshing.</p>
        </Panel>
      ) : (
        <div className="grid gap-5 md:grid-cols-2">
          <PoolCard market={getMarket(COMPX_MAGNET_APP_ID)} loading={loading} />
          <PoolCard market={getMarket(COMPX_USDC_APP_ID)} loading={loading} />
        </div>
      )}

      {/* Wallet note */}
      <p className="mt-4 flex items-center gap-1.5 text-xs text-gray-500">
        <Wallet className="h-3.5 w-3.5 shrink-0" />
        Connect your wallet on CompX to supply or borrow. Market data shown live from Algorand mainnet.
      </p>
    </section>
  );
}
