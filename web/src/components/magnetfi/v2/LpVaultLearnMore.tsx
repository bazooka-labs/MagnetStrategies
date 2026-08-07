"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { X, BookOpen, TrendingUp, Lock, Clock, CircleDollarSign, ShieldCheck } from "lucide-react";
import { VAULT_TYPES, pct } from "@/lib/magnetfi";

const POOL = VAULT_TYPES.find((v) => v.status === "launching")!; // U/tALGO — launch params

const FEATURES = [
  { icon: <TrendingUp className="h-5 w-5" />, title: "Collateral keeps earning",
    body: "Your Tinyman LP tokens keep accruing pool trading fees the whole time they back your loan — you reclaim the same LP, now worth more." },
  { icon: <Lock className="h-5 w-5" />, title: "Fixed rate, locked at open",
    body: "Your interest rate is set the moment you open and never changes — even if protocol rates move or you borrow more against the same vault." },
  { icon: <Clock className="h-5 w-5" />, title: "Interest-only, pay as you go",
    body: "Repay principal whenever you like. Just cover accrued interest at least once every 90 days to keep the position in good standing." },
  { icon: <CircleDollarSign className="h-5 w-5" />, title: "Borrow a real dollar",
    body: "You borrow mUSD — fully USDC-backed and redeemable 1:1. No maturity date; the loan stays open as long as you stay healthy." },
];

const LADDER = [
  { band: "HF ≥ 1.00", cls: "border-green-500/30 bg-green-500/10 text-green-300", label: "Healthy", body: "Nothing happens — your position is safe." },
  { band: "0.95 – 1.00", cls: "border-yellow-500/30 bg-yellow-500/10 text-yellow-300", label: "Tier 1", body: "~35% of your LP is seized to restore health. The position continues." },
  { band: "0.85 – 0.95", cls: "border-orange-500/30 bg-orange-500/10 text-orange-300", label: "Tier 2", body: "~60% of your LP is seized. The position continues." },
  { band: "< 0.85", cls: "border-red-500/30 bg-red-500/10 text-red-300", label: "Full liquidation", body: "All LP is seized — but any value above your debt is returned to you." },
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
                  Health factor = collateral value × {pct(POOL.liqThresholdBps)}% liquidation threshold ÷ your debt. You can borrow
                  up to {pct(POOL.ltvBps)}% of your collateral&apos;s value at open, and you can add collateral any time to raise your health factor.
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
                    <span className="font-medium text-white">Miss your 90-day interest payment?</span> The vault flips to &ldquo;payment overdue,&rdquo; and the
                    protocol may run a micro-liquidation — seizing only enough LP to cover the interest owed plus a 5% buffer.
                    Your principal is untouched and the loan continues; the 90-day clock resets.
                  </p>
                </div>

                <p className="mt-3 text-[11px] leading-relaxed text-gray-500">
                  Partial tiers are deliberate — they take just enough to nudge you back toward health, not close you out. You
                  only lose all collateral value if it falls to or below your debt. A live oracle prices your collateral, and
                  borrows are blocked if the price feed goes stale.
                </p>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
