"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { Wallet, ChevronDown, Copy, Check, LogOut } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import type { Wallet as WalletType } from "@txnlab/use-wallet-react";

export function WalletButton() {
  const { address, isConnected, isConnecting, disconnect, wallets } = useWallet();
  const [showMenu, setShowMenu] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Anchor the dropdown to the button's bottom-right in viewport (fixed) coordinates. Rendered via
  // a portal to <body> so it escapes the navbar's overflow-clip + stacking context (the reason it
  // was rendering "behind" other layers). Right-aligned + clamped so it never runs off-screen.
  const place = useCallback(() => {
    const el = anchorRef.current;
    if (!el || typeof window === "undefined") return;
    const r = el.getBoundingClientRect();
    setPos({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) });
  }, []);

  const toggle = () => {
    if (showMenu) { setShowMenu(false); return; }
    place();
    setShowMenu(true);
  };

  useEffect(() => {
    if (!showMenu) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t) || dropdownRef.current?.contains(t)) return;
      setShowMenu(false);
    }
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [showMenu, place]);

  function truncate(addr: string) {
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  }

  async function copyAddr() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  }

  const menu =
    showMenu && pos
      ? createPortal(
          <div
            ref={dropdownRef}
            style={{ position: "fixed", top: pos.top, right: pos.right, zIndex: 100 }}
            className="w-60 max-w-[calc(100vw-16px)] rounded-xl border border-white/10 bg-[#0d0015] shadow-2xl overflow-hidden"
          >
            {isConnected ? (
              <div className="p-2">
                <div className="rounded-lg bg-black/40 px-3 py-2.5">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-gray-500">Connected</p>
                  <p className="mt-0.5 break-all font-mono text-xs text-magnet-300">{address}</p>
                </div>
                <button
                  onClick={copyAddr}
                  className="mt-1 flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-gray-300 hover:bg-white/5 hover:text-white transition-colors"
                >
                  {copied ? <Check className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}
                  {copied ? "Copied" : "Copy address"}
                </button>
                <button
                  onClick={() => { disconnect(); setShowMenu(false); }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-red-300 hover:bg-red-500/10 hover:text-red-200 transition-colors"
                >
                  <LogOut className="h-4 w-4" /> Disconnect
                </button>
              </div>
            ) : (
              <>
                <div className="border-b border-white/5 px-3 py-2">
                  <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Select Wallet</p>
                </div>
                <div className="py-1">
                  {wallets?.map((w: WalletType) => (
                    <button
                      key={w.id}
                      onClick={async () => { await w.connect(); setShowMenu(false); }}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-sm text-gray-300 hover:bg-white/5 hover:text-white transition-colors"
                    >
                      {w.metadata.icon ? (
                        // eslint-disable-next-line @next/next/no-img-element -- wallet icons are data URIs from use-wallet
                        <img src={w.metadata.icon} alt="" className="h-6 w-6 shrink-0 rounded" />
                      ) : (
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-white/10 text-xs font-bold uppercase">
                          {w.metadata.name.charAt(0)}
                        </span>
                      )}
                      {w.metadata.name}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>,
          document.body,
        )
      : null;

  return (
    <div ref={anchorRef} className="shrink-0">
      {isConnected ? (
        <button
          onClick={toggle}
          className="inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-black/40 px-2.5 sm:px-3 py-1.5 text-xs font-mono text-magnet-300 hover:border-magnet-500/40 transition-colors"
        >
          <Wallet className="h-3.5 w-3.5 shrink-0" />
          <span className="hidden sm:inline">{truncate(address ?? "")}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
        </button>
      ) : (
        <button
          onClick={toggle}
          disabled={isConnecting}
          className="inline-flex items-center gap-1.5 sm:gap-2 rounded-lg bg-gradient-to-r from-magnet-600 to-magnet-500 px-3 sm:px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-magnet-600/20 hover:from-magnet-500 hover:to-magnet-400 transition-all disabled:opacity-50"
        >
          <Wallet className="h-4 w-4" />
          <span className="hidden sm:inline">{isConnecting ? "Connecting..." : "Connect Wallet"}</span>
          <span className="sm:hidden">{isConnecting ? "..." : "Connect"}</span>
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      )}
      {menu}
    </div>
  );
}
