import { TrendingUp, Users, DollarSign } from "lucide-react";
import { Suspense } from "react";
import { fetchTVL } from "@/lib/tokenStats";

const MAGNET_ASA_ID = 3081853135;
const USDC_ASA_ID = 31566704;
const TREASURY_WALLET = "VM2JLZMKFLE635FXX54MU4TY6JUDIMLNRXOQDZUX3FKUFLS2BPEO2VL7QM";

async function fetchHolderCount(): Promise<string> {
  try {
    let count = 0;
    let nextToken: string | undefined;
    do {
      const params = new URLSearchParams({ "currency-greater-than": "0", limit: "1000" });
      if (nextToken) params.set("next", nextToken);
      const res = await fetch(
        `https://mainnet-idx.algonode.cloud/v2/assets/${MAGNET_ASA_ID}/balances?${params}`,
        { next: { revalidate: 3600 } }
      );
      if (!res.ok) break;
      const data = await res.json();
      count += (data.balances as unknown[])?.length ?? 0;
      nextToken = data["next-token"] as string | undefined;
    } while (nextToken);
    return count.toLocaleString("en-US");
  } catch {
    return "—";
  }
}

async function fetchTreasuryUSDC(): Promise<string> {
  if (!TREASURY_WALLET) return "$0.00";
  try {
    const res = await fetch(
      `https://mainnet-api.algonode.cloud/v2/accounts/${TREASURY_WALLET}`,
      { next: { revalidate: 3600 } }
    );
    if (!res.ok) return "$0.00";
    const data = await res.json();
    const holding = (data.assets as { "asset-id": number; amount: number }[] | undefined)
      ?.find((a) => a["asset-id"] === USDC_ASA_ID);
    const amount = Number(holding?.amount ?? 0) / 1_000_000;
    return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  } catch {
    return "$0.00";
  }
}

async function StatsContent() {
  const [tvl, holders, usdc] = await Promise.all([
    fetchTVL(),
    fetchHolderCount(),
    fetchTreasuryUSDC(),
  ]);

  const stats = [
    {
      label: "Total TVL",
      value: tvl,
      sublabel: "$U pools on Tinyman & Pact",
      icon: <TrendingUp className="h-4 w-4" />,
    },
    {
      label: "Token Holders",
      value: holders,
      sublabel: "Wallets holding $U",
      icon: <Users className="h-4 w-4" />,
    },
    {
      label: "Treasury USDC",
      value: usdc,
      sublabel: "Available for deployment",
      icon: <DollarSign className="h-4 w-4" />,
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {stats.map((stat) => (
        <div
          key={stat.label}
          className="relative rounded-xl border border-magnet-500/30 bg-gradient-to-br from-magnet-950/60 to-surface-light p-6 transition-all hover:border-magnet-500/50"
          style={{
            boxShadow:
              "0 0 24px rgba(168,85,247,0.10), inset 0 0 32px rgba(168,85,247,0.04)",
          }}
        >
          {/* Top edge glow line */}
          <div className="absolute inset-x-0 top-0 h-px rounded-t-xl bg-gradient-to-r from-transparent via-magnet-500/50 to-transparent" />

          <div className="flex items-center justify-between mb-4">
            <span className="text-xs font-semibold uppercase tracking-widest text-gray-500">
              {stat.label}
            </span>
            <span className="text-magnet-400/50">{stat.icon}</span>
          </div>

          <p
            className="text-3xl font-bold tracking-tight text-white"
            style={{ textShadow: "0 0 20px rgba(168,85,247,0.45)" }}
          >
            {stat.value}
          </p>

          <p className="mt-2 text-xs text-gray-600">{stat.sublabel}</p>
        </div>
      ))}
    </div>
  );
}

function StatsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="rounded-xl border border-magnet-500/20 bg-gradient-to-br from-magnet-950/40 to-surface-light p-6 animate-pulse"
        >
          <div className="mb-4 h-3 w-20 rounded bg-gray-800" />
          <div className="h-8 w-28 rounded bg-gray-800" />
          <div className="mt-2 h-2.5 w-32 rounded bg-gray-800/60" />
        </div>
      ))}
    </div>
  );
}

export function LiveStats() {
  return (
    <Suspense fallback={<StatsSkeleton />}>
      <StatsContent />
    </Suspense>
  );
}
