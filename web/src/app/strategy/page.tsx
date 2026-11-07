import type { Metadata } from "next";
import dynamic from "next/dynamic";
import { MagnetTokenView } from "@/components/tokens/MagnetTokenView";
import {
  MAGNET_ASA_ID, fetchHolderCount, fetchMagnetPriceUSDC, fetchMagnetYtd, fetchTVL,
} from "@/lib/tokenStats";

/**
 * Strategy — liquidity provision into PEX's pools.
 *
 * ── The route, and the one residual risk in it ────────────────────────────
 * This briefly lived at `/liquidity`, because `/strategy` was a PERMANENT (301)
 * redirect to `/trade` — the terminal's former name. That redirect is now
 * removed and the page owns `/strategy`, which is what the product is called.
 *
 * The residual risk is real but small and bounded: browsers cache 301s, so
 * anyone who visited `/strategy` before 2026-10-20 keeps landing on `/trade`
 * until their cache expires, and nothing we ship can clear it. That population
 * is whoever hit a path that existed only as an internal rename, so it is
 * close to empty — and the destination they reach is a working page, not an
 * error.
 *
 * Components live under `src/components/strategy/pools/`, beside the terminal's
 * `src/components/strategy/perps/`, mirroring the docs tree. Until 2026-10-27
 * they sat in `src/components/liquidity/` while `strategy/` held the TERMINAL —
 * so `StrategySplash.tsx` lived in `liquidity/` and `TradeSplash.tsx` in
 * `strategy/`, each named for the page the other directory served.
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
  () => import("@/components/strategy/pools/LiquidityView").then((m) => m.LiquidityView),
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

/**
 * Server-rendered, because the Magnet Token tab's figures are.
 *
 * `LiquidityView` is `ssr: false` and cannot await anything, so price, holder
 * count and $U TVL are fetched HERE and the finished view is handed down as a
 * node. These three reads used to live in `app/tokens/page.tsx`, which is where
 * the Magnet Token view lived until 2026-11-04.
 *
 * The cost is honest and worth naming: all three run on every request to
 * /strategy, including from someone who only ever looks at the vaults. They are
 * the same three reads /tokens made unconditionally before the move, so this is
 * the cost moving with the content rather than a new one — and `fetchTVL` and
 * `fetchHolderCount` each swallow their own failures and return a dash, so a
 * dead indexer degrades this page's third tab instead of 500-ing the route.
 */
export default async function LiquidityPage() {
  const [holders, price, tvl, ytd] = await Promise.all([
    fetchHolderCount(MAGNET_ASA_ID),
    fetchMagnetPriceUSDC(),
    fetchTVL(),
    fetchMagnetYtd(),
  ]);

  return <LiquidityView
    magnetView={<MagnetTokenView holders={holders} price={price} tvl={tvl} ytd={ytd} />}
  />;
}
