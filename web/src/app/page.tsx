import Image from "next/image";
import Link from "next/link";
import { Magnet, Landmark } from "lucide-react";
import dynamic from "next/dynamic";
import { VestigeChart } from "@/components/VestigeChart";

const HaystackSwap = dynamic(
  () => import("@/components/HaystackSwap").then((m) => m.HaystackSwap),
  { ssr: false, loading: () => <div className="rounded-xl border border-white/10 bg-black/50 h-64 animate-pulse" /> }
);

const LandingHeader = dynamic(
  () => import("@/components/LandingHeader").then((m) => m.LandingHeader),
  { ssr: false }
);

const MAGNET_ASA_ID = 3081853135;

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

async function fetchMagnetPriceUSDC(): Promise<string> {
  try {
    const [vestigeRes, algoRes] = await Promise.all([
      fetch(
        `https://api.vestigelabs.org/assets/price?asset_ids=${MAGNET_ASA_ID}&network_id=0`,
        { next: { revalidate: 300 } }
      ),
      fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=algorand&vs_currencies=usd",
        { next: { revalidate: 300 } }
      ),
    ]);
    if (!vestigeRes.ok || !algoRes.ok) return "—";
    const vestigeData = await vestigeRes.json();
    const algoData = await algoRes.json();
    const entry = Array.isArray(vestigeData) ? vestigeData[0] : null;
    if (!entry?.price) return "—";
    const algoUSD = algoData?.algorand?.usd;
    if (!algoUSD) return "—";
    const priceUSDC = Number(entry.price) * Number(algoUSD);
    return `$${priceUSDC.toFixed(6)}`;
  } catch {
    return "—";
  }
}

async function fetchTVL(): Promise<string> {
  try {
    const res = await fetch(
      `https://api.vestigelabs.org/assets/price?asset_ids=${MAGNET_ASA_ID}&network_id=0`,
      { next: { revalidate: 3600 } }
    );
    if (!res.ok) return "—";
    const data = await res.json();
    const entry = Array.isArray(data) ? data[0] : null;
    if (!entry?.total_lockup) return "—";
    const tvl = Math.round(
      Number(entry.total_lockup) * Number(entry.price) * 2 * Number(entry.confidence)
    );
    return `${tvl.toLocaleString("en-US")} ALGO`;
  } catch {
    return "—";
  }
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="relative rounded-xl border border-white/10 bg-black/50 backdrop-blur-sm p-5 text-center shadow-lg shadow-black/40">
      <div className="absolute inset-x-0 top-0 h-px rounded-t-xl bg-gradient-to-r from-transparent via-magnet-500/60 to-transparent" />
      <p className="text-xs font-semibold uppercase tracking-widest text-gray-400 mb-2">{label}</p>
      <p className="text-2xl font-bold text-white" style={{ textShadow: "0 0 20px rgba(168,85,247,0.5)" }}>
        {value}
      </p>
      {sub && <p className="mt-1 text-xs text-gray-500">{sub}</p>}
    </div>
  );
}

export default async function LandingPage() {
  const [holders, price, tvl] = await Promise.all([
    fetchHolderCount(),
    fetchMagnetPriceUSDC(),
    fetchTVL(),
  ]);

  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center overflow-hidden">
      <LandingHeader />

      {/* Full-bleed background */}
      <div className="absolute inset-0">
        <Image
          src="/magnet-bg.png"
          fill
          alt=""
          className="object-cover object-center"
          priority
        />
      </div>

      {/* Content */}
      <div className="relative z-10 mx-auto max-w-4xl px-6 pt-28 pb-20 flex flex-col items-center text-center">

        {/* Logo */}
        <div className="mb-8 relative flex items-center justify-center">
          {/* Radial glow backdrop */}
          <div className="absolute w-72 h-72 rounded-full bg-magnet-600/25 blur-3xl" />
          <div className="absolute w-48 h-48 rounded-full bg-magnet-400/15 blur-2xl" />
          <Image
            src="/magnet-logo.png"
            alt="Magnet Strategies"
            width={275}
            height={275}
            className="relative animate-float magnet-glow-pulse"
            priority
          />
        </div>

        {/* Headline */}
        <h1
          className="glow-text text-5xl font-extrabold tracking-tight text-white sm:text-6xl lg:text-7xl mb-5"
          style={{ fontFamily: "'Times New Roman', Times, serif" }}
        >
          Magnet Strategies
        </h1>

        <div className="w-full max-w-2xl h-0.5 bg-white mb-6" />

        <p className="max-w-xl text-lg text-white leading-relaxed mb-3">
          Exploring the Possibilities &amp; Opportunities within Decentralized Finance
        </p>

        {/* Attribution — under subheader */}
        <a
          href="https://bazookalabs.xyz"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-white/70 hover:text-white transition-colors mb-12"
        >
          A Bazooka Labs Product
        </a>

        {/* App cards — MagnetDAO + MagnetFi */}
        <div className="w-full flex flex-col gap-4 mb-10">

          {/* MagnetDAO */}
          <div className="relative w-full rounded-xl border border-white/10 bg-black/50 backdrop-blur-sm overflow-hidden flex items-center gap-5 px-6 py-5 shadow-xl shadow-black/50 hover:shadow-magnet-900/30 hover:-translate-y-0.5 transition-all duration-200">
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-magnet-500/60 to-transparent" />
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-magnet-600 to-magnet-800 shrink-0">
              <Magnet className="h-7 w-7 text-white drop-shadow-lg" />
            </div>
            <div className="flex-1 text-left">
              <p className="text-base font-semibold text-white">MagnetDAO</p>
              <p className="text-sm text-gray-400">Participate in Algorand liquidity governance</p>
            </div>
            <Link
              href="/dao"
              className="shrink-0 rounded-lg bg-gradient-to-r from-magnet-600 to-magnet-500 px-6 py-2.5 text-sm font-semibold text-white shadow-md shadow-magnet-900/60 hover:from-magnet-500 hover:to-magnet-400 hover:shadow-lg hover:shadow-magnet-700/40 transition-all duration-150"
            >
              Enter DAO
            </Link>
          </div>

          {/* MagnetFi */}
          <div className="relative w-full rounded-xl border border-white/10 bg-black/50 backdrop-blur-sm overflow-hidden flex items-center gap-5 px-6 py-5 shadow-xl shadow-black/50 hover:shadow-magnet-900/30 hover:-translate-y-0.5 transition-all duration-200">
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-magnet-500/60 to-transparent" />
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-magnet-600 to-magnet-800 shrink-0">
              <Landmark className="h-7 w-7 text-white drop-shadow-lg" />
            </div>
            <div className="flex-1 text-left">
              <p className="text-base font-semibold text-white">MagnetFi</p>
              <p className="text-sm text-gray-400">Lend and borrow on Algorand</p>
            </div>
            <Link
              href="/magnetfi"
              className="shrink-0 rounded-lg bg-gradient-to-r from-magnet-600 to-magnet-500 px-6 py-2.5 text-sm font-semibold text-white shadow-md shadow-magnet-900/60 hover:from-magnet-500 hover:to-magnet-400 hover:shadow-lg hover:shadow-magnet-700/40 transition-all duration-150"
            >
              Launch App
            </Link>
          </div>

        </div>

        {/* Stats grid */}
        <div className="w-full grid grid-cols-1 gap-3 sm:grid-cols-3 mb-5">
          <StatCard label="$U Price" value={price} sub="USDC" />
          <StatCard label="$U Holders" value={holders} sub="Active wallets" />
          <StatCard label="Total TVL" value={tvl} sub="$U pools via Vestige" />
        </div>

        {/* Chart */}
        <VestigeChart />

        {/* Swap — full width, centered */}
        <div className="w-full mt-8">
          <HaystackSwap />
        </div>

      </div>
    </div>
  );
}
