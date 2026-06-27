"use client";

import { useEffect, useState } from "react";
import { LendingClient, type MarketData } from "@compx/sdk";
import { TrendingUp, Wallet, CircleDollarSign, Coins } from "lucide-react";
import { Panel } from "./v2/shared";
import { LendingActionModal, type LendingAction } from "./LendingActionModal";

const COMPX_MAGNET_APP_ID = 3607827540;
const COMPX_USDC_APP_ID   = 3491050310;

const POOL_META: Record<number, { name: string; ticker: string; icon: React.ReactNode }> = {
  [COMPX_MAGNET_APP_ID]: {
    name: "Magnet",
    ticker: "$U",
    icon: <Coins className="h-5 w-5 text-white" />,
  },
  [COMPX_USDC_APP_ID]: {
    name: "USD Coin",
    ticker: "USDC",
    icon: <CircleDollarSign className="h-5 w-5 text-white" />,
  },
};

const ACTIONS: { id: LendingAction; label: string }[] = [
  { id: "supply",   label: "Supply"   },
  { id: "withdraw", label: "Withdraw" },
  { id: "borrow",   label: "Borrow"   },
  { id: "repay",    label: "Repay"    },
];

// SDK 2.0.2 reports 6 decimals for all assets; $U is actually 5.
const CORRECT_DECIMALS: Record<number, number> = {
  3081853135: 5, // $U
  3607827779: 5, // cU v3 (LST)
}
function correctDeposits(market: MarketData): number {
  const sdkDec = market.baseTokenDecimals
  const realDec = CORRECT_DECIMALS[market.baseTokenId] ?? sdkDec
  if (realDec === sdkDec) return market.totalDeposits
  // SDK over-divided by 10^(sdkDec-realDec); undo it
  return market.totalDeposits * Math.pow(10, sdkDec - realDec)
}
function correctBorrows(market: MarketData): number {
  const sdkDec = market.baseTokenDecimals
  const realDec = CORRECT_DECIMALS[market.baseTokenId] ?? sdkDec
  if (realDec === sdkDec) return market.totalBorrows
  return market.totalBorrows * Math.pow(10, sdkDec - realDec)
}
function correctAvailable(market: MarketData): number {
  const sdkDec = market.baseTokenDecimals
  const realDec = CORRECT_DECIMALS[market.baseTokenId] ?? sdkDec
  if (realDec === sdkDec) return market.availableToBorrow
  return market.availableToBorrow * Math.pow(10, sdkDec - realDec)
}

async function fetchUPriceUSD(): Promise<number> {
  try {
    const [v, a] = await Promise.all([
      fetch("https://api.vestigelabs.org/assets/price?asset_ids=3081853135&network_id=0").then(r => r.json()),
      fetch("https://api.coingecko.com/api/v3/simple/price?ids=algorand&vs_currencies=usd").then(r => r.json()),
    ])
    return Number(v[0].price) * Number(a.algorand.usd)
  } catch { return 0 }
}

function fmtUsd(n: number): string {
  if (!isFinite(n) || n === 0) return "$0.00";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

function PoolCard({
  appId,
  data,
  loading,
  usdPrice,
  onAction,
}: {
  appId: number;
  data: MarketData | null;
  loading: boolean;
  usdPrice: number;        // correct USD price per token (overrides SDK oracle)
  onAction: (action: LendingAction) => void;
}) {
  const meta = POOL_META[appId];
  const skeleton = (w: string) => (
    <span className={`inline-block h-4 ${w} animate-pulse rounded bg-white/10`} />
  );
  const utilPct   = data?.utilizationRate ?? 0;
  const utilColor = utilPct > 80 ? "bg-red-500" : utilPct > 60 ? "bg-yellow-500" : "bg-magnet-500";

  return (
    <Panel className="p-6 flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-magnet-600 to-magnet-800 shrink-0">
            {meta.icon}
          </div>
          <div>
            <p className="text-sm font-semibold text-white">{meta.name}</p>
            <p className="text-xs text-gray-500">{meta.ticker}</p>
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
            {loading || !data ? skeleton("w-16") : `${data.supplyApy.toFixed(2)}%`}
          </p>
        </div>
        <div className="rounded-xl border border-white/5 bg-white/5 px-4 py-3">
          <p className="text-[11px] uppercase tracking-wider text-gray-500">Borrow APY</p>
          <p className="mt-1 font-mono text-2xl font-bold text-magnet-300">
            {loading || !data ? skeleton("w-16") : `${data.borrowApy.toFixed(2)}%`}
          </p>
        </div>
      </div>

      {/* Stats row — USD (corrected decimals × market price) */}
      <div className="grid grid-cols-3 gap-2 border-t border-white/5 pt-4 text-center">
        <div>
          <p className="text-[11px] uppercase tracking-wider text-gray-500">TVL</p>
          <p className="mt-1 font-mono text-sm font-semibold text-white">
            {loading || !data ? skeleton("w-14") : fmtUsd(correctDeposits(data) * usdPrice)}
          </p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wider text-gray-500">Borrowed</p>
          <p className="mt-1 font-mono text-sm font-semibold text-white">
            {loading || !data ? skeleton("w-14") : fmtUsd(correctBorrows(data) * usdPrice)}
          </p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wider text-gray-500">Available</p>
          <p className="mt-1 font-mono text-sm font-semibold text-white">
            {loading || !data ? skeleton("w-14") : fmtUsd(correctAvailable(data) * usdPrice)}
          </p>
        </div>
      </div>

      {/* Utilization bar */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <p className="text-[11px] uppercase tracking-wider text-gray-500">Utilization</p>
          <p className="font-mono text-xs text-gray-400">
            {loading || !data ? "—" : `${data.utilizationRate.toFixed(2)}%`}
          </p>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          {!loading && data && (
            <div
              className={`h-full rounded-full transition-all duration-700 ${utilColor}`}
              style={{ width: `${Math.min(data.utilizationRate, 100)}%` }}
            />
          )}
        </div>
      </div>

      {/* Action buttons */}
      <div className="grid grid-cols-4 gap-2 border-t border-white/5 pt-1">
        {ACTIONS.map((a) => (
          <button
            key={a.id}
            onClick={() => onAction(a.id)}
            disabled={!data}
            className="rounded-lg border border-white/10 bg-white/5 py-2 text-xs font-medium text-gray-300 hover:border-magnet-500/50 hover:bg-magnet-500/10 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-all"
          >
            {a.label}
          </button>
        ))}
      </div>

      <p className="text-center text-xs text-gray-600 -mt-2">Hosted by CompX</p>
    </Panel>
  );
}

export function CompXMarkets() {
  const [markets, setMarkets]   = useState<Record<number, MarketData>>({});
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(false);
  const [uPriceUSD, setUPriceUSD] = useState(0);
  const [activeModal, setActiveModal] = useState<{ appId: number; action: LendingAction } | null>(null);

  useEffect(() => {
    const client = new LendingClient({ network: "mainnet" });
    Promise.all([
      client.getMarket(COMPX_MAGNET_APP_ID),
      client.getMarket(COMPX_USDC_APP_ID),
      fetchUPriceUSD(),
    ])
      .then(([magnet, usdc, uPrice]) => {
        setMarkets({ [magnet.appId]: magnet, [usdc.appId]: usdc })
        setUPriceUSD(uPrice)
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  const activeMarket = activeModal ? (markets[activeModal.appId] ?? null) : null;
  const pairedMarket = activeModal
    ? markets[activeModal.appId === COMPX_MAGNET_APP_ID ? COMPX_USDC_APP_ID : COMPX_MAGNET_APP_ID]
    : undefined;

  return (
    <>
      <section>
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/15 border border-blue-500/20">
            <TrendingUp className="h-4 w-4 text-blue-400" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-white">Single-Token Markets</h2>
            <p className="text-xs text-gray-500">
              Lend or borrow individual assets · live on Algorand mainnet
            </p>
          </div>
        </div>

        {error ? (
          <Panel className="p-6 text-center">
            <p className="text-sm text-gray-400">Failed to load market data. Try refreshing.</p>
          </Panel>
        ) : (
          <div className="grid gap-5 md:grid-cols-2">
            <PoolCard
              appId={COMPX_MAGNET_APP_ID}
              data={markets[COMPX_MAGNET_APP_ID] ?? null}
              loading={loading}
              usdPrice={uPriceUSD}
              onAction={(action) => setActiveModal({ appId: COMPX_MAGNET_APP_ID, action })}
            />
            <PoolCard
              appId={COMPX_USDC_APP_ID}
              data={markets[COMPX_USDC_APP_ID] ?? null}
              loading={loading}
              usdPrice={1}
              onAction={(action) => setActiveModal({ appId: COMPX_USDC_APP_ID, action })}
            />
          </div>
        )}

        <p className="mt-4 flex items-center gap-1.5 text-xs text-gray-500">
          <Wallet className="h-3.5 w-3.5 shrink-0" />
          Connect your wallet to supply, withdraw, borrow, or repay.
        </p>
      </section>

      {activeModal && activeMarket && (
        <LendingActionModal
          marketData={activeMarket}
          collateralMarket={pairedMarket}
          defaultAction={activeModal.action}
          onClose={() => setActiveModal(null)}
        />
      )}
    </>
  );
}
