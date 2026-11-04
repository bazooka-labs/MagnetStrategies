"use client";

// Every open position the connected wallet holds, with a live close quote.
//
// ── Why this enumerates keys rather than listing boxes ──────────────────
// PEX keys positions by `(marketId, collateralAssetId, side, owner)`, so the
// key space for one wallet is small and known: two markets × two collaterals
// × two sides, eight reads, all of which 404 cheaply when there is nothing
// there. Enumerating `p2:` boxes by prefix would return every trader on the
// exchange and force us to filter client-side, which is both slower and a
// privacy smell.
//
// It was four reads while only USDC collateral was looked at. That restriction
// described OUR UI, never PEX — an ALGO-collateral position opened on PEX's
// own front end is a real position in a real box, and reading one collateral
// meant its holder saw NOTHING of it here.
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
  ENABLED_MARKET_IDS,
  PEX_APPS,
  POSITION_BUILDER_FEE_BPS,
  POSITION_COLLATERAL_ASSETS,
} from "@/lib/strategy/pex/config";
import {
  readMarketFunding,
  readMarketState,
  readPosition,
  type PositionState,
} from "@/lib/strategy/pex/reads";
import { getOraclePayload } from "@/lib/strategy/pex/oracle";
import { quoteClose, quoteLiquidationPrice, type CloseQuote } from "@/lib/strategy/pex/quote";

export type OpenPosition = {
  marketId: number;
  side: "long" | "short";
  /**
   * Which asset backs this position.
   *
   * Part of the position's IDENTITY, not a label: the box key is
   * `p2: ‖ marketId ‖ collateralAssetId ‖ side ‖ owner`, so the same wallet
   * can hold a USDC-collateral long and an ALGO-collateral long in one market
   * and they are different positions with different liquidation prices.
   */
  collateralAssetId: number;
  position: PositionState;
  /** Live full-close quote, or null when it could not be priced. */
  close: CloseQuote | null;
  /** Why the quote is missing, for the "couldn't price this" line. */
  quoteError: string | null;
  /**
   * ALGO/USD at the time of this read, Price12 — null if it could not be had.
   *
   * Carried on the position because `collateral_amount` is denominated in the
   * COLLATERAL ASSET, so anything wanting a dollar figure needs this to get
   * one. Without it the panel divided µALGO by 1e6 and printed the result
   * with a dollar sign.
   *
   * Null is a real state, not a default. When it is null the dollar figures
   * are SUPPRESSED rather than computed from a guess — the same rule
   * `payoutUsd` follows.
   */
  algoPrice12: bigint | null;
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
 * Four box reads plus a market read and an oracle fetch per market is a lot to
 * repeat every ten seconds for a status view.
 *
 * ⚠️ This comment used to claim "nothing here is used to build a transaction —
 * the close preview is re-quoted fresh at the moment it matters". That is
 * FALSE and was false when written. PositionsPanel passes this hook's cached
 * `p.close` quote straight into `closePosition`, where it becomes the slippage
 * anchor (`perpsClient.ts:1712`) and the yield-recall caps (`:1688`).
 * `quoteClose` is never called anywhere in `perpsClient.ts`.
 *
 * So a quote up to REFRESH_MS old does reach a signed transaction. The damage
 * is bounded — the acceptable price is a floor, not the fill, so a stale
 * anchor produces either a rejected close or a correct fill under a looser
 * floor than the user believes — but "nobody is about to sign this" is the one
 * thing it is not. The open path closed this circularity with explicit
 * display-drift limits; the close path has no equivalent yet.
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
        /**
         * ── Both collaterals, not just USDC ──
         * PEX keys positions by collateral asset, so a wallet can hold four
         * per market. Reading only `COLLATERAL_ASSET_ID` meant an
         * ALGO-collateral position — openable on PEX's own UI today, and
         * 210.87 ALGO is posted on market 1 — was invisible here. A position
         * we do not show is one the holder cannot close from our terminal.
         *
         * Four box reads per market instead of two. They are cheap and run in
         * parallel; the market state and oracle below are still fetched only
         * when something is actually open.
         */
        for (const marketId of ENABLED_MARKET_IDS) {
          for (const collateralAssetId of POSITION_COLLATERAL_ASSETS) {
            // Both sides first: if neither exists, the market's state and oracle
            // are never fetched at all.
            const [long, short] = await Promise.all([
              readPosition(algod, owner, marketId, collateralAssetId, 1),
              readPosition(algod, owner, marketId, collateralAssetId, 2),
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
                  collateralAssetId,
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
                collateralAssetId,
              });
              found.push({
                marketId, side, collateralAssetId, position: p!, close, quoteError,
                algoPrice12,
                liquidationPrice12: liq?.price12 ?? null,
                liquidationDirection: liq?.direction ?? "",
                liquidatableNow: liq?.liquidatableNow ?? false,
                indexPrice12: oracle.indexPrice12,
              });
            }
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
