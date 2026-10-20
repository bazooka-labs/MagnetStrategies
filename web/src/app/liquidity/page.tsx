import type { Metadata } from "next";
import dynamic from "next/dynamic";

/**
 * Strategy — liquidity provision into PEX's pools.
 *
 * ── Why the route is /liquidity and not /strategy ─────────────────────────
 * `/strategy` is a permanent (301) redirect to `/trade`, because it was the
 * trading terminal's former name. Two problems with reusing it, either of them
 * disqualifying:
 *
 *   1. Browsers cache 301s indefinitely. Anyone who has ever hit /strategy
 *      could not reach a page here — not even by typing the URL — and we cannot
 *      clear their cache.
 *   2. Every existing link, bookmark and cached redirect pointing at /strategy
 *      wants the TERMINAL. Repurposing the path sends those people to the wrong
 *      product. `src/components/strategy/` likewise still means "perps".
 *
 * The page is still called Strategy in the nav; only the path differs, which is
 * unremarkable. See web/STRATEGY_SPEC.md §2.
 */

export const metadata: Metadata = {
  title: "Strategy — Magnet Strategies",
  description:
    "Provide liquidity to the PEX perpetuals pools and raise the open-interest ceiling. "
    + "Capital goes to PEX, a third-party protocol by Ultrade; Magnet Strategies holds no funds.",
};

// Pulls algosdk and the PEX read layer — lazy so the route stays light, and
// ssr:false because every figure on it comes from a chain read.
const LiquidityView = dynamic(
  () => import("@/components/liquidity/LiquidityView").then((m) => m.LiquidityView),
  {
    ssr: false,
    loading: () => (
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
        <div className="grid gap-5 md:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-80 animate-pulse rounded-2xl border border-white/10 bg-black/40" />
          ))}
        </div>
      </div>
    ),
  },
);

export default function LiquidityPage() {
  return <LiquidityView />;
}
