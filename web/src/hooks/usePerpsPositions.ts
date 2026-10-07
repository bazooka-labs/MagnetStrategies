"use client";

// Every open position the connected wallet holds, with a live close quote.
//
// ── Why this reads all four keys rather than listing boxes ──────────────────
// PEX keys positions by `(marketId, collateralAssetId, side, owner)`, so a
// wallet has at most one per market and side — four reads across two markets,
// all of which 404 cheaply when there is nothing there. Enumerating `p2:` boxes
// by prefix would return every trader on the exchange and force us to filter
// client-side, which is both slower and a privacy smell.
//
// ── What a quote failure means here ─────────────────────────────────────────
// A position that cannot be quoted is still a position the user holds. It is
// shown with its size and entry price and an explicit "couldn't price this"
// rather than hidden, because hiding it would tell someone with money at risk
// that they have nothing.

import { useCallback, useEffect, useRef, useState } from "react";
import algosdk from "algosdk";
import { ALGOD_URLS } from "@/lib/constants";
import {
  BUILDER_ADDRESS,
  COLLATERAL_ASSET_ID,
  ENABLED_MARKET_IDS,
  PEX_APPS,
  POSITION_BUILDER_FEE_BPS,
} from "@/lib/perps";
import {
  readMarketFunding,
  readMarketState,
  readPosition,
  type PositionState,
} from "@/lib/perpsReads";
import { getOraclePayload } from "@/lib/perpsOracle";
import { quoteClose, quoteLiquidationPrice, type CloseQuote } from "@/lib/perpsQuote";

export type OpenPosition = {
  marketId: number;
  side: "long" | "short";
  position: PositionState;
  /** Live full-close quote, or null when it could not be priced. */
  close: CloseQuote | null;
  /** Why the quote is missing, for the "couldn't price this" line. */
  quoteError: string | null;
  /**
   * Where PEX liquidates this position, and on which side of the price.
   *
   * Null when the SDK declines to answer. Carried here rather than derived by
   * whoever draws it: the chart used to take its liquidation line from the
   * CARD's prospective quote — the order being composed, not the position held
   * — so with an empty form the line vanished, which is why these markings
   * disappeared on every refresh.
   */
  liquidationPrice12: bigint | null;
  /** `at_or_below` for a long, `at_or_above` for a short — checked before drawing. */
  liquidationDirection: string;
  /**
   * PEX says this position can be liquidated RIGHT NOW.
   *
   * When set, `liquidationPrice12` is not a boundary ahead of the price: it is
   * the far edge of the region the position is already inside. Nothing may draw
   * it as a level to watch.
   */
  liquidatableNow: boolean;
  /**
   * The index this position was last priced against.
   *
   * Carried so the panel can state the DISTANCE to liquidation without reading
   * the oracle a second time — the price a position is marked against has one
   * owner, and two reads on two timers disagree.
   */
  indexPrice12: bigint;
};

export type PositionsStatus = {
  positions: OpenPosition[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

/**
 * Slower than the card's ten seconds, deliberately.
 *
 * Nothing here is used to build a transaction — it is a status view, and the
 * close preview is re-quoted fresh at the moment it matters. Four box reads plus
 * a market read and an oracle fetch per market is a lot to repeat every ten
 * seconds for a number nobody is about to sign.
 */
const REFRESH_MS = 30_000;

export function usePerpsPositions(owner: string | null): PositionsStatus {
  const [positions, setPositions] = useState<OpenPosition[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  /** Whose positions are currently on screen. See the effect. */
  const shownFor = useRef<string | null>(null);

  useEffect(() => {
    // Per-effect, not a ref — see the note in usePerpsMarket. A wallet switch
    // must not let the previous account's positions land under the new one.
    let alive = true;

    // Clear on an OWNER change, exactly as usePerpsMarket does and for the
    // reason it documents: on A → B, if B's load threw, account A's positions
    // stayed on screen under account B's wallet behind a banner that reads as a
    // load failure rather than as a wrong-account display.
    //
    // Keyed on the owner rather than on every effect run, because `tick` is also
    // a dependency — the Refresh button bumps it, and clearing unconditionally
    // made that button drop the rows and show the skeleton until the reload
    // returned. The 30-second interval calls `load()` directly and never had
    // this problem, which is why the two paths now behave the same.
    if (shownFor.current !== owner) {
      shownFor.current = owner;
      setPositions([]);
      setError(null);
    }

    if (!owner) {
      setLoading(false);
      return;
    }

    setLoading(true);
    const algod = new algosdk.Algodv2("", ALGOD_URLS.mainnet, "");

    const load = async () => {
      try {
        const found: OpenPosition[] = [];
        /**
         * ALGO's price, read once, from market 1's signed payload.
         *
         * A BTC/USD close pays out in ALGO and USDC, but market 2's
         * `index_asset_id` is the synthetic `9000000000000000` — so ALGO matched
         * no pricing branch and every BTC position showed no payout, no net
         * figure and no cost breakdown. Audit 8 MEDIUM 7.
         *
         * Read outside the market loop because it is the same number for both,
         * and tolerated as null: without it `valueCloseOutputs` falls back to
         * withholding the total, which is the behaviour being replaced rather
         * than a new failure.
         */
        let algoPrice12: bigint | null = null;
        try {
          algoPrice12 = (await getOraclePayload(PEX_APPS.trading, 1)).indexPrice12;
        } catch { /* a BTC payout stays unpriced, exactly as before */ }
        for (const marketId of ENABLED_MARKET_IDS) {
          // Both sides first: if neither exists, the market's state and oracle
          // are never fetched at all.
          const [long, short] = await Promise.all([
            readPosition(algod, owner, marketId, COLLATERAL_ASSET_ID, 1),
            readPosition(algod, owner, marketId, COLLATERAL_ASSET_ID, 2),
          ]);
          const live = ([[1, long], [2, short]] as const)
            .filter(([, p]) => p && p.size_usd > BigInt(0));
          if (live.length === 0) continue;

          const [state, funding, oracle] = await Promise.all([
            readMarketState(algod, marketId),
            readMarketFunding(algod, marketId),
            getOraclePayload(PEX_APPS.trading, marketId),
          ]);

          for (const [sideCode, p] of live) {
            const side = sideCode === 1 ? "long" as const : "short" as const;
            let close: CloseQuote | null = null;
            let quoteError: string | null = null;
            try {
              close = quoteClose({
                state, funding, oracle, side, owner,
                position: p as unknown as Record<string, bigint>,
                sizeUsdMicro: p!.size_usd,
                collateralAssetId: COLLATERAL_ASSET_ID,
                builderAddress: BUILDER_ADDRESS,
                builderFeeBps: POSITION_BUILDER_FEE_BPS,
                ...(algoPrice12 !== null ? { algoPrice12 } : {}),
              });
            } catch (e) {
              // A position that cannot be priced is still a position. Show it.
              quoteError = e instanceof Error ? e.message : String(e);
            }
            // Pure computation over state already fetched — no extra round trip.
            const liq = quoteLiquidationPrice({
              state, funding, oracle, side,
              position: p as unknown as Record<string, bigint>,
              collateralAssetId: COLLATERAL_ASSET_ID,
            });
            found.push({
              marketId, side, position: p!, close, quoteError,
              liquidationPrice12: liq?.price12 ?? null,
              liquidationDirection: liq?.direction ?? "",
              liquidatableNow: liq?.liquidatableNow ?? false,
              indexPrice12: oracle.indexPrice12,
            });
          }
        }
        if (!alive) return;
        setPositions(found);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    };

    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => { alive = false; clearInterval(id); };
  }, [owner, tick]);

  return { positions, loading, error, refresh };
}
