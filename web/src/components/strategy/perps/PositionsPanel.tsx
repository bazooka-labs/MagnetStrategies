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
  // and a divider under nothing is a card that looks broken.
  return (
    <div>
      {/* Full-bleed, because the wrapping Panel holds no padding of its own —
          each section carries it. Tinted like the Panel's own top hairline so
          the seam reads as part of one card rather than a join between two. */}
      <div className="h-px bg-gradient-to-r from-transparent via-magnet-500/30 to-transparent" />

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
          const pnl = p.close?.pnlUsd ?? null;
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
                {pnl !== null && (
                  <span className={`text-sm font-bold tabular-nums ${
                    pnl >= 0 ? "text-green-300" : "text-red-300"}`}>
                    {fmtSigned(pnl)}
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
                ] as const).map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-white/35">{k}</dt>
                    <dd className="tabular-nums text-white/80">{v}</dd>
                  </div>
                ))}
              </dl>

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
        <p className="mt-3 text-[10px] leading-relaxed text-white/30">
          {/* Say plainly why there is no button, rather than leaving a gap the
              user has to interpret. */}
          Closing from this page is not available yet. Your take-profit still closes the position
          automatically at the price you set. Figures update every 30 seconds and are live quotes,
          not the numbers from when you opened.
        </p>
      )}
      </div>
    </div>
  );
}
