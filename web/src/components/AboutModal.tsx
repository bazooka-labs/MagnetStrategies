"use client";

import { useState } from "react";
import { X } from "lucide-react";

export function AboutModal() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-sm font-medium text-white/60 hover:text-white transition-colors"
      >
        About
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          onClick={() => setOpen(false)}
        >
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

          <div
            className="relative z-10 w-full max-w-2xl rounded-2xl border border-magnet-500/20 bg-gradient-to-br from-magnet-950/90 via-[#0d0818]/95 to-magnet-950/80 shadow-2xl shadow-magnet-900/40 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-magnet-500/60 to-transparent" />

            {/* Header */}
            <div className="flex items-center justify-between px-7 pt-7 pb-5 border-b border-white/5">
              <div>
                <h2 className="font-display text-xl font-bold text-white">Magnet Strategies</h2>
                <p className="text-xs text-gray-500 mt-0.5">A Bazooka Labs Product</p>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="rounded-lg p-1.5 text-gray-500 hover:text-white hover:bg-white/5 transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Body */}
            <div className="px-7 py-6 space-y-5 text-sm text-gray-400 leading-relaxed max-h-[70vh] overflow-y-auto">

              <p>
                <span className="text-white font-semibold">Magnet Strategies</span> is an
                Algorand-native DeFi organization built to attract and compound liquidity. The
                Magnet token (<span className="text-magnet-400 font-semibold">$U</span>) sits at
                the center of everything we build, with the goal of outperforming a simple ALGO
                holding over time by putting capital to work across multiple Algorand DeFi
                strategies and reinvesting returns to support the token&apos;s underlying value.
              </p>

              <div>
                <h3 className="font-display text-white font-semibold mb-2">The Magnet Token ($U)</h3>
                <p>
                  Launched in June 2025, $U has a fixed supply of 750,000 tokens on Algorand (ASA
                  ID: 3081853135). It&apos;s the primary asset across every Magnet Strategies
                  product, and its value is directly tied to the performance of the underlying
                  DeFi strategies it powers.
                </p>
              </div>

              <div>
                <h3 className="font-display text-white font-semibold mb-2">MagnetFi</h3>
                <p>
                  MagnetFi is the lending and borrowing arm of Magnet Strategies. It operates across
                  two distinct layers:
                </p>
                <ul className="mt-3 space-y-2 pl-4">
                  <li className="flex gap-2">
                    <span className="text-magnet-400 shrink-0">·</span>
                    <span>
                      <span className="text-white font-medium">Single-Token Markets</span> — live
                      $U and USDC lending pools hosted on the CompX protocol. Deposit assets to earn
                      yield or borrow against approved collateral, with rates set dynamically by
                      on-chain utilization.
                    </span>
                  </li>
                  <li className="flex gap-2">
                    <span className="text-magnet-400 shrink-0">·</span>
                    <span>
                      <span className="text-white font-medium">LP Collateral Vaults (v2)</span> — a
                      novel MagnetFi-native protocol that lets users borrow the{" "}
                      <span className="text-white font-medium">mUSD</span> stablecoin against
                      Tinyman LP tokens. Your liquidity position keeps earning trading fees while
                      it works as collateral — unlocking capital without unwinding your LP.
                    </span>
                  </li>
                </ul>
              </div>

              <div>
                <h3 className="font-display text-white font-semibold mb-2">Magnet Farms</h3>
                <p>
                  Magnet Farms connects $U holders to active liquidity incentive programs on
                  Algorand DEXes. By providing liquidity to approved pools, farmers earn trading
                  fees and any additional rewards on top — compounding returns alongside their
                  $U exposure.
                </p>
              </div>

              <div>
                <h3 className="font-display text-white font-semibold mb-2">The Strategy</h3>
                <p>
                  Every product within Magnet Strategies is designed to work together. $U sits at
                  the center — collateralizing MagnetFi loans, anchoring farm pairs, and accruing
                  value from fees generated across each layer. The goal is a self-reinforcing
                  ecosystem where each product strengthens the others over time.
                </p>
              </div>

              <p className="text-gray-500 text-xs pt-3 border-t border-white/5">
                Magnet Strategies takes a long-term, cycle-resilient approach to DeFi. We remain
                committed to building and collaborating within the Algorand ecosystem for years to come.
              </p>

              <div className="pt-2 border-t border-white/5">
                <h3 className="text-gray-500 text-xs font-semibold uppercase tracking-widest mb-2">Important Risk Disclosure</h3>
                <p className="text-gray-600 text-xs leading-relaxed">
                  DeFi involves significant risks including smart contract vulnerabilities, impermanent
                  loss, market volatility, and governance uncertainties. Past performance is not
                  indicative of future results. Users should conduct their own research and only
                  invest what they can afford to lose.
                </p>
              </div>

            </div>
          </div>
        </div>
      )}
    </>
  );
}
