import dynamic from "next/dynamic";
import Image from "next/image";
import { Panel, Stat } from "@/components/magnetfi/v2/shared";
import { VestigeChart } from "@/components/VestigeChart";
import { MAGNET_ASA_ID, fetchHolderCount, fetchMagnetPriceUSDC, fetchTVL } from "@/lib/tokenStats";

const pulse = () => <div className="h-64 rounded-2xl border border-white/10 bg-black/40 animate-pulse" />;

const HaystackSwap = dynamic(
  () => import("@/components/HaystackSwap").then((m) => m.HaystackSwap),
  { ssr: false, loading: pulse }
);

export default async function TokenPage() {
  const [holders, price, tvl] = await Promise.all([
    fetchHolderCount(),
    fetchMagnetPriceUSDC(),
    fetchTVL(),
  ]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      {/* Hero */}
      <div className="relative mb-8 overflow-hidden rounded-2xl border border-white/10 bg-black/40 px-6 py-8 backdrop-blur-sm sm:px-10 sm:py-10">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-magnet-500/60 to-transparent" />
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="animate-blob-drift absolute -right-16 -top-16 h-56 w-56 rounded-full bg-magnet-600/20 blur-3xl" />
        </div>

        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <div className="h-14 w-14 shrink-0 overflow-hidden rounded-2xl shadow-lg shadow-magnet-900/50">
              <Image src="/tokens/u.png" alt="$U" width={56} height={56} className="h-full w-full scale-[1.2] object-cover" priority />
            </div>
            <div>
              <h1 className="font-display magnet-glow-soft text-3xl font-bold text-white sm:text-4xl">
                Magnet Token
              </h1>
              <p className="mt-1 max-w-xl text-sm text-gray-300">
                <span className="font-semibold text-white">$U</span> sits at the center of every
                Magnet Strategies product — built to compound liquidity across Algorand DeFi.
              </p>
            </div>
          </div>

          <span className="inline-flex w-fit items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1.5 text-xs font-medium text-blue-200 shrink-0">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
            Live on Algorand mainnet
          </span>
        </div>
      </div>

      {/* What is $U */}
      <Panel className="p-6 sm:p-8 mb-8">
        <h2 className="font-display text-lg font-semibold text-white mb-3">What is $U?</h2>
        <div className="space-y-3 text-sm leading-relaxed text-gray-400">
          <p>
            $U is the native asset of Magnet Strategies, an Algorand-native DeFi organization
            built to attract and compound liquidity. Rather than tracking the broader market, $U
            is designed to compound yield across multiple Algorand DeFi strategies and reinvest
            returns to support the token&apos;s underlying value — with the goal of outperforming
            a simple ALGO holding over time.
          </p>
          <p>
            Launched in June 2025, $U has a fixed supply of 750,000 tokens on Algorand (ASA ID:{" "}
            <span className="font-mono text-gray-300">{MAGNET_ASA_ID}</span>). It&apos;s the
            primary asset across every Magnet Strategies product — collateralizing MagnetFi
            loans, anchoring Magnet Farms liquidity pairs, and accruing value from fees generated
            across each layer.
          </p>
        </div>
      </Panel>

      {/* Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <Stat label="Price" value={price} sub="USDC" />
        <Stat label="Holders" value={holders} sub="Active wallets" />
        <Stat label="Total TVL" value={tvl} sub="$U pools via Vestige" accent="purple" />
      </div>

      {/* Chart + Swap */}
      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <VestigeChart />
        </div>
        <div className="lg:col-span-2">
          <HaystackSwap />
        </div>
      </div>
    </div>
  );
}
