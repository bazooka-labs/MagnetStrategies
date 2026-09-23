"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { createPortal } from "react-dom";

const MAGNET_ASA_ID = 3081853135;
const PANEL =
  "relative overflow-hidden rounded-2xl border border-white/10 bg-black/40 backdrop-blur-sm shadow-xl shadow-black/40";

type Row = {
  rank: number;
  assetId: number;
  unit: string | null;
  name: string | null;
  tvlAlgo: number;
  tvlUsd: number;
  pools: number;
  confidenceBps: number;
};
type Board = { asOfRound: number; eligible: number; top: Row[]; magnet: Row | null; generatedAt?: number };

/** Relative age of the board data, so staleness is visible rather than implied. */
function ageLabel(generatedAt: number): string {
  const secs = Math.max(0, Math.round((Date.now() - generatedAt) / 1000));
  if (secs < 60) return `updated ${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `updated ${mins}m ago`;
  return `updated ${Math.round(mins / 60)}h ago`;
}

const fmtUsd = (v: number) =>
  v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(2)}M`
  : v >= 1_000 ? `$${(v / 1_000).toFixed(1)}k`
  : `$${v.toFixed(0)}`;

export function TvlRankStat() {
  const [board, setBoard] = useState<Board | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const magnetRowRef = useRef<HTMLTableRowElement>(null);

  // cache: "no-store" so the browser never serves its own copy — that was the "needs a hard
  // refresh" symptom. Freshness is bounded by the route's short s-maxage instead.
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/leaderboard", { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      setBoard(await r.json());
      setFailed(false);
    } catch {
      setBoard((prev) => prev);          // keep the last good board rather than blanking
      setFailed((prev) => prev || false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    fetch("/api/leaderboard", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: Board) => alive && setBoard(d))
      .catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, []);

  // Refetch when the tab regains focus, so a page left open does not show a stale rank.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [load]);

  // Land on $U rather than at rank 1 — this is also what makes the modal work on the day
  // $U sits outside the top 100.
  useEffect(() => {
    if (!open) return;
    const body = bodyRef.current;
    const row = magnetRowRef.current;
    if (body && row) body.scrollTop = Math.max(0, row.offsetTop - body.clientHeight / 2);
  }, [open]);

  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  const rank = board?.magnet?.rank ?? null;
  const value = failed ? "—" : rank !== null ? `#${rank}` : "…";
  // No denominator in the box by request — the eligible count stays in the modal header,
  // where it reads as methodology rather than a claim.
  const sub = failed ? "Unavailable" : board ? null : "Loading";

  const outsideTop100 = board?.magnet != null && board.magnet.rank > 100;

  return (
    <>
      <button
        type="button"
        onClick={() => board && setOpen(true)}
        disabled={!board}
        aria-haspopup="dialog"
        className="group relative w-full p-5 text-left transition-colors enabled:hover:bg-white/5 disabled:cursor-default focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-magnet-500"
      >
        <p className="text-xs font-medium uppercase tracking-wider text-gray-500">TVL Rank</p>
        <p className="mt-2 font-mono text-2xl font-bold text-magnet-300">{value}</p>
        {sub && <p className="mt-0.5 text-xs text-gray-500">{sub}</p>}
        {board && (
          <span className="absolute bottom-3 right-4 inline-flex items-center gap-1 font-mono text-[10px] tracking-wide text-magnet-400 transition-colors group-hover:text-magnet-300">
            See Top 100
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="h-2.5 w-2.5" aria-hidden="true">
              <path d="M3 8h10M9 4l4 4-4 4" />
            </svg>
          </span>
        )}
      </button>

      {open && board && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm sm:p-6"
          onClick={(e) => { if (e.target === e.currentTarget) close(); }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Top 100 ASAs by TVL"
            className={`${PANEL} flex max-h-[88vh] w-full max-w-3xl flex-col`}
          >
            <div className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
              <div>
                <h2 className="font-display text-lg font-semibold text-white">Top 100 ASAs by TVL</h2>
                <p className="mt-0.5 text-xs text-gray-500">
                  Round {board.asOfRound.toLocaleString("en-US")}
                  {board.generatedAt ? ` · ${ageLabel(board.generatedAt)}` : ""} ·{" "}
                  {board.eligible.toLocaleString("en-US")} assets meet the eligibility floor
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className="shrink-0 rounded-lg border border-white/10 px-2.5 py-1 text-gray-400 transition-colors hover:border-magnet-500/50 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-magnet-500"
              >
                ✕
              </button>
            </div>

            <div ref={bodyRef} className="overflow-auto">
              <table className="w-full font-mono text-xs">
                <thead className="sticky top-0 z-10 bg-[#0b0910]/95 backdrop-blur-sm">
                  <tr className="text-[10px] uppercase tracking-wider text-gray-500">
                    <th className="px-4 py-2 text-left font-medium">#</th>
                    <th className="px-4 py-2 text-left font-medium">Asset</th>
                    <th className="px-4 py-2 text-right font-medium">TVL USD</th>
                    <th className="px-4 py-2 text-right font-medium">TVL ALGO</th>
                    <th className="px-4 py-2 text-right font-medium">Pools</th>
                  </tr>
                </thead>
                <tbody>
                  {board.top.map((r) => {
                    const isU = r.assetId === MAGNET_ASA_ID;
                    return (
                      <tr
                        key={r.assetId}
                        ref={isU ? magnetRowRef : undefined}
                        className={`border-b border-white/5 ${isU ? "bg-magnet-500/15" : ""}`}
                      >
                        <td className={`px-4 py-2 tabular-nums ${isU ? "font-semibold text-magnet-300" : "text-gray-500"}`}>{r.rank}</td>
                        <td className={`px-4 py-2 font-sans ${isU ? "font-semibold text-magnet-300" : "text-gray-200"}`}>
                          {r.unit ?? `#${r.assetId}`}
                          {isU && (
                            <span className="ml-2 rounded border border-magnet-500 px-1 py-px text-[9px] uppercase tracking-wider text-magnet-300">
                              Magnet
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-gray-200">{fmtUsd(r.tvlUsd)}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-gray-500">{Math.round(r.tvlAlgo).toLocaleString("en-US")}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-gray-500">{r.pools}</td>
                      </tr>
                    );
                  })}
                  {outsideTop100 && board.magnet && (
                    <tr ref={magnetRowRef} className="border-t-2 border-magnet-500/40 bg-magnet-500/15">
                      <td className="px-4 py-2 font-semibold tabular-nums text-magnet-300">{board.magnet.rank}</td>
                      <td className="px-4 py-2 font-sans font-semibold text-magnet-300">
                        {board.magnet.unit ?? "$U"}
                        <span className="ml-2 rounded border border-magnet-500 px-1 py-px text-[9px] uppercase tracking-wider text-magnet-300">
                          Magnet
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-gray-200">{fmtUsd(board.magnet.tvlUsd)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-gray-500">{Math.round(board.magnet.tvlAlgo).toLocaleString("en-US")}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-gray-500">{board.magnet.pools}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <p className="border-t border-white/10 px-5 py-3 text-[11px] text-gray-500">
              Two-sided TVL — the full value of every pool containing the asset. 80% price-confidence
              floor, minimum 2 pools. Per-asset figures double count, so the column is not an
              ecosystem total.
            </p>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
