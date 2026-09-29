"use client";

// What the user currently holds.
//
// Read-only by design, for now. The close WRITE path is not built: closing may
// require a yield recall depending on pool state, and the SDK's supported way to
// compute that needs Ultrade's backend, which we do not run. Until that is
// answered, showing a "Close" button we cannot honour would be worse than
// showing none — see strategy/perps/CLOSE-QUOTE-QUESTION-FOR-ULTRADE.md.
//
// Every figure here is a live quote against current state, not the numbers that
// were on screen when the position was opened.

import { AlertCircle, TrendingDown, TrendingUp } from "lucide-react";
import { COLLATERAL_ASSET_ID, PEX_MARKETS } from "@/lib/perps";
import { ORDER_KIND } from "@/lib/perpsReads";
import { usePerpsPositions } from "@/hooks/usePerpsPositions";
import { usePerpsOrders } from "@/hooks/usePerpsOrders";
import { Seam } from "./Seam";
import { useWallet } from "@/hooks/useWallet";

const fmtUsd = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtSigned = (n: number) =>
  `${n >= 0 ? "+" : "−"}${fmtUsd(Math.abs(n))}`;
const price12ToUsd = (p: bigint) => Number(p) / 1e12;
const fmtPrice = (p: number) =>
  p >= 1000 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
  : p >= 1 ? `$${p.toFixed(2)}` : `$${p.toFixed(6)}`;

/**
 * Asset names for the payout breakdown.
 *
 * Only the ones a pair market actually pays out in. An unknown id is shown as
 * its number rather than guessed at — the same reason `payoutUsd` goes null
 * when it cannot value every leg.
 */
const assetName = (id: number) =>
  id === COLLATERAL_ASSET_ID ? "USDC" : id === 0 ? "ALGO" : `asset ${id}`;

const marketLabel = (id: number) =>
  Object.values(PEX_MARKETS).find((m) => m.id === id)?.label ?? `Market ${id}`;

/**
 * PEX's blockers, in words. **The mapping is pinned by SPEC.md, not chosen here.**
 *
 * `executable` must never be shown raw. `analyzeV2OrderLifecycle` pushes
 * `not_crossed` and sets `executable = false` for every correctly-placed order
 * that is simply waiting for its price — which is all of them, all of the time
 * — so rendering the flag literally would read "unexecutable" on every healthy
 * order on the exchange. All four live orders today report exactly that.
 *
 * Order matters: the first match wins, so the states that mean "your money is
 * stuck" outrank the ones that mean "waiting".
 */
const ORDER_STATE: { blocker: string; label: string; tone: string; note: string }[] = [
  { blocker: "position_missing", label: "Orphaned", tone: "text-red-300 bg-red-500/15",
    note: "The position this order pointed at is gone, so it can never execute — but its escrow is still locked. Clearing it is a paid, permissionless call nobody is obliged to make." },
  { blocker: "position_replaced", label: "Orphaned", tone: "text-red-300 bg-red-500/15",
    note: "Bound to a position that has since been replaced. It will not execute, and its escrow stays locked until someone clears it." },
  { blocker: "unknown_position_state", label: "State unknown", tone: "text-amber-300 bg-amber-500/15",
    note: "We could not establish what this order is bound to. Treat its protection as unconfirmed." },
  { blocker: "unknown_order_state", label: "State unknown", tone: "text-amber-300 bg-amber-500/15",
    note: "We could not read this order's lifecycle. It is shown because it still holds your escrow." },
  { blocker: "order_expired", label: "Expired", tone: "text-white/50 bg-white/10",
    note: "Past its expiry. It will not execute; its escrow is released when it is cleared." },
  { blocker: "bad_order_price", label: "Dead", tone: "text-red-300 bg-red-500/15",
    note: "PEX rejects this order's price, so it cannot execute." },
  { blocker: "reduce_size_exceeds_position", label: "Stale", tone: "text-amber-300 bg-amber-500/15",
    note: "Larger than the position it closes. It re-arms at the same trigger if the position grows back." },
  { blocker: "position_too_small", label: "Stale", tone: "text-amber-300 bg-amber-500/15",
    note: "The position is now too small for this order to act on." },
  { blocker: "parent_pending", label: "Waiting on entry", tone: "text-white/60 bg-white/10",
    note: "Attached to an entry order that has not executed yet. It arms once the entry fills." },
  // Last, because it is the HEALTHY state and any of the above outranks it.
  { blocker: "not_crossed", label: "Armed", tone: "text-green-300 bg-green-500/15",
    note: "Placed and waiting for the price to reach its trigger." },
];

const ORDER_KIND_LABEL: Record<number, string> = {
  1: "Limit entry", 2: "Take profit", 3: "Stop loss",
};

export function PositionsPanel() {
  const wallet = useWallet();
  const who = wallet.isConnected ? wallet.address : null;
  const { positions, loading, error, refresh } = usePerpsPositions(who);
  const { orders, loading: ordersLoading, error: ordersError, refresh: refreshOrders } =
    usePerpsOrders(who);

  if (!wallet.isConnected) return null;

  // The seam lives HERE rather than in PerpsView, so it disappears with the
  // section it separates: this component returns null with no wallet connected,
  // and a rule under nothing is a card that looks broken.
  return (
    <div>
      <Seam />

      {/* A hair lighter than the card above it: enough to separate holdings
          from the order form at a glance, not enough to look like a new panel. */}
      <div className="bg-white/[0.015] p-5 sm:p-6">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-lg font-semibold text-white">Your positions</h2>
        <button onClick={() => { refresh(); refreshOrders(); }} disabled={loading || ordersLoading}
          className="text-xs text-white/40 underline underline-offset-2 hover:text-white/70 disabled:opacity-40">
          {loading || ordersLoading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>Could not load your positions. ({error})</span>
        </div>
      )}

      {!error && !loading && positions.length === 0 && (
        <p className="mt-3 text-sm text-white/45">
          {/* A resting limit entry is not a position, and saying "nothing here"
              over one would read as though it had vanished. */}
          {orders.length > 0
            ? "You have no open positions yet — your resting orders are below."
            : "You have no open positions. Anything you open will appear here."}
        </p>
      )}

      {loading && positions.length === 0 && (
        <div className="mt-3 h-20 animate-pulse rounded-xl border border-white/10 bg-white/[0.02]" />
      )}

      <div className="mt-3 space-y-3">
        {positions.map((p) => {
          const up = p.side === "long";
          const sizeUsd = Number(p.position.size_usd) / 1e6;
          const collateralUsd = Number(p.position.collateral_amount) / 1e6;
          const entry = price12ToUsd(p.position.entry_price);
          /**
           * What the position returns, against the collateral currently backing it.
           *
           * NOT `close.pnlUsd`. That is `effective_profit_usd − loss_usd` —
           * price movement only — and the quote also carries a close fee, our
           * builder fee, funding, borrowing and **exit price impact**, none of
           * which were rendered anywhere. Audit 7 measured all seven live
           * MainNet positions: every row was wrong and two showed GREEN on a
           * position returning less than its collateral.
           *
           * `payoutUsd` is the aggregated per-asset total and is the number the
           * chain honours. It stays null whenever any leg is unpriceable, for
           * the same reason `payoutUsd` does — a half-priced net figure is the
           * defect again.
           *
           * ── What this is NOT, stated precisely ──────────────────────────
           * An earlier version of this comment said "against what went into
           * it", and review established that is false. `collateral_amount` is
           * collateral AFTER the open fee and the builder fee were taken:
           * verified exactly against the one real trade, where `quoteOpen`
           * returned `netCollateralUsd = 5.858426` for a $6 stake and the
           * on-chain `collateral_amount` is 5.858426. The gap is
           * `openFee 0.053090 + builderFee 0.088484`, plus the $0.10 keeper fee
           * that also left the wallet — $0.241574 of a $6 stake, 4%.
           *
           * So a round trip is worse than this figure by entry costs, and there
           * is a window (up to ~$0.24 on a $6 stake, ~$0.38 on $50+) where this
           * reads green on a trade that lost money overall.
           *
           * It is still the right basis, because the original stake is NOT
           * knowable from chain state — `p2:` carries only post-fee collateral,
           * and recovering the deposit needs indexer history the read path does
           * not have. The fix is therefore to SAY what the basis is, which the
           * label and the note beneath it now do, rather than to imply a
           * round-trip figure we cannot compute.
           */
          const netUsd = p.close?.payoutUsd != null ? p.close.payoutUsd - collateralUsd : null;
          /** Price movement alone. Not wrong, and not the same thing. */
          const priceMove = p.close?.pnlUsd ?? null;
          const leverage = collateralUsd > 0 ? sizeUsd / collateralUsd : 0;

          return (
            <div key={`${p.marketId}-${p.side}`}
              className="rounded-xl border border-white/10 bg-white/[0.02] p-3.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                    up ? "bg-green-500/15 text-green-300" : "bg-red-500/15 text-red-300"}`}>
                    {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                    {up ? "Long" : "Short"}
                  </span>
                  <span className="text-sm font-semibold text-white">{marketLabel(p.marketId)}</span>
                  <span className="text-[11px] text-white/35">{leverage.toFixed(2)}×</span>
                </div>
                {netUsd !== null && (
                  <span className="flex items-baseline gap-1.5">
                    {/* Labelled. An unlabelled coloured number lets the reader
                        supply their own definition, and the two available
                        definitions differ by exactly the amount at issue. */}
                    <span className="text-[10px] uppercase tracking-wide text-white/35">Net vs collateral</span>
                    <span className={`text-sm font-bold tabular-nums ${
                      netUsd >= 0 ? "text-green-300" : "text-red-300"}`}>
                      {fmtSigned(netUsd)}
                    </span>
                  </span>
                )}
              </div>

              <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-4">
                {([
                  ["Size", fmtUsd(sizeUsd)],
                  ["Collateral", fmtUsd(collateralUsd)],
                  ["Entry", fmtPrice(entry)],
                  ["If closed now", p.close
                    ? (p.close.payoutUsd !== null ? fmtUsd(p.close.payoutUsd) : "see below")
                    : "—"],
                  ["Price move", priceMove !== null ? fmtSigned(priceMove) : "—"],
                ] as const).map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-white/35">{k}</dt>
                    <dd className="tabular-nums text-white/80">{v}</dd>
                  </div>
                ))}
              </dl>

              {/* Why the net figure differs from the price move.

                  The headline gap is shown first and is exact by construction —
                  both ends are verified and this is defined as their
                  difference, so it cannot disagree with them.

                  The itemisation was pulled once, because it did not add up on
                  any of the five live longs. The cause was `fundingFeeUsd`:
                  PEX's `funding_fee_collateral_amount` is a GROSS accrued cost,
                  forced non-negative in `settledPosition`, so it reported a cost
                  on positions that had been CREDITED — inverting the largest
                  term's sign under a heading that said "costs".
                  `collateral_funding_net_amount` is the signed settlement, and
                  it matches `collateral_delta - collateral_amount` on 9 of 9
                  live positions. Hence `fundingNetUsd`, and hence the sign
                  rendered explicitly rather than assumed negative. */}
              {p.close && netUsd !== null && priceMove !== null && (
                <p className="mt-2 text-[11px] text-white/35">
                  Exit costs, net:{" "}
                  <span className="tabular-nums text-white/55">{fmtSigned(netUsd - priceMove)}</span>
                  {" "}— close fee {fmtUsd(p.close.closeFeeUsd)}, Magnet fee{" "}
                  {fmtUsd(p.close.builderFeeUsd)}, price impact{" "}
                  {p.close.impactUsd >= 0 ? "+" : "−"}{fmtUsd(Math.abs(p.close.impactUsd))},
                  {" "}funding {p.close.fundingNetUsd >= 0 ? "+" : "−"}
                  {fmtUsd(Math.abs(p.close.fundingNetUsd))}
                  {p.close.fundingNetUsd > 0 && " (paid to you)"}.
                </p>
              )}

              {/* A close is not a single-asset payout: on ALGO/USD a long gets
                  its collateral back in USDC and its profit in ALGO. One dollar
                  figure hid the second leg entirely, so the assets are listed. */}
              {p.close && p.close.outputs.length > 0 && (
                <p className="mt-2 text-[11px] text-white/45">
                  You receive{" "}
                  {p.close.outputs.map((o, i) => (
                    <span key={o.assetId}>
                      {i > 0 && <span className="text-white/25"> + </span>}
                      <span className="tabular-nums text-white/75">
                        {(Number(o.amount) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 })}
                      </span>{" "}
                      <span className="text-white/55">{assetName(o.assetId)}</span>
                    </span>
                  ))}
                </p>
              )}

              {/* A position that cannot be priced is still a position. Never hide it. */}
              {p.quoteError && (
                <p className="mt-2 text-[11px] text-amber-300/80">
                  Couldn&apos;t price this position right now — the size and entry above are read
                  straight from the chain and are accurate.
                </p>
              )}

              {p.close && !p.close.ok && p.close.blockedReason && (
                <p className="mt-2 text-[11px] text-amber-300/80">
                  PEX would not accept a close at this size right now: {p.close.blockedReason}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Resting orders ─────────────────────────────────────────────────
          A separate section because an order is not a position: it holds
          escrow, it has not traded, and until a keeper executes it nothing has
          happened. Rendered whenever there are any, including when there are no
          positions at all — a limit entry with no position yet is exactly the
          case where the user most needs to see something. */}
      {orders.length > 0 && (
        <div className="mt-5">
          <h3 className="text-xs font-medium uppercase tracking-wide text-white/45">
            Resting orders
          </h3>
          <div className="mt-2 space-y-2">
            {orders.map(({ order, blockers, cleanupReason, indexUsd }) => {
              // First match wins; the list is ordered so "your money is stuck"
              // outranks "waiting". No match at all means nothing is blocking
              // it, which is the moment before a keeper takes it.
              const state = ORDER_STATE.find((s) => blockers.includes(s.blocker))
                ?? { label: "Ready", tone: "text-green-300 bg-green-500/15",
                     note: "Its trigger has been reached. A keeper executes it; that is a paid, permissionless call, so it is not instant.", blocker: "" };
              const kind = ORDER_KIND_LABEL[Number(order.order_kind)] ?? `Kind ${order.order_kind}`;
              const isEntry = Number(order.order_kind) === ORDER_KIND.openLimit;
              const trigger = price12ToUsd(order.trigger_price);
              return (
                <div key={String(order.owner_order_id)}
                  className="rounded-xl border border-white/10 bg-white/[0.02] p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${state.tone}`}>
                        {state.label}
                      </span>
                      <span className="text-sm font-semibold text-white">{kind}</span>
                      <span className="text-[11px] text-white/45">
                        {marketLabel(Number(order.market_id))} ·{" "}
                        {order.side === BigInt(1) ? "long" : "short"}
                      </span>
                    </div>
                    <span className="text-sm font-bold tabular-nums text-white/80">
                      {fmtPrice(trigger)}
                    </span>
                  </div>

                  <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-4">
                    {([
                      [isEntry ? "Opens" : "Closes", fmtUsd(Number(order.size_usd_delta) / 1e6)],
                      // Only an entry escrows collateral; a reduce order draws
                      // from the position it closes, and reports zero here.
                      ...(isEntry
                        ? [["Your stake", fmtUsd(Number(order.collateral_amount) / 1e6)] as const]
                        : [["On position", order.position_id > BigInt(0) ? `#${order.position_id}` : "not bound yet"] as const]),
                      ["Keeper fee", fmtUsd(Number(order.keeper_fee_amount) / 1e6)],
                      ["Price now", indexUsd === null ? "unavailable" : fmtPrice(indexUsd)],
                    ] as const).map(([k, v]) => (
                      <div key={k}>
                        <dt className="text-white/35">{k}</dt>
                        <dd className="tabular-nums text-white/80">{v}</dd>
                      </div>
                    ))}
                  </dl>

                  <p className="mt-2 text-[11px] leading-relaxed text-white/40">{state.note}</p>

                  {/* PEX considering an order collectable is a money fact, not a
                      status nuance: the escrow is recoverable and nobody has to
                      recover it. Never rendered as resolved. */}
                  {cleanupReason && (
                    <p className="mt-1 text-[11px] text-amber-300/80">
                      PEX marks this order collectable ({cleanupReason.replace(/_/g, " ")}) — its
                      escrow is still locked until it is cleared.
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          {/* Say what we cannot do about them yet, in the same place they are
              shown, rather than leaving the absence to be discovered. */}
          <p className="mt-2 text-[10px] leading-relaxed text-white/30">
            Read-only for now: placing and cancelling orders from this page is not built yet.
            An order resting here holds its keeper fee, and an entry order also holds its stake,
            until it executes or is cancelled.
          </p>
        </div>
      )}

      {ordersError && (
        <p className="mt-2 text-[11px] text-amber-300/80">
          Couldn&apos;t load your resting orders. ({ordersError})
        </p>
      )}

      {positions.length > 0 && (
        <>
        {/* Name the basis. "Net" invites the reader to assume it is measured
            against what they deposited, and it is not — `collateral_amount` is
            already net of the open and builder fees. See the note on `netUsd`. */}
        <p className="mt-3 text-[10px] leading-relaxed text-white/30">
          &quot;Net vs collateral&quot; compares what a close pays out against the collateral
          backing the position now — which is already after the fees charged when it opened,
          so a full round trip from your original stake is lower by those.
        </p>
        <p className="mt-2 text-[10px] leading-relaxed text-white/30">
          {/* Say plainly why there is no button, rather than leaving a gap the
              user has to interpret. */}
          Closing from this page is not available yet. Your take-profit still closes the position
          automatically at the price you set. Figures update every 30 seconds and are live quotes,
          not the numbers from when you opened.
        </p>
        </>
      )}
      </div>
    </div>
  );
}
