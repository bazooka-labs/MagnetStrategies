"use client";

/**
 * The fifth box in the metric row: what the Magnet treasury holds.
 *
 * ── Why it is a component and not a `StatCell` ─────────────────────────────
 * It carries a link to the account on allo.info, which `StatCell`'s plain
 * `sub` string cannot hold. `TvlRankStat` is here for the same reason — it owns
 * a popover — and both take their colour from `STAT_TONES` rather than naming a
 * class, or the row drifts the first time one of them is touched.
 *
 * ── Why it reads its own chain data ────────────────────────────────────────
 * It builds its own algod client rather than taking the wallet's. The treasury
 * is a fact about the project, not about the viewer, so it has to render for a
 * visitor who has never connected anything — which is precisely the reader this
 * box is on the page for.
 *
 * ── What the number is, and what it is not ─────────────────────────────────
 * USDC only. The account also holds ALGO, and the vote page this came from has
 * always described the figure as "USDC available for liquidity" — that is what
 * governance votes allocate. Quietly widening it to a total portfolio value
 * while keeping the same label would make a bigger number by changing the
 * question, so the sub-label says which number it is.
 */

import { useCallback, useEffect, useState } from "react";
import algosdk from "algosdk";
import { ExternalLink } from "lucide-react";
import { ALGOD_URLS } from "@/lib/constants";
import { TREASURY_ADDRESS, formatUsdc } from "@/lib/uvote";
import { getTreasuryUsdc } from "@/lib/uvoteReads";
import { STAT_TONES } from "@/components/tokens/StatCell";

export function TreasuryStat() {
  const [usdc, setUsdc] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const algod = new algosdk.Algodv2("", ALGOD_URLS.mainnet, "");
      setUsdc(await getTreasuryUsdc(algod));
    } catch {
      // Leave the previous figure standing rather than replacing it with a
      // zero: a treasury reading $0.00 because a node timed out is a worse
      // statement than one that has not refreshed.
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Refetch when the tab regains focus, matching TvlRankStat — a page left open
  // overnight should not keep showing yesterday's balance.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [load]);

  return (
    <div className="p-5">
      <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Treasury</p>
      <p className={`mt-2 font-mono text-2xl font-bold ${STAT_TONES.green}`}>
        {usdc === null ? "…" : `$${formatUsdc(usdc)}`}
      </p>
      <a
        href={`https://allo.info/account/${TREASURY_ADDRESS}`}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-0.5 inline-flex items-center gap-1 text-xs text-gray-500 transition-colors hover:text-gray-300"
      >
        USDC for liquidity
        <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}
