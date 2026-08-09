import Image from "next/image";
import Link from "next/link";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";

export default function LandingPage() {
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
        <div className="relative mx-auto max-w-5xl px-6 py-32 flex flex-col items-center text-center">

          {/* Logo mark → headline reveal. Logo is absolutely positioned so its
              size never affects this wrapper's box (sized by the h1 alone) —
              it can be scaled freely with zero layout shift. */}
          <div className="relative mb-8">
            <Image
              src="/magnet-icon.png"
              alt="Magnet Strategies"
              width={320}
              height={320}
              className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 magnet-glow-soft w-40 sm:w-56 lg:w-72 h-auto animate-logo-fade-out"
              priority
            />
            <h1 className="glow-text font-display text-6xl sm:text-7xl lg:text-8xl font-extrabold tracking-tight text-white animate-headline-fade-in">
              Attract Liquidity
            </h1>
          </div>

          <div className="w-32 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent mb-8 animate-fade-up [animation-delay:6050ms]" />

          {/* Tagline */}
          <p className="font-display max-w-2xl text-xl sm:text-2xl font-semibold text-white leading-relaxed mb-5 animate-fade-up [animation-delay:6150ms]">
            Exploring the Possibilities &amp; Opportunities within Decentralized Finance
          </p>

          {/* Learn more */}
          <Link
            href="/about"
            className="mt-9 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-5 py-2.5 text-sm font-medium text-white/80 backdrop-blur-sm transition-colors hover:border-white/30 hover:text-white animate-fade-up [animation-delay:6350ms]"
          >
            Discover Our Products
          </Link>

        </div>
      </div>

      <Footer />
    </div>
  );
}
