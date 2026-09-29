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
import { usePerpsPositions } from "@/hooks/usePerpsPositions";
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

export function PositionsPanel() {
  const wallet = useWallet();
  const { positions, loading, error, refresh } = usePerpsPositions(
    wallet.isConnected ? wallet.address : null,
  );

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
        <button onClick={refresh} disabled={loading}
          className="text-xs text-white/40 underline underline-offset-2 hover:text-white/70 disabled:opacity-40">
          {loading ? "Refreshing…" : "Refresh"}
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
          You have no open positions. Anything you open will appear here.
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
                  ── Why this is ONE number and not an itemised breakdown ──
                  It was five fields — close fee, Magnet fee, funding,
                  borrowing, price impact — and reviewing that against all
                  eight live positions found it did not add up on any of the
                  four two-asset longs, off by $0.14–$0.18 on stakes as small
                  as $5.50. The whole residual was the funding term:
                  `funding_fee_collateral_amount` reported a COST on five of
                  eight positions where funding had in fact been CREDITED to the
                  trader, so the line both inverted the largest term's sign and
                  printed it under a heading that said "costs".
                  Why the itemisation is not simply sign-corrected: the
                  mechanism is not established. `collateral_delta −
                  collateral_amount` reconciles exactly on all eight, which says
                  the settlement is real and knowable, but which PEX field
                  carries the token-denominated half of it is an open question
                  with Ultrade. Publishing a decomposition we cannot derive is
                  the same mistake as `collateral_delta` itself — internally
                  plausible, wrong at the boundary.
                  So: the difference between the two figures above, which is
                  exact by construction because both ends are verified. It
                  cannot disagree with them, because it is defined as their
                  gap. */}
              {p.close && netUsd !== null && priceMove !== null && (
                <p className="mt-2 text-[11px] text-white/35">
                  Exit costs and funding, net:{" "}
                  <span className="tabular-nums text-white/55">{fmtSigned(netUsd - priceMove)}</span>
                  {" "}— the difference between the two figures above. We don&apos;t itemise it
                  yet, because one of PEX&apos;s fee fields doesn&apos;t reconcile against what
                  the chain settled and we&apos;d rather show one number we can stand behind.
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
