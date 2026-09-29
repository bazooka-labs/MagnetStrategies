"use client";

// Every order the connected wallet has resting on PEX.
//
// ── Read-only, and not the same thing as a position ─────────────────────────
// An order lives in an `o2:` box on OrderOps and has no `p2:` position behind
// it until a keeper executes it. `usePerpsPositions` reads the four position
// keys directly; orders cannot be read that way because the id is chosen by the
// submitter, so the boxes are listed by owner prefix instead.
//
// ── Why a keeper matters, and that it demonstrably runs ─────────────────────
// A resting order does nothing until `execute_order` is called for it, which is
// a paid permissionless call nobody is obliged to make. Verified on MainNet
// 2026-09-28: `execute_order` has been called 376 times this month by a single
// keeper, most recently hours before our own first trade, and the inner
// transactions of those calls show collateral moving in and position boxes
// being created — so they are real executions of limit orders, not the orphan
// cleanups the earlier notes in AUDIT.md worried they might all be.
//
// ── The lifecycle mapping is the SDK's, not ours ────────────────────────────
// `analyzeV2OrderLifecycle` decides what an order can do. Two traps in calling
// it, both live:
//
//   1. It does `{ ...marketSnapshot, ...order }`, so ORDER FIELDS WIN. An order
//      field named like a snapshot field would shadow the live price and
//      evaluate crossing against prices frozen at placement. Checked against
//      the decoded `OrderState`: no field of ours collides with
//      `index_price_min` / `index_price_max` / `index_price`.
//   2. It matches an order to its position through `owner:market:asset:side`,
//      reading `owner` off the POSITION object — which is not in the position
//      box value. Omit it and every healthy take-profit returns
//      `position_missing`, which SPEC.md requires be displayed as "Orphaned —
//      funds still locked". `PositionState` now carries `owner` for exactly
//      this reason; see the field's own note.

import { useCallback, useEffect, useRef, useState } from "react";
import algosdk from "algosdk";
import { analyzeV2OrderLifecycle } from "@pdex/sdk";
import { ALGOD_URLS } from "@/lib/constants";
import { COLLATERAL_ASSET_ID, ENABLED_MARKET_IDS, PEX_APPS } from "@/lib/perps";
import { readOrders, readPosition, type OrderState, type PositionState } from "@/lib/perpsReads";
import { getOraclePayload } from "@/lib/perpsOracle";

export type RestingOrder = {
  order: OrderState;
  /**
   * PEX's own blockers, verbatim. Mapped to words at the render site rather
   * than here, because SPEC.md pins the mapping and `executable` must never be
   * shown raw: `not_crossed` sets it false for every correctly-placed order
   * that is simply waiting for the price, i.e. all of them, all the time.
   */
  blockers: string[];
  /** Non-empty when PEX considers the order eligible for paid cleanup. */
  cleanupReason: string;
  /** The live index the crossing decision was made against, for display. */
  indexUsd: number | null;
};

export type OrdersStatus = {
  orders: RestingOrder[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

/** Matches the positions hook: a status view, not something being signed. */
const REFRESH_MS = 30_000;

export function usePerpsOrders(owner: string | null): OrdersStatus {
  const [orders, setOrders] = useState<RestingOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  /** Whose orders are on screen, so a refresh does not blank the list. */
  const shownFor = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;

    // Clear on an OWNER change only — the same rule and the same reason as
    // `usePerpsPositions`: account A's orders must not sit under account B's
    // wallet, and the manual refresh must not blank the list to do it.
    if (shownFor.current !== owner) {
      shownFor.current = owner;
      setOrders([]);
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
        const found = await readOrders(algod, owner);

        // The analyzer needs every position the account holds, not just the one
        // an order points at: it resolves the order's key against the whole set.
        const positions: PositionState[] = [];
        await Promise.all(ENABLED_MARKET_IDS.flatMap((marketId) =>
          ([1, 2] as const).map(async (side) => {
            const p = await readPosition(algod, owner, marketId, COLLATERAL_ASSET_ID, side);
            if (p) positions.push(p);
          })));

        // One oracle read per market that actually has an order, not per order.
        const marketIds = [...new Set(found.map((o) => Number(o.market_id)))];
        const snapshots = new Map<number, { min: bigint; max: bigint } | null>();
        await Promise.all(marketIds.map(async (m) => {
          try {
            const o = await getOraclePayload(PEX_APPS.trading, m);
            // The SIGNED min/max off `decoded`, not the derived mid: crossing is
            // evaluated against the band PEX itself signed, and `indexPrice12`
            // is our own average of the two.
            //
            // An unverified signature yields no snapshot, for the same reason
            // the chart refuses to draw one: if the card would not trade on this
            // price, it must not decide here whether an order is ready either.
            snapshots.set(m, o.signatureVerified
              ? { min: o.decoded.indexMinPrice, max: o.decoded.indexMaxPrice }
              : null);
          } catch {
            // No snapshot means crossing cannot be evaluated. Recorded as null
            // and surfaced as "can't tell" rather than defaulted to either
            // answer — "ready to execute" and "waiting" are both claims.
            snapshots.set(m, null);
          }
        }));

        const out: RestingOrder[] = found.map((order) => {
          const snap = snapshots.get(Number(order.market_id)) ?? null;
          try {
            const a = analyzeV2OrderLifecycle(
              order as never, positions as never, found as never,
              (snap ? { index_price_min: snap.min, index_price_max: snap.max } : undefined) as never,
            ) as { executionBlockers?: string[]; cleanupReason?: string };
            return {
              order,
              blockers: (a.executionBlockers ?? []).slice(),
              cleanupReason: String(a.cleanupReason ?? ""),
              indexUsd: snap ? Number(snap.min) / 1e12 : null,
            };
          } catch {
            // An order we cannot analyse is still an order holding the user's
            // escrow. Shown with an explicit unknown state rather than dropped.
            return {
              order, blockers: ["unknown_order_state"], cleanupReason: "",
              indexUsd: snap ? Number(snap.min) / 1e12 : null,
            };
          }
        });

        if (!alive) return;
        setOrders(out);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    };

    load();
    const id = setInterval(load, REFRESH_MS);
    return () => { alive = false; clearInterval(id); };
  }, [owner, tick]);

  return { orders, loading, error, refresh };
}
