"use client";

/**
 * What the Magnet treasury holds, shown inside "How voting works".
 *
 * ── Where it sits, and why it moved there on 2026-11-08 ────────────────────
 * It was the fifth box in the mUSD metric row, and before that a panel beside
 * this same explanation. It is back in the explanation, as the left half of a
 * pair with your own vote power.
 *
 * The round trip is not indecision. In the metric row it sat among figures
 * about the token — peg, holders, supply, backing — and it is not one: it is
 * the balance proposals direct. Beside the voting rules it answers the
 * question a reader of that panel actually has, which is what a vote is
 * about, and it is the figure that gives "your vote power" something to be a
 * share of. What was wrong the first time was the panel it sat in, not the
 * page.
 *
 * It is NOT in both places. Governance and the metric row are two pills of
 * one page, so two copies would invite a reader to ask which is current —
 * the reason it left this panel originally, and `tokensGovernance.test.ts`
 * pins the single copy from both ends.
 *
 * ── Why it is a component and not a `StatCell` ─────────────────────────────
 * It carries a link to the account on allo.info, which `StatCell`'s plain
 * `sub` string cannot hold. `TvlRankStat` is here for the same reason — it owns
 * a popover. Its frame comes from `GovFigure`, shared with the vote-power box
 * beside it so the pair cannot drift apart.
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
import { TREASURY_ADDRESS, formatUsdc } from "@/lib/governance";
import { getTreasuryUsdc } from "@/lib/governanceReads";
import { GovFigure } from "@/components/tokens/GovFigure";

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
  // overnight should not keep showing yesterday's balance. It matters more
  // here than it did in the metric row: this figure now sits beside an open
  // proposal, and a stale balance is a stale premise for a vote.
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
    <GovFigure
      label="Treasury"
      value={usdc === null ? "…" : `$${formatUsdc(usdc)}`}
      tone="green"
      sub={
        <a
          href={`https://allo.info/account/${TREASURY_ADDRESS}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 transition-colors hover:text-gray-300"
        >
          USDC for liquidity
          <ExternalLink className="h-3 w-3" />
        </a>
      }
    />
  );
}
