import dynamic from "next/dynamic";
import Image from "next/image";
import { Panel } from "@/components/magnetfi/v2/shared";
import { VestigeChart } from "@/components/VestigeChart";
import { TvlRankStat } from "@/components/TvlRankStat";
import { AboutModal } from "@/components/tokens/AboutModal";
import { PoolsSection } from "@/components/tokens/PoolsSection";

const pulse = () => <div className="h-64 rounded-2xl border border-white/10 bg-black/40 animate-pulse" />;

const HaystackSwap = dynamic(
  () => import("@/components/HaystackSwap").then((m) => m.HaystackSwap),
  { ssr: false, loading: pulse }
);

function StatCell({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: "purple";
}) {
  return (
    <div className="p-5">
      <p className="text-xs font-medium uppercase tracking-wider text-gray-500">{label}</p>
      <p className={`mt-2 font-mono text-2xl font-bold ${accent === "purple" ? "text-magnet-300" : "text-white"}`}>
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-gray-500">{sub}</p>}
    </div>
  );
}

export function MagnetTokenView({
  holders,
  price,
  tvl,
}: {
  holders: string;
  price: string;
  tvl: string;
}) {
  return (
    <>
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
                Built to compound liquidity across Algorand DeFi.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <AboutModal />
            <span className="inline-flex w-fit items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1.5 text-xs font-medium text-blue-200">
              <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
              Live on Algorand mainnet
            </span>
          </div>
        </div>
      </div>

      {/* Stats + chart + swap, one unified panel */}
      <Panel className="mb-8">
        <div className="grid grid-cols-2 divide-x divide-y divide-white/10 lg:grid-cols-4 lg:divide-y-0">
          <StatCell label="Price" value={price} sub="USDC" />
          <StatCell label="Holders" value={holders} sub="Active wallets" />
          <StatCell label="Total TVL" value={tvl} sub="$U pools on Tinyman & Pact" accent="purple" />
          <TvlRankStat />
        </div>

        <div className="border-t border-white/10" />

        <div className="grid lg:grid-cols-5 lg:divide-x lg:divide-white/10">
          <div className="lg:col-span-3">
            <VestigeChart />
          </div>
          <div className="lg:col-span-2">
            <HaystackSwap />
          </div>
        </div>
      </Panel>

      {/* $U liquidity pools */}
      <PoolsSection />
    </>
  );
}
