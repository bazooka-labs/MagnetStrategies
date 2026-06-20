import Image from "next/image";
import Link from "next/link";
import { Magnet } from "lucide-react";
import dynamic from "next/dynamic";
import { AboutModal } from "@/components/AboutModal";
import { VestigeChart } from "@/components/VestigeChart";

const HaystackSwap = dynamic(
  () => import("@/components/HaystackSwap").then((m) => m.HaystackSwap),
  { ssr: false, loading: () => <div className="rounded-xl border border-white/10 bg-black/50 h-64 animate-pulse" /> }
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
      <div className="relative z-10 mx-auto max-w-4xl px-6 py-20 flex flex-col items-center text-center">

        {/* Logo */}
        <div className="mb-8">
          <Image
            src="/magnet-logo.png"
            alt="Magnet Strategies"
            width={275}
            height={275}
            className="animate-float magnet-glow-pulse"
            priority
          />
        </div>

        {/* Headline */}
        <h1
          className="text-5xl font-extrabold tracking-tight text-white sm:text-6xl lg:text-7xl mb-5"
          style={{ fontFamily: "'Times New Roman', Times, serif" }}
        >
          Magnet Strategies
        </h1>

        <div className="w-full max-w-2xl h-0.5 bg-white mb-6" />

        <p className="max-w-xl text-lg text-white leading-relaxed mb-6">
          Exploring the Possibilities &amp; Opportunities within Decentralized Finance
        </p>

        {/* Social links */}
        <div className="flex flex-col items-center gap-4 mb-12">
        <div className="flex items-center gap-5">
          <a
            href="https://x.com/Bazooka_Labs"
            target="_blank"
            rel="noopener noreferrer"
            className="text-white/60 hover:text-white transition-colors"
            aria-label="X / Twitter"
          >
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.747l7.73-8.835L1.254 2.25H8.08l4.253 5.622 5.911-5.622Zm-1.161 17.52h1.833L7.084 4.126H5.117Z" />
            </svg>
          </a>
          <a
            href="https://discord.gg/naqFXmfM"
            target="_blank"
            rel="noopener noreferrer"
            className="text-white/60 hover:text-white transition-colors"
            aria-label="Discord"
          >
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor">
              <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057c.002.022.015.043.03.056a19.9 19.9 0 0 0 5.993 3.03.077.077 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03ZM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418Zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418Z" />
            </svg>
          </a>
        </div>
          <AboutModal />
        </div>

        {/* Stats grid */}
        <div className="w-full grid grid-cols-1 gap-3 sm:grid-cols-3 mb-12">
          <StatCard label="Price" value={price} sub="USDC" />
          <StatCard label="Holders" value={holders} sub="Active wallets" />
          <StatCard label="Total TVL" value={tvl} sub="$U pools via Vestige" />
        </div>

        {/* Chart */}
        <VestigeChart />

        {/* Swap + DAO */}
        <div className="w-full grid grid-cols-1 gap-4 sm:grid-cols-2">

          {/* Haystack swap */}
          <HaystackSwap />

          {/* MagnetDAO */}
          <div className="relative rounded-xl border border-white/10 bg-black/50 backdrop-blur-sm overflow-hidden flex flex-col shadow-xl shadow-black/50 hover:shadow-magnet-900/30 hover:-translate-y-0.5 transition-all duration-200">
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-magnet-500/60 to-transparent" />
            <div className="h-48 w-full flex items-center justify-center bg-gradient-to-br from-magnet-600 to-magnet-800">
              <Magnet className="h-20 w-20 text-white drop-shadow-lg" />
            </div>
            <div className="flex flex-col flex-1 items-center text-center px-5 pb-5 pt-4 gap-4">
              <p className="text-sm text-gray-300 leading-snug">Participate in Algorand liquidity voting</p>
              <Link
                href="/dao"
                className="mt-auto w-full rounded-lg bg-gradient-to-r from-magnet-600 to-magnet-500 py-2.5 text-sm font-semibold text-white shadow-md shadow-magnet-900/60 hover:from-magnet-500 hover:to-magnet-400 hover:shadow-lg hover:shadow-magnet-700/40 transition-all duration-150"
              >
                DAO
              </Link>
            </div>
          </div>

        </div>

        {/* Attribution */}
        <div className="mt-8">
          <a
            href="https://bazookalabs.xyz"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
          >
            A Bazooka Labs Product
          </a>
        </div>

      </div>
    </div>
  );
}
