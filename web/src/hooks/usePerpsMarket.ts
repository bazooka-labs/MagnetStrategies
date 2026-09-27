"use client";

// Live market state for the Perps card.
//
// Everything here is read from chain or from PEX's published oracle artifacts —
// no backend of ours, and no cached risk parameters. PEX's parameters are
// admin-mutable and move without notice: the OI cap went from $960 to $1,500 in
// a day, and short-side open interest drained 13x inside 24 hours. A figure
// cached for even a minute can render a bar the chain will reject.

import { useCallback, useEffect, useState } from "react";
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
  /**
   * User-facing reason the market cannot be traded right now.
   *
   * **The caller must not allow a trade while this is set.** The previous
   * snapshot is deliberately kept on screen so the card does not blank, which
   * means every figure it shows may be stale.
   */
  error: string | null;
  refresh: () => void;
  /** Timestamp of the last load ATTEMPT, so a stale view keeps ageing visibly. */
  attemptAt: number;
};

/**
 * Oracle payloads expire. PEX publishes on a ~30-second cadence and we hold
 * ourselves to ORACLE_MAX_AGE_SEC (20), so the refresh has to beat OUR limit or
 * the card shows a price it will refuse to trade on. Half the budget leaves
 * room for a slow round trip.
 */
const REFRESH_MS = (ORACLE_MAX_AGE_SEC / 2) * 1000;

export function usePerpsMarket(marketId: number): PerpsMarketStatus {
  const [data, setData] = useState<PerpsMarketData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  /**
   * Bumped on every load attempt, successful or not.
   *
   * Without it the staleness indicator freezes: `setError` with an identical
   * message is a no-op, so a repeatedly-failing refresh — "Failed to fetch" from
   * a dropped connection, the common case — triggers no re-render, and the
   * "price signed Ns ago" line stops ageing while the data keeps getting older.
   */
  const [attemptAt, setAttemptAt] = useState(() => Date.now());

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    /**
     * Per-effect, NOT a ref.
     *
     * A ref is one object for the component's whole life. React runs the old
     * effect's cleanup (setting it false) and then the new effect's setup
     * (setting it true) before any in-flight promise resolves — so a stale
     * closure reads `true` and its result lands anyway. That is exactly how a
     * slow ALGO response ended up rendering under a BTC label, and it stuck
     * until the next refresh because whichever read finished LAST won.
     *
     * A local captured per effect run cannot be revived by a later run.
     */
    let alive = true;

    // Clear on market switch so the card never shows one market's numbers under
    // the other's label while the new read is in flight.
    setData(null);
    setLoading(true);
    setError(null);

    const algod = new algosdk.Algodv2("", ALGOD_URLS.mainnet, "");

    const load = async () => {
      setAttemptAt(Date.now());
      try {
        const [state, oracle] = await Promise.all([
          readMarketState(algod, marketId),
          getOraclePayload(PEX_APPS.trading, marketId),
        ]);
        if (!alive) return;
        // Belt and braces: both the box read and the signed payload carry the
        // market they belong to, so a mismatch is provable rather than assumed.
        // If the closure guard above ever fails again, this still refuses.
        if (Number(state.core.market_id) !== marketId
          || Number(oracle.decoded.marketId) !== marketId) {
          setError("Market data did not match the selected market.");
          return;
        }
        setData({ state, oracle, readAt: Date.now() });
        setError(null);
      } catch (e) {
        if (!alive) return;
        // Keep the previous snapshot on screen rather than blanking the card —
        // but the error is surfaced, and the caller must not allow a trade while
        // it is set.
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    };

    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [marketId, tick]);

  return { data, loading, error, refresh, attemptAt };
}

/** Seconds since the oracle payload was signed, for the staleness indicator. */
export function oracleAgeSeconds(d: PerpsMarketData | null): number | null {
  if (!d) return null;
  return Math.floor((Date.now() - Number(d.oracle.decoded.publishedAt) * 1000) / 1000);
}
