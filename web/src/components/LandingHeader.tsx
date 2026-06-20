"use client";

import { Magnet } from "lucide-react";
import { AboutModal } from "@/components/AboutModal";
import { WalletButton } from "@/components/WalletButton";

export function LandingHeader() {
  return (
    <header className="fixed top-0 left-0 right-0 z-50 border-b border-white/10 bg-black/50 backdrop-blur-md">
      <div className="mx-auto max-w-7xl px-6 h-16 flex items-center justify-between">

        {/* Brand */}
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded bg-gradient-to-br from-magnet-500 to-magnet-700">
            <Magnet className="h-4 w-4 text-white" />
          </div>
          <span
            className="text-base font-bold text-white"
            style={{ fontFamily: "'Times New Roman', Times, serif" }}
          >
            Magnet Strategies
          </span>
        </div>

        {/* Right: About + Wallet */}
        <div className="flex items-center gap-3">
          <AboutModal />
          <WalletButton />
        </div>

      </div>
    </header>
  );
}
