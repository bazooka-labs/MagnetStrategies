"use client";

// Perps tab. Hero block mirrors MagnetTokenView so the arm reads as part of the
// same product family — same rounded-2xl panel, hairline, drifting blob, display
// face and status pill.

import dynamic from "next/dynamic";
import Image from "next/image";
import { PEX_MARKETS } from "@/lib/perps";

const pulse = () => (
  <div className="h-[620px] rounded-2xl border border-white/10 bg-black/40 animate-pulse" />
);

// Pulls in @pdex/sdk and algosdk — keep it off the server and out of the
// initial bundle.
const PerpsCard = dynamic(
  () => import("@/components/strategy/perps/PerpsCard").then((m) => m.PerpsCard),
  { ssr: false, loading: pulse },
);

export function PerpsView() {
  return (
    <>
      {/* Hero */}
      <div className="relative mb-8 overflow-hidden rounded-2xl border border-white/10 bg-black/40 px-6 py-8 backdrop-blur-sm sm:px-10 sm:py-10">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-magnet-500/60 to-transparent" />
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="animate-blob-drift absolute -right-16 -top-16 h-56 w-56 rounded-full bg-magnet-600/20 blur-3xl" />
        </div>

        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <div className="h-14 w-14 shrink-0 overflow-hidden rounded-2xl shadow-lg shadow-magnet-900/50">
              <Image
                src="/magnet-icon.png" alt="" width={56} height={56}
                className="h-full w-full object-cover" priority
              />
            </div>
            <div>
              <h1 className="font-display magnet-glow-soft text-3xl font-bold text-white sm:text-4xl">
                Perps
              </h1>
              <p className="mt-1 max-w-xl text-sm text-gray-300">
                Go long or short on {Object.values(PEX_MARKETS).map((m) => m.label.split("/")[0]).join(" and ")} with
                leverage. Pick a direction, an amount and a target — then sign once.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <span className="inline-flex w-fit items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1.5 text-xs font-medium text-blue-200">
              <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
              Live prices · trading soon
            </span>
          </div>
        </div>
      </div>

      {/* Card, and what sits behind it */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,420px)_1fr]">
        <PerpsCard />

        <div className="space-y-4">
          <div className="rounded-2xl border border-white/10 bg-black/40 p-5 backdrop-blur-sm">
            <h2 className="font-display text-lg font-semibold text-white">How this works</h2>
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
                <span className="text-white/90">Every position carries a take-profit.</span> It
                closes automatically at the price you set, so you do not have to watch it.
              </li>
            </ul>
          </div>

          <div className="rounded-2xl border border-amber-400/20 bg-amber-500/[0.06] p-5">
            <h2 className="font-display text-lg font-semibold text-amber-200">Before you trade</h2>
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
          </div>
        </div>
      </div>
    </>
  );
}
