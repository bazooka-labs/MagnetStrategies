"use client";

import { useRef, useState, useEffect } from "react";
import { Wallet, ChevronDown } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import type { Wallet as WalletType } from "@txnlab/use-wallet-react";

export function WalletButton() {
  const { address, isConnected, isConnecting, disconnect, wallets } = useWallet();
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function truncate(addr: string) {
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  }

  if (isConnected) {
    return (
      <div className="flex items-center gap-3">
        <span className="rounded-full border border-white/20 bg-black/40 px-3 py-1.5 text-xs font-mono text-magnet-400">
          {truncate(address ?? "")}
        </span>
        <button
          onClick={disconnect}
          className="text-sm text-white/50 hover:text-white transition-colors"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setShowMenu((v) => !v)}
        disabled={isConnecting}
        className="inline-flex items-center gap-1.5 sm:gap-2 rounded-lg bg-gradient-to-r from-magnet-600 to-magnet-500 px-3 sm:px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-magnet-600/20 hover:from-magnet-500 hover:to-magnet-400 transition-all disabled:opacity-50 shrink-0"
      >
        <Wallet className="h-4 w-4" />
        <span className="hidden sm:inline">{isConnecting ? "Connecting..." : "Connect Wallet"}</span>
        <span className="sm:hidden">{isConnecting ? "..." : "Connect"}</span>
        <ChevronDown className="h-3.5 w-3.5" />
      </button>

      {showMenu && (
        <div className="absolute left-1/2 -translate-x-1/2 mt-2 w-52 rounded-lg border border-white/10 bg-[#0d0015] shadow-xl overflow-hidden z-50">
          <div className="px-3 py-2 border-b border-white/5">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">
              Select Wallet
            </p>
          </div>
          <div className="py-1">
            {wallets?.map((w: WalletType) => (
              <button
                key={w.id}
                onClick={async () => {
                  await w.connect();
                  setShowMenu(false);
                }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-300 hover:bg-white/5 hover:text-white transition-colors"
              >
                <span className="flex h-6 w-6 items-center justify-center rounded bg-white/10 text-xs font-bold uppercase">
                  {w.metadata.name.charAt(0)}
                </span>
                {w.metadata.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
