"use client";

import Link from "next/link";
import { useWallet } from "@/hooks/useWallet";
import { Magnet, Menu, X, ChevronDown, Wallet } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import type { Wallet as WalletType } from "@txnlab/use-wallet-react";

export function Navbar() {
  const { address, isConnected, isConnecting, connect, disconnect, wallets } =
    useWallet();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [showWalletMenu, setShowWalletMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const navLinks = [
    { href: "/dao", label: "Governance" },
    { href: "/dao/proposals", label: "Proposals" },
    { href: "/dao/treasury", label: "Treasury" },
  ];

  function truncateAddress(addr: string): string {
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  }

  // Close wallet menu on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowWalletMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  async function handleWalletConnect(wallet: WalletType) {
    setShowWalletMenu(false);
    await wallet.connect();
  }

  return (
    <nav className="sticky top-0 z-50 border-b border-gray-800/60 bg-surface/80 backdrop-blur-xl">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5 group">
            <div className="flex h-8 w-8 items-center justify-center rounded bg-gradient-to-br from-magnet-500 to-magnet-700">
              <Magnet className="h-4.5 w-4.5 text-white" />
            </div>
            <span className="text-lg font-bold text-white group-hover:text-magnet-400 transition-colors">
              Magnet Strategies
            </span>
          </Link>

          {/* Desktop nav */}
          <div className="hidden md:flex items-center gap-8">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm font-medium text-gray-400 hover:text-white transition-colors"
              >
                {link.label}
              </Link>
            ))}
          </div>

          <div className="flex items-center gap-4">
            {isConnected ? (
              <div className="flex items-center gap-3">
                <span className="hidden sm:inline-block rounded-full bg-surface-lighter px-3 py-1.5 text-xs font-mono text-magnet-400">
                  {truncateAddress(address ?? "")}
                </span>
                <button
                  onClick={disconnect}
                  className="rounded-lg border border-gray-700 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-surface-lighter hover:text-white transition-all"
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <div className="relative" ref={menuRef}>
                <button
                  onClick={() => setShowWalletMenu(!showWalletMenu)}
                  disabled={isConnecting}
                  className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-magnet-600 to-magnet-500 px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-magnet-600/20 hover:from-magnet-500 hover:to-magnet-400 transition-all disabled:opacity-50"
                >
                  <Wallet className="h-4 w-4" />
                  {isConnecting ? "Connecting..." : "Connect Wallet"}
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>

                {showWalletMenu && (
                  <div className="absolute right-0 mt-2 w-56 rounded-lg border border-gray-700 bg-surface-light shadow-xl overflow-hidden z-50">
                    <div className="px-3 py-2 border-b border-gray-800">
                      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Select Wallet
                      </p>
                    </div>
                    <div className="py-1">
                      {wallets.map((wallet: WalletType) => (
                        <button
                          key={wallet.id}
                          onClick={() => handleWalletConnect(wallet)}
                          disabled={wallet.isConnected}
                          className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-300 hover:bg-surface-lighter hover:text-white transition-colors disabled:opacity-50"
                        >
                          <span className="flex h-6 w-6 items-center justify-center rounded bg-surface-lighter text-xs font-bold uppercase">
                            {wallet.metadata.name.charAt(0)}
                          </span>
                          <span>{wallet.metadata.name}</span>
                          {wallet.isConnected && (
                            <span className="ml-auto text-xs text-green-400">
                              Connected
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Mobile toggle */}
            <button
              onClick={() => setMobileOpen(!mobileOpen)}
              className="md:hidden rounded-lg p-2 text-gray-400 hover:text-white hover:bg-surface-lighter"
            >
              {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {/* Mobile menu */}
        {mobileOpen && (
          <div className="md:hidden border-t border-gray-800 py-4">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMobileOpen(false)}
                className="block py-2 text-sm font-medium text-gray-400 hover:text-white"
              >
                {link.label}
              </Link>
            ))}
          </div>
        )}
      </div>
    </nav>
  );
}
