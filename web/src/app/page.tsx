import Image from "next/image";
import Link from "next/link";
import { Landmark, Wheat } from "lucide-react";
import dynamic from "next/dynamic";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";

const TokenTradeModal = dynamic(
  () => import("@/components/TokenTradeModal").then((m) => m.TokenTradeModal),
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
    const tvl = Math.round(Number(entry.total_lockup) * Number(entry.price) * 2);
    return `${tvl.toLocaleString("en-US")} ALGO`;
  } catch {
    return "—";
  }
}

export default async function LandingPage() {
  const [holders, price, tvl] = await Promise.all([
    fetchHolderCount(),
    fetchMagnetPriceUSDC(),
    fetchTVL(),
  ]);

  return (
    <div className="relative min-h-screen flex flex-col">
      <Navbar />

      <div className="relative flex-1 flex flex-col items-center justify-center overflow-hidden">
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

        {/* Ambient drifting gradient blobs */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="animate-blob-drift absolute top-1/4 -left-24 w-[28rem] h-[28rem] rounded-full bg-magnet-600/20 blur-[100px]" />
          <div className="animate-blob-drift-slow absolute bottom-0 -right-24 w-[26rem] h-[26rem] rounded-full bg-magnet-400/15 blur-[100px]" />
        </div>

        {/* Content */}
        <div className="relative z-10 mx-auto max-w-4xl px-6 pt-32 pb-20 flex flex-col items-center text-center">

          {/* Wordmark */}
          <div className="mb-8 relative flex items-center justify-center animate-fade-up">
            <Image
              src="/magnet-wordmark.png"
              alt="Magnet Strategies"
              width={520}
              height={168}
              className="magnet-glow-soft w-[280px] sm:w-[380px] lg:w-[460px] h-auto"
              priority
            />
          </div>

          {/* Headline */}
          <p className="font-display max-w-xl text-lg sm:text-xl font-semibold text-white leading-relaxed mb-3 animate-fade-up [animation-delay:100ms]">
            Exploring the Possibilities &amp; Opportunities within Decentralized Finance
          </p>

          {/* Attribution */}
          <a
            href="https://bazookalabs.xyz"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-white/60 hover:text-white transition-colors mb-8 animate-fade-up [animation-delay:150ms]"
          >
            A Bazooka Labs Product
          </a>

          {/* Live stat strip */}
          <div className="mb-10 flex flex-wrap items-stretch justify-center divide-x divide-white/10 rounded-2xl sm:rounded-full border border-white/10 bg-black/40 backdrop-blur-sm shadow-lg shadow-black/40 animate-fade-up [animation-delay:200ms]">
            <div className="px-4 sm:px-6 py-3 text-left">
              <p className="text-[11px] uppercase tracking-wider text-white/40">Price</p>
              <p className="font-mono text-sm font-semibold text-white">{price}</p>
            </div>
            <div className="px-4 sm:px-6 py-3 text-left">
              <p className="text-[11px] uppercase tracking-wider text-white/40">Holders</p>
              <p className="font-mono text-sm font-semibold text-white">{holders}</p>
            </div>
            <div className="px-4 sm:px-6 py-3 text-left">
              <p className="text-[11px] uppercase tracking-wider text-white/40">TVL</p>
              <p className="font-mono text-sm font-semibold text-white">{tvl}</p>
            </div>
          </div>

          {/* App cards */}
          <div className="w-full flex flex-col gap-4 mb-10">

            {/* $U Token */}
            <div className="animate-fade-up [animation-delay:250ms]">
              <TokenTradeModal price={price} holders={holders} tvl={tvl} />
            </div>

            {/* Magnet Farms */}
            <div className="animate-fade-up [animation-delay:300ms] relative w-full rounded-xl border border-white/10 bg-black/50 backdrop-blur-sm overflow-hidden flex items-center gap-5 px-6 py-5 shadow-xl shadow-black/50 hover:shadow-magnet-900/30 hover:-translate-y-0.5 hover:border-magnet-500/30 transition-all duration-200">
              <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-magnet-500/60 to-transparent" />
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-magnet-600 to-magnet-800 shrink-0">
                <Wheat className="h-7 w-7 text-white drop-shadow-lg" />
              </div>
              <div className="flex-1 text-left">
                <p className="font-display text-base font-semibold text-white">Magnet Farms</p>
                <p className="text-sm text-gray-400">Earn yield by providing liquidity on Algorand</p>
              </div>
              <a
                href="https://app.tinyman.org/pool/AIR4CSC54U33WCX4JTMJA4X6PHBVG7OGX7XVV2MCACYSSDULZNJ2KNGRZI"
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 rounded-lg bg-gradient-to-r from-magnet-600 to-magnet-500 px-6 py-2.5 text-sm font-semibold text-white shadow-md shadow-magnet-900/60 hover:from-magnet-500 hover:to-magnet-400 hover:shadow-lg hover:shadow-magnet-700/40 transition-all duration-150"
              >
                Rewards
              </a>
            </div>

            {/* MagnetFi */}
            <div className="animate-fade-up [animation-delay:350ms] relative w-full rounded-xl border border-white/10 bg-black/50 backdrop-blur-sm overflow-hidden flex items-center gap-5 px-6 py-5 shadow-xl shadow-black/50 hover:shadow-magnet-900/30 hover:-translate-y-0.5 hover:border-magnet-500/30 transition-all duration-200">
              <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-magnet-500/60 to-transparent" />
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-magnet-600 to-magnet-800 shrink-0">
                <Landmark className="h-7 w-7 text-white drop-shadow-lg" />
              </div>
              <div className="flex-1 text-left">
                <p className="font-display text-base font-semibold text-white">MagnetFi</p>
                <p className="text-sm text-gray-400">Borrow mUSD against your LP on Algorand</p>
              </div>
              <Link
                href="/magnetfi"
                className="shrink-0 rounded-lg bg-gradient-to-r from-magnet-600 to-magnet-500 px-6 py-2.5 text-sm font-semibold text-white shadow-md shadow-magnet-900/60 hover:from-magnet-500 hover:to-magnet-400 hover:shadow-lg hover:shadow-magnet-700/40 transition-all duration-150"
              >
                Launch App
              </Link>
            </div>

          </div>

        </div>
      </div>

      <Footer />
    </div>
  );
}
