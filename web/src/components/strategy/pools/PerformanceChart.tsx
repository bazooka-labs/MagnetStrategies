"use client";

import type { PoolReturn } from "@/lib/strategy/pools/performance";

/**
 * The vault against simply holding the two assets, over real history only.
 *
 * ── Why a chart rather than another number ──
 * The card headlines an annualized figure, which is derived. This is the
 * opposite: nothing here is extrapolated, every point is a day PEX recorded.
 *
 * It exists because the single most important fact about this vault cannot be
 * expressed as a number a depositor will hold in their head. Measured
 * 2026-10-28 the vault returned −2.38% over 30 days and still beat the
 * benchmark by 10.04pp, because ALGO fell 12.42%. "Down, but down far less
 * than the assets" is a SHAPE. Two lines show it; "+10.04pp against a
 * geometric 50/50 benchmark" does not.
 *
 * ── Drawn by hand, deliberately ──
 * Two polylines and an axis. A charting library would be several hundred
 * kilobytes for this, and the page already carries a TradingView frame for
 * the one place real charting is needed.
 *
 * Both series arrive normalised to 1.0 on the window's first day, so they are
 * directly comparable and the y-axis is a multiple rather than a price.
 */
export function PerformanceChart({ ret }: { ret: PoolReturn | null }) {
  const pts = ret?.series ?? [];
  if (pts.length < 2) {
    return (
      <p className="py-6 text-center text-[11.5px] text-gray-500">
        Not enough history to chart yet.
      </p>
    );
  }

  const W = 640, H = 170, PAD_L = 34, PAD_R = 8, PAD_T = 10, PAD_B = 18;
  const lo = Math.min(...pts.flatMap((p) => [p.product, p.hold]));
  const hi = Math.max(...pts.flatMap((p) => [p.product, p.hold]));
  // A little headroom so neither line sits on the frame.
  const span = Math.max(hi - lo, 0.0001) * 1.12;
  const mid = (hi + lo) / 2;
  const top = mid + span / 2, bot = mid - span / 2;

  const x = (i: number) => PAD_L + (i / (pts.length - 1)) * (W - PAD_L - PAD_R);
  const y = (v: number) => PAD_T + (1 - (v - bot) / (top - bot)) * (H - PAD_T - PAD_B);
  const path = (pick: (p: typeof pts[number]) => number) =>
    pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(pick(p)).toFixed(1)}`).join(" ");

  const last = pts[pts.length - 1];
  const asPct = (v: number) => `${v >= 1 ? "+" : ""}${((v - 1) * 100).toFixed(1)}%`;
  const days = Math.round((last.ts - pts[0].ts) / 86_400);

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
          The vault vs holding the assets
        </span>
        <span className="text-[9.5px] text-gray-600">{days} days of real history</span>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
        aria-label={`Vault ${asPct(last.product)} against holding ${asPct(last.hold)} over ${days} days`}>
        {/* The 1.0 line — where both started. Crossing below it is a real loss. */}
        {bot < 1 && top > 1 && (
          <>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(1)} y2={y(1)}
              stroke="rgba(255,255,255,0.18)" strokeDasharray="3 3" strokeWidth={1} />
            <text x={PAD_L - 5} y={y(1) + 3} textAnchor="end"
              className="fill-gray-600 text-[9px]">0%</text>
          </>
        )}
        <text x={PAD_L - 5} y={y(top) + 7} textAnchor="end" className="fill-gray-600 text-[9px]">
          {asPct(top)}
        </text>
        <text x={PAD_L - 5} y={y(bot) - 1} textAnchor="end" className="fill-gray-600 text-[9px]">
          {asPct(bot)}
        </text>

        {/* Benchmark first so the vault draws over it. */}
        <path d={path((p) => p.hold)} fill="none" stroke="rgb(148 163 184)"
          strokeWidth={1.5} strokeOpacity={0.65} />
        <path d={path((p) => p.product)} fill="none" stroke="rgb(74 222 128)" strokeWidth={2} />
        <circle cx={x(pts.length - 1)} cy={y(last.product)} r={3} fill="rgb(74 222 128)" />
      </svg>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px]">
        <span className="flex items-center gap-1.5">
          <span className="h-[2px] w-4 rounded bg-green-400" />
          <span className="text-gray-400">C-Vault</span>
          <span className="font-mono font-semibold text-green-400">{asPct(last.product)}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-[2px] w-4 rounded bg-slate-400/70" />
          <span className="text-gray-400">Holding ALGO + USDC</span>
          <span className={`font-mono font-semibold ${
            last.hold >= 1 ? "text-gray-300" : "text-red-300"
          }`}>{asPct(last.hold)}</span>
        </span>
        {ret?.hasGaps && (
          <span className="text-[10px] text-amber-300/80">· has gaps in history</span>
        )}
      </div>
    </div>
  );
}
