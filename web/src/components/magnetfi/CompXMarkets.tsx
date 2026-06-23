"use client";

import { useEffect, useState } from "react";
import algosdk from "algosdk";
import { TrendingUp, Wallet, CircleDollarSign, Coins } from "lucide-react";
import { Panel } from "./v2/shared";

const COMPX_MAGNET_APP_ID = 3607827540;
const COMPX_USDC_APP_ID = 3491050310;

const POOL_META: Record<number, { name: string; ticker: string; icon: React.ReactNode; decimals: number }> = {
  [COMPX_MAGNET_APP_ID]: { name: "Magnet", ticker: "$U", icon: <Coins className="h-5 w-5 text-white" />, decimals: 5 },
  [COMPX_USDC_APP_ID]: { name: "USD Coin", ticker: "USDC", icon: <CircleDollarSign className="h-5 w-5 text-white" />, decimals: 6 },
};

interface PoolData {
  appId: number;
  totalDeposits: number;
  totalBorrows: number;
  availableToBorrow: number;
  utilizationRate: number;
  supplyApy: number;
  borrowApy: number;
}

function readState(globalState: algosdk.modelsv2.TealKeyValue[]): Record<string, bigint | Uint8Array> {
  const state: Record<string, bigint | Uint8Array> = {};
  for (const item of globalState) {
    const key = Buffer.from(item.key as Uint8Array).toString("utf8");
    if (Number(item.value.type) === 1) {
      state[key] = item.value.bytes as Uint8Array;
    } else {
      state[key] = item.value.uint as bigint;
    }
  }
  return state;
}

function uint(state: Record<string, bigint | Uint8Array>, key: string): bigint {
  const v = state[key];
  return typeof v === "bigint" ? v : BigInt(0);
}

function toStandard(raw: bigint, decimals: number): number {
  return Number(raw) / Math.pow(10, decimals);
}

async function fetchPool(algod: algosdk.Algodv2, appId: number): Promise<PoolData> {
  const app = await algod.getApplicationByID(appId).do();
  const raw = readState(app.params.globalState ?? []);
  const meta = POOL_META[appId];
  const dec = meta.decimals;

  const totalDepositsRaw = uint(raw, "total_deposits");
  const totalBorrowsRaw = uint(raw, "total_borrows");
  const cashRaw = uint(raw, "cash_on_hand");

  const totalDeposits = toStandard(totalDepositsRaw, dec);
  const totalBorrows = toStandard(totalBorrowsRaw, dec);
  const availableToBorrow = toStandard(cashRaw, dec);

  const utilizationRate =
    totalDepositsRaw > BigInt(0) ? (Number(totalBorrowsRaw) / Number(totalDepositsRaw)) * 100 : 0;

  // last_apr_bps is the contract's most-recently computed borrow APR
  const borrowAprBps = Number(uint(raw, "last_apr_bps"));
  const borrowApy = borrowAprBps / 100;

  // Supply APY = borrow APY × utilization × (1 − protocol share)
  const protocolShareBps = Number(uint(raw, "protocol_share_bps") || BigInt(1000));
  const supplyApy = borrowApy * (utilizationRate / 100) * (1 - protocolShareBps / 10_000);

  return { appId, totalDeposits, totalBorrows, availableToBorrow, utilizationRate, supplyApy, borrowApy };
}

function fmt(n: number, dp = 2): string {
  return isFinite(n) ? n.toFixed(dp) : "—";
}

function fmtAmount(n: number, ticker: string): string {
  if (!isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M ${ticker}`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K ${ticker}`;
  return `${n.toFixed(2)} ${ticker}`;
}

function PoolCard({ appId, data, loading }: { appId: number; data: PoolData | null; loading: boolean }) {
  const meta = POOL_META[appId];
  const skeleton = (w: string) => (
    <span className={`inline-block h-5 ${w} animate-pulse rounded bg-white/10`} />
  );
  const utilPct = data?.utilizationRate ?? 0;
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
            {loading || !data ? skeleton("w-16") : `${fmt(data.supplyApy)}%`}
          </p>
        </div>
        <div className="rounded-xl border border-white/5 bg-white/5 px-4 py-3">
          <p className="text-[11px] uppercase tracking-wider text-gray-500">Borrow APY</p>
          <p className="mt-1 font-mono text-2xl font-bold text-magnet-300">
            {loading || !data ? skeleton("w-16") : `${fmt(data.borrowApy)}%`}
          </p>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-2 border-t border-white/5 pt-4 text-center">
        <div>
          <p className="text-[11px] uppercase tracking-wider text-gray-500">Total Supply</p>
          <p className="mt-1 font-mono text-sm font-semibold text-white">
            {loading || !data ? skeleton("w-16") : fmtAmount(data.totalDeposits, meta.ticker)}
          </p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wider text-gray-500">Total Borrow</p>
          <p className="mt-1 font-mono text-sm font-semibold text-white">
            {loading || !data ? skeleton("w-16") : fmtAmount(data.totalBorrows, meta.ticker)}
          </p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wider text-gray-500">Available</p>
          <p className="mt-1 font-mono text-sm font-semibold text-white">
            {loading || !data ? skeleton("w-16") : fmtAmount(data.availableToBorrow, meta.ticker)}
          </p>
        </div>
      </div>

      {/* Utilization bar */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <p className="text-[11px] uppercase tracking-wider text-gray-500">Utilization</p>
          <p className="font-mono text-xs text-gray-400">
            {loading || !data ? "—" : `${fmt(data.utilizationRate)}%`}
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

      {/* Hosted by attribution */}
      <p className="text-center text-xs text-gray-600 mt-auto">Hosted by CompX</p>
    </Panel>
  );
}

export function CompXMarkets() {
  const [pools, setPools] = useState<Record<number, PoolData>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const algod = new algosdk.Algodv2("", "https://mainnet-api.algonode.cloud", "");
    Promise.all([
      fetchPool(algod, COMPX_MAGNET_APP_ID),
      fetchPool(algod, COMPX_USDC_APP_ID),
    ])
      .then(([magnet, usdc]) => setPools({ [magnet.appId]: magnet, [usdc.appId]: usdc }))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  return (
    <section>
      <div className="mb-5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/15 border border-blue-500/20">
            <TrendingUp className="h-4 w-4 text-blue-400" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-white">Single-Token Markets</h2>
            <p className="text-xs text-gray-500">Lend or borrow individual assets · data live from Algorand mainnet</p>
          </div>
        </div>
      </div>

      {error ? (
        <Panel className="p-6 text-center">
          <p className="text-sm text-gray-400">Failed to load market data. Try refreshing.</p>
        </Panel>
      ) : (
        <div className="grid gap-5 md:grid-cols-2">
          <PoolCard appId={COMPX_MAGNET_APP_ID} data={pools[COMPX_MAGNET_APP_ID] ?? null} loading={loading} />
          <PoolCard appId={COMPX_USDC_APP_ID} data={pools[COMPX_USDC_APP_ID] ?? null} loading={loading} />
        </div>
      )}

      <p className="mt-4 flex items-center gap-1.5 text-xs text-gray-500">
        <Wallet className="h-3.5 w-3.5 shrink-0" />
        Connect your wallet on CompX to supply or borrow.
      </p>
    </section>
  );
}
