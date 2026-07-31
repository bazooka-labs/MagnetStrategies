import Image from "next/image";
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

          {/* Logo mark → headline reveal */}
          <div className="grid place-items-center mb-8">
            <Image
              src="/magnet-icon.png"
              alt="Magnet Strategies"
              width={160}
              height={160}
              className="[grid-area:1/1] magnet-glow-soft w-20 sm:w-28 lg:w-36 h-auto animate-logo-fade-out"
              priority
            />
            <h1 className="[grid-area:1/1] glow-text font-display text-6xl sm:text-7xl lg:text-8xl font-extrabold tracking-tight text-white animate-headline-fade-in">
              Attract Liquidity
            </h1>
          </div>

          <div className="w-32 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent mb-8 animate-fade-up [animation-delay:4050ms]" />

          {/* Tagline */}
          <p className="font-display max-w-2xl text-xl sm:text-2xl font-semibold text-white leading-relaxed mb-5 animate-fade-up [animation-delay:4150ms]">
            Exploring the Possibilities &amp; Opportunities within Decentralized Finance
          </p>

          {/* Attribution */}
          <a
            href="https://bazookalabs.xyz"
            target="_blank"
            rel="noopener noreferrer"
            className="text-base text-white/60 hover:text-white transition-colors animate-fade-up [animation-delay:4250ms]"
          >
            A Bazooka Labs Product
          </a>

        </div>
      </div>

      <Footer />
    </div>
  );
}
