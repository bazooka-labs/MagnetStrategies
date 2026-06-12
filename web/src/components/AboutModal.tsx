"use client";

import { useState } from "react";
import { X } from "lucide-react";

export function AboutModal() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-lg border border-magnet-500/40 bg-magnet-600/20 px-5 py-2 text-sm font-medium text-magnet-200 hover:bg-magnet-600/35 hover:border-magnet-400/60 hover:text-white transition-all backdrop-blur-sm shadow-md shadow-magnet-900/40"
      >
        About Magnet Strategies
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
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
                <h2 className="text-xl font-bold text-white">Magnet Strategies</h2>
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
                Algorand-native DeFi organization with a focused long-term objective: to grow the
                value of the Magnet token (<span className="text-magnet-400 font-semibold">$U</span>)
                with the goal of outperforming a simple ALGO holding over time. Rather than tracking
                the broader market, $U is designed to compound yield across multiple Algorand DeFi
                strategies and reinvest returns to support the token&apos;s underlying value.
              </p>

              <div>
                <h3 className="text-white font-semibold mb-2">The Strategy</h3>
                <p>
                  Magnet Strategies pursues sustainable yield through a diversified set of Algorand
                  DeFi activities. Core approaches include strategic liquidity pool pairings that
                  generate ongoing swap fees, liquid staking and node participation rewards, and
                  stablecoin lending positions. Each strategy is selected and actively managed based
                  on years of hands-on experience in Algorand DeFi since its earliest days.
                </p>
              </div>

              <div>
                <h3 className="text-white font-semibold mb-2">MagnetDAO</h3>
                <p>
                  The liquidity deployment process is governed by MagnetDAO — an on-chain,
                  community-driven governance system. Each quarter, Algorand projects can apply
                  for treasury-backed liquidity support. $U holders vote on allocations (1 $U = 1
                  vote). Approved projects are paired with $U in live DEX pools, where generated
                  swap fees flow back into the treasury to compound in future cycles.
                </p>
                <p className="mt-3">
                  For holders, owning $U delivers passive exposure to a rotating selection of
                  Algorand projects through these liquidity pairings — without the need to manage
                  individual DeFi positions manually. It functions as a diversified, actively
                  managed window into the ecosystem.
                </p>
              </div>

              <div>
                <h3 className="text-white font-semibold mb-2">The Magnet Token ($U)</h3>
                <p>
                  Launched in June 2025, $U has a fixed supply of 750,000 tokens on Algorand (ASA
                  ID: 3081853135). It serves as both the governance token for MagnetDAO and the
                  primary asset in every treasury liquidity pool. This dual role directly links its
                  value to the performance of the underlying strategies.
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
