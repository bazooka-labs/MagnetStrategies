"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { X, BookOpen, TrendingUp, Lock, Clock, CircleDollarSign, ShieldCheck } from "lucide-react";

const FEATURES = [
  { icon: <TrendingUp className="h-5 w-5" />, title: "Collateral keeps earning",
    body: "Access extra capital while your Tinyman LP tokens keep accruing pool trading fees — allowing you to stay liquid while providing liquidity on Algorand." },
  { icon: <Lock className="h-5 w-5" />, title: "Fixed rate, locked at open",
    body: "Your interest rate is fixed for the life of the loan the moment you open your vault. Protocol rates may be subject to change; however, this only impacts newly created vaults. Active vault rates remain unchanged as long as the vault stays opened, allowing for additional borrowing without changing terms." },
  { icon: <Clock className="h-5 w-5" />, title: "Interest-only, pay as you go",
    body: "Borrowers can defer the principal payment as long as they'd like. Just cover the accrued interest at least once every 90 days to keep the position in good standing." },
  { icon: <CircleDollarSign className="h-5 w-5" />, title: "Magnet's Stablecoin",
    body: "You borrow mUSD, Magnet's USDC-backed and redeemable 1:1 stablecoin. Tightly managed through our in-house PSM." },
];

const LADDER = [
  { band: "HF ≥ 1.00", cls: "border-green-500/30 bg-green-500/10 text-green-300", label: "Healthy", body: "Nothing, your position is safe." },
  { band: "0.95 – 1.00", cls: "border-yellow-500/30 bg-yellow-500/10 text-yellow-300", label: "Tier 1", body: "~35% of your LP is seized to restore health, plus a 5% liquidation fee. Your vault continues." },
  { band: "0.85 – 0.95", cls: "border-orange-500/30 bg-orange-500/10 text-orange-300", label: "Tier 2", body: "~77% of your LP is seized to restore health, plus a 7% liquidation fee. Your vault continues." },
  { band: "< 0.85", cls: "border-red-500/30 bg-red-500/10 text-red-300", label: "Full liquidation", body: "All remaining LP collateral is seized to settle your debt — no collateral is returned." },
];

export function LpVaultLearnMore() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 text-sm font-semibold text-gray-400 transition-colors hover:text-white">
        <BookOpen className="h-3.5 w-3.5" /> Learn more
      </button>

      {open && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

          <div
            className="relative z-10 w-full max-w-3xl overflow-hidden rounded-2xl border border-magnet-500/20 bg-gradient-to-br from-magnet-950/90 via-[#0d0818]/95 to-magnet-950/80 shadow-2xl shadow-magnet-900/40"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-magnet-500/60 to-transparent" />

            {/* Header */}
            <div className="flex items-center justify-between border-b border-white/5 px-6 pb-4 pt-6 sm:px-7">
              <div>
                <h2 className="font-display text-xl font-bold text-white">How LP Collateral Vaults work</h2>
                <p className="mt-0.5 text-xs text-gray-500">Everything worth knowing before you open a position.</p>
              </div>
              <button onClick={() => setOpen(false)}
                className="rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-white/5 hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Body */}
            <div className="max-h-[75vh] space-y-5 overflow-y-auto px-6 py-6 sm:px-7">
              <div className="grid gap-3 sm:grid-cols-2">
                {FEATURES.map((f) => (
                  <div key={f.title} className="rounded-xl border border-white/10 bg-black/30 p-4">
                    <div className="mb-2.5 flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-magnet-600 to-magnet-800 text-white">{f.icon}</div>
                    <p className="text-sm font-semibold text-white">{f.title}</p>
                    <p className="mt-1 text-xs leading-relaxed text-gray-400">{f.body}</p>
                  </div>
                ))}
              </div>

              <div className="rounded-xl border border-white/10 bg-black/30 p-5">
                <div className="mb-1 flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-magnet-300" />
                  <p className="text-sm font-semibold text-white">Staying healthy — and what happens if you don&apos;t</p>
                </div>
                <p className="mb-4 text-xs leading-relaxed text-gray-500">
                  Partial tiers are deliberate to avoid closing out borrowers for small mistakes. A live oracle prices your
                  collateral, and borrows are temporarily blocked if the price feed goes stale.
                </p>

                <div className="space-y-2">
                  {LADDER.map((r) => (
                    <div key={r.band} className="flex flex-col gap-1.5 rounded-lg border border-white/5 bg-black/40 p-3 sm:flex-row sm:items-center sm:gap-4">
                      <span className={`inline-flex w-fit shrink-0 items-center rounded-full border px-2.5 py-0.5 font-mono text-[11px] font-semibold ${r.cls}`}>{r.band}</span>
                      <span className="shrink-0 text-xs font-semibold text-white sm:w-28">{r.label}</span>
                      <span className="text-xs leading-relaxed text-gray-400">{r.body}</span>
                    </div>
                  ))}
                </div>

                <div className="mt-4 flex items-start gap-2 rounded-lg border border-white/5 bg-black/40 px-3 py-2.5">
                  <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-magnet-400" />
                  <p className="text-xs leading-relaxed text-gray-400">
                    <span className="font-medium text-white">Missed your 90-day interest payment?</span> The vault flips to &ldquo;payment overdue,&rdquo; and the
                    protocol may run a micro-liquidation — seizing only enough of the collateralized LP tokens to cover the interest owed plus a 5% fee.
                    Your principal loan is untouched, the loan continues and the 90-day clock resets.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
