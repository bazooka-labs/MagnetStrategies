import Image from "next/image";
import Link from "next/link";
import { Coins, Landmark, Wheat } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";
import { fetchHolderCount, fetchMagnetPriceUSDC, fetchTVL } from "@/lib/tokenStats";

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
        <div className="relative mx-auto max-w-4xl px-6 pt-32 pb-20 flex flex-col items-center text-center">

          {/* Headline */}
          <h1 className="glow-text font-display text-5xl sm:text-6xl lg:text-7xl font-extrabold tracking-tight text-white mb-6 animate-fade-up">
            Attract Liquidity
          </h1>

          <div className="w-24 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent mb-6 animate-fade-up [animation-delay:50ms]" />

          {/* Tagline */}
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
            <div className="animate-fade-up [animation-delay:250ms] relative w-full rounded-xl border border-white/10 bg-black/50 backdrop-blur-sm overflow-hidden flex items-center gap-5 px-6 py-5 shadow-xl shadow-black/50 hover:shadow-magnet-900/30 hover:-translate-y-0.5 hover:border-magnet-500/30 transition-all duration-200">
              <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-magnet-500/60 to-transparent" />
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-magnet-600 to-magnet-800 shrink-0">
                <Coins className="h-7 w-7 text-white drop-shadow-lg" />
              </div>
              <div className="flex-1 text-left">
                <p className="font-display text-base font-semibold text-white">$U Token</p>
                <p className="text-sm text-gray-400">Price, holders, and live trading</p>
              </div>
              <Link
                href="/token"
                className="shrink-0 rounded-lg bg-gradient-to-r from-magnet-600 to-magnet-500 px-6 py-2.5 text-sm font-semibold text-white shadow-md shadow-magnet-900/60 hover:from-magnet-500 hover:to-magnet-400 hover:shadow-lg hover:shadow-magnet-700/40 transition-all duration-150"
              >
                Trade
              </Link>
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
