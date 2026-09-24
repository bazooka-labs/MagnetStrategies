"use client";

// Live market state for the Perps card.
//
// Everything here is read from chain or from PEX's published oracle artifacts —
// no backend of ours, and no cached risk parameters. PEX's parameters are
// admin-mutable and move without notice: the OI cap went from $960 to $1,500 in
// a day, and short-side open interest drained 13x inside 24 hours. A figure
// cached for even a minute can render a bar the chain will reject.

import { useCallback, useEffect, useRef, useState } from "react";
import algosdk from "algosdk";
import { ALGOD_URLS } from "@/lib/constants";
import { ORACLE_MAX_AGE_SEC, PEX_APPS } from "@/lib/perps";
import { readMarketState, type MarketState } from "@/lib/perpsReads";
import { getOraclePayload, type OraclePayload } from "@/lib/perpsOracle";

export type PerpsMarketData = {
  state: MarketState;
  oracle: OraclePayload;
  /** When this snapshot was taken, for staleness display. */
  readAt: number;
};

export type PerpsMarketStatus = {
  data: PerpsMarketData | null;
  loading: boolean;
  /** User-facing reason the market cannot be traded right now. */
  error: string | null;
  refresh: () => void;
};

/**
 * Oracle payloads expire. PEX signs a 30-second window and we hold ourselves to
 * 20, so the refresh has to beat that or the card shows a price it can no longer
 * trade on. Half the budget leaves room for a slow round trip.
 */
const REFRESH_MS = (ORACLE_MAX_AGE_SEC / 2) * 1000;

export function usePerpsMarket(marketId: number): PerpsMarketStatus {
  const [data, setData] = useState<PerpsMarketData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    alive.current = true;
    // Clear on market switch so the card never shows ALGO's numbers under BTC's
    // label while the new read is in flight.
    setData(null);
    setLoading(true);
    setError(null);

    const algod = new algosdk.Algodv2("", ALGOD_URLS.mainnet, "");

    const load = async () => {
      try {
        const [state, oracle] = await Promise.all([
          readMarketState(algod, marketId),
          getOraclePayload(PEX_APPS.trading, marketId),
        ]);
        if (!alive.current) return;
        setData({ state, oracle, readAt: Date.now() });
        setError(null);
      } catch (e) {
        if (!alive.current) return;
        // Keep the previous snapshot on screen rather than blanking the card —
        // but the error is surfaced, and the caller must not allow a trade while
        // it is set.
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive.current) setLoading(false);
      }
    };

    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => {
      alive.current = false;
      clearInterval(id);
    };
  }, [marketId, tick]);

  return { data, loading, error, refresh };
}

/** Seconds since the oracle payload was signed, for the staleness indicator. */
export function oracleAgeSeconds(d: PerpsMarketData | null): number | null {
  if (!d) return null;
  return Math.floor((Date.now() - Number(d.oracle.decoded.publishedAt) * 1000) / 1000);
}
