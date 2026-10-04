"use client";

// "How this works" and "Before you trade", folded into one modal.
//
// They used to sit permanently in the right-hand column, which pushed the
// position panel down and competed with the chart for the page. As a modal they
// stay one click away without taking space from the things a user came for.
//
// ── Why the risks are still not hidden ──────────────────────────────────────
// Moving a risk disclosure behind a click is only acceptable if it is easy to
// reach and obviously there. The trigger carries the same amber the warnings
// use, so it reads as a caution rather than as a help link, and the risk
// section leads inside the modal rather than following the explainer.
//
// The liquidation box and the PEX attribution stay on the card itself, but
// this comment used to claim more than that: it said "you can lose everything"
// was still on screen without any interaction, and since the default stake was
// removed that is false. A freshly loaded card has an empty amount, so there is
// no quote, and both explanatory lines inside the liquidation box are
// suppressed — the box reads "Liquidation —" and nothing else. That sentence
// now lives only in here, which is a reason to keep this modal easy to reach,
// not a reason to pretend otherwise.

import { useEffect } from "react";
import { AlertTriangle, X } from "lucide-react";

type Props = { open: boolean; onClose: () => void };

export function PerpsInfoModal({ open, onClose }: Props) {
  // Escape closes, and the page behind must not scroll under the overlay.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm sm:items-center"
      onClick={onClose} role="dialog" aria-modal="true" aria-label="About the Trading Terminal">
      <div className="my-auto w-full max-w-2xl rounded-2xl border border-amber-400/25 bg-[#0b0b0d] shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <h2 className="font-display text-lg font-semibold text-amber-200">About the Trading Terminal</h2>
          <button onClick={onClose} aria-label="Close"
            className="rounded-lg p-1 text-white/40 transition-colors hover:bg-white/5 hover:text-white/80">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[70vh] space-y-5 overflow-y-auto px-5 py-5">
          {/* Risk first. A user who reads only the top of a modal should have
              read the part that can cost them money. */}
          <section className="rounded-xl border border-amber-400/25 bg-amber-500/[0.07] p-4">
            <h3 className="flex items-center gap-2 font-display text-base font-semibold text-amber-200">
              <AlertTriangle className="h-4 w-4" />
              Before you trade
            </h3>
            <ul className="mt-3 space-y-2.5 text-sm leading-relaxed text-amber-100/80">
              <li>
                <span className="font-medium text-amber-100">You can lose everything you put in.</span>{" "}
                If the price reaches your liquidation level the position closes at a total loss.
              </li>
              <li>
                <span className="font-medium text-amber-100">PEX has had no external audit.</span>{" "}
                Its team reports twelve rounds of internal AI-assisted review and is candid that
                bugs remain possible. It is a young protocol holding real collateral.
              </li>
              <li>
                <span className="font-medium text-amber-100">Size is limited by the exchange.</span>{" "}
                PEX is early and its pools are thin, so the most you can open moves with available
                depth — sometimes a side is unavailable entirely.
              </li>
            </ul>
          </section>

          <section>
            <h3 className="font-display text-base font-semibold text-white">How this works</h3>
            <ul className="mt-3 space-y-2.5 text-sm leading-relaxed text-gray-300">
              <li>
                <span className="text-white/90">Trades run on PEX</span>, a third-party perpetuals
                protocol on Algorand built by Ultrade. Magnet Strategies operates no exchange and
                never holds your funds — every action is a PEX call signed by your own wallet.
              </li>
              <li>
                <span className="text-white/90">Your position is backed by the USDC you put in.</span>{" "}
                Leverage multiplies both directions: a move against you reaches the liquidation
                price faster the higher you go.
              </li>
              <li>
                <span className="text-white/90">A take-profit is optional.</span> Set one and
                the position closes automatically at that price, so you do not have to watch
                it. Leave it off and the position runs until you close it yourself — or until
                it is liquidated. Nothing closes an unprotected position in your favour.
              </li>
              <li>
                <span className="text-white/90">You can close a position early</span>, in full,
                at the current price. You are never locked in waiting for a trigger.
              </li>
              <li>
                <span className="text-white/90">A limit order rests until its trigger.</span>{" "}
                Your collateral is escrowed while it waits and returned in full if you cancel.
              </li>
            </ul>
          </section>

          <section>
            <h3 className="font-display text-base font-semibold text-white">The price you trade at</h3>
            <ul className="mt-3 space-y-2.5 text-sm leading-relaxed text-gray-300">
              <li>
                <span className="text-white/90">The chart is a market reference.</span> Both views
                show Coinbase — the basic chart directly, the advanced one through TradingView —
                and Coinbase is not the feed PEX prices from.
              </li>
              <li>
                <span className="text-white/90">PEX quotes from its own oracle.</span> On the basic
                chart that price is the dashed violet line across the candles, drawn only while it
                can be read and its signature verified. The advanced chart cannot draw it at all.
                The order card below always carries it, and the card is what your order is
                measured against either way.
              </li>
              <li>
                <span className="text-white/90">Your entry differs from both.</span> PEX charges price
                impact before the trade, so the entry price on the card is the one that matters —
                it is the number the position is actually opened at.
              </li>
            </ul>
          </section>

          <section>
            <h3 className="font-display text-base font-semibold text-white">What leaves your wallet</h3>
            <ul className="mt-3 space-y-2.5 text-sm leading-relaxed text-gray-300">
              <li>
                <span className="text-white/90">Your collateral in USDC</span>, plus a small
                keeper fee for each automatic trigger you attach — about five cents. Attach
                none and you pay no keeper fee.
              </li>
              <li>
                <span className="text-white/90">A little ALGO for on-chain storage.</span> PEX
                holds it as a reusable escrow. Closing a position releases it back into that
                escrow rather than to your wallet; cancelling a resting order returns it to
                your wallet outright.
              </li>
              <li>
                <span className="text-white/90">Magnet charges 10 bps</span> when you open and
                again when you close. The card shows your total cost, this included, before
                you sign.
              </li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
