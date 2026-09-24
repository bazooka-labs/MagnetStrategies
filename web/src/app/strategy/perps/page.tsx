"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

// The card pulls in @pdex/sdk and algosdk; keep it off the server and out of the
// initial bundle.
const PerpsCard = dynamic(
  () => import("@/components/strategy/perps/PerpsCard").then((m) => m.PerpsCard),
  { ssr: false, loading: () => <div className="h-[640px] rounded-2xl border border-white/10 bg-black/40 animate-pulse" /> },
);

export default function PerpsPage() {
  return (
    <main className="mx-auto w-full max-w-lg px-4 py-10 sm:py-14">
      <Link href="/strategy" className="inline-flex items-center gap-1.5 text-sm text-white/50 hover:text-white transition-colors">
        <ArrowLeft className="h-3.5 w-3.5" /> Strategy
      </Link>
      <h1 className="font-display mt-4 text-2xl font-bold text-white sm:text-3xl">Perps</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-white/50">
        Take a leveraged position on ALGO or BTC. Pick a direction, an amount and a
        target — then sign once.
      </p>
      <div className="mt-6">
        <PerpsCard />
      </div>
    </main>
  );
}
