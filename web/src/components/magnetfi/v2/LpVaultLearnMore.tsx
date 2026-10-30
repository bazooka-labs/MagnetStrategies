"use client";

import { useState } from "react";
import { RAISED_AMBER } from "@/components/raisedButton";
import { createPortal } from "react-dom";
import {
  X, BookOpen, TrendingUp, Lock, Clock, CircleDollarSign, ShieldCheck, AlertTriangle,
} from "lucide-react";

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
      {/* Amber pill, matching every other explainer trigger on the site —
          "About $U", "About the Trading Terminal", the Trading Terminal's
          "More info". It was grey text, which read as a de-emphasised link
          beside the heading it belongs to; an amber pill is the established
          shape for "press here to understand what you are looking at". */}
      <button onClick={() => setOpen(true)} aria-haspopup="dialog"
        className={RAISED_AMBER}>
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
                  Partial tiers are deliberate to avoid closing out borrowers for small mistakes. An oracle prices your
                  collateral; new borrowing and every liquidation trigger are blocked if that price goes stale.
                  What the oracle is, and what you are trusting it with, is set out below.
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
              {/*
                ── What you are trusting ──
                Added 2026-10-30. The modal explained the seizure ladder in
                detail — 35%, 77%, everything — and said only that "a live
                oracle prices your collateral". A depositor reading those tiers
                would reasonably assume the price driving them is robust, and
                nowhere did the product say what it actually is.

                Every claim here is read off the deployed contracts:
                  - lean_oracle `update_lp_price` asserts three things and no
                    more: sender is `authorized_updater`, price > 0, pool
                    whitelisted. No bound on movement, deliberately — see the
                    contract header and ORACLE_LEAN_SPEC.md.
                  - vault `ORACLE_FRESHNESS = 1_800`, asserted in open_vault,
                    borrow_more and all three liquidation triggers.
                  - `paused` gates borrowing only. Liquidation deliberately
                    continues while paused.
                  - off-chain guards are listed in lean_oracle/contract.py.

                It describes the TRUST MODEL, not an attack. The distinction is
                deliberate: what a depositor needs is to know whose judgement
                and whose key their collateral depends on, which the source
                already states publicly. A step-by-step failure path would add
                nothing for them and is not ours to hand out.
              */}
              <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.05] p-5">
                <div className="mb-1 flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-amber-300" />
                  <p className="text-sm font-semibold text-amber-100">What you are trusting</p>
                </div>
                <ul className="mt-2.5 space-y-2 text-xs leading-relaxed text-amber-100/80">
                  <li>
                    <strong className="font-semibold text-amber-100">One key sets the price your
                    health factor is measured against.</strong>{" "}
                    Magnet runs a bot that posts each LP price on chain. The contract accepts any
                    non-zero price from that key and places no limit on how far it may move between
                    posts — a deliberate choice, made after an on-chain band rejected a valid price
                    and froze the feed. The checks that catch a bad number — time-weighted
                    averaging, several independent routes, a second opinion from CompX — run in the
                    bot, off chain. They are built to catch our own bugs, and they would not stop
                    someone who had stolen the key.
                  </li>
                  <li>
                    <strong className="font-semibold text-amber-100">A stale price stops borrowing
                    and liquidation both.</strong>{" "}
                    If the most recent post is more than 30 minutes old, new borrowing and every
                    liquidation trigger are refused until the feed recovers. A guardian key can
                    also pause borrowing. Pausing does not stop liquidations — that is on purpose,
                    so positions can still be made whole during an incident, but it does mean a
                    pause will not protect an unhealthy vault.
                  </li>
                  <li>
                    <strong className="font-semibold text-amber-100">These contracts have had no
                    external audit.</strong>{" "}
                    They have been through a long run of internal review and an executable
                    adversarial test suite, and that review set a ceiling it considers safe:
                    under roughly $100k of collateral across the pools. An outside audit is the
                    gate before going past it. Every contract, every review pass and that ceiling
                    are public in the repository — read them before you deposit.
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
