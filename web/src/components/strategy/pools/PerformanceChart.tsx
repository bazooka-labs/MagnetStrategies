"use client";

import type { PoolReturn } from "@/lib/strategy/pools/performance";

/**
 * Holding period return, plotted — the share price against simply holding the
 * two assets, over real history only.
 *
 * ── Why a chart rather than another number ──
 * The card headlines an annualized figure, which is derived. This is the
 * opposite: nothing here is extrapolated, every point is a day PEX recorded.
 *
 * It exists because the single most important fact about this vault cannot be
 * expressed as a number a depositor will hold in their head. Measured
 * 2026-10-29 the vault returned +1.27% over 29 days while the benchmark LOST
 * 9.21%, because ALGO fell. "Up a little, while the assets fell hard" is a
 * SHAPE. Two lines show it; a pair of percentages does not.
 *
 * ── The y-axis is percent, not a multiple ──
 * It used to plot the normalised index (1.00, 1.17) with percent only on the
 * axis labels. Reading a value off it then needed a conversion the reader
 * should not have to do, and the numbers beside the chart were percentages
 * already. Everything is now the same unit as the ladder above it.
 *
 * ── Drawn by hand, deliberately ──
 * Polylines, an area fill and an axis. A charting library would be several
 * hundred kilobytes for this, and the page already carries a TradingView
 * frame for the one place real charting is needed.
 */
export function PerformanceChart({ ret, marks = [] }: {
  ret: PoolReturn | null;
  /**
   * Shorter windows to mark on the x-axis, as day counts. They tie the three
   * figures in the ladder to one picture: without them a reader has no way to
   * see WHERE the 29-day window sits inside the 56-day line.
   */
  marks?: { days: number; label: string }[];
}) {
  const pts = ret?.series ?? [];
  if (pts.length < 2) {
    return (
      <p className="py-6 text-center text-[11.5px] text-gray-500">
        Not enough history to chart yet.
      </p>
    );
  }

  const W = 640, H = 196, PAD_L = 42, PAD_R = 14, PAD_T = 14, PAD_B = 30;
  /** Both series arrive normalised to 1.0 on day one, so this is the return. */
  const asPct = (v: number) => (v - 1) * 100;
  const vals = pts.flatMap((p) => [asPct(p.product), asPct(p.hold), 0]);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = Math.max((hi - lo) * 0.14, 0.6);
  const top = hi + pad, bot = lo - pad;

  const x = (i: number) => PAD_L + (i / (pts.length - 1)) * (W - PAD_L - PAD_R);
  const y = (v: number) => PAD_T + (1 - (v - bot) / (top - bot)) * (H - PAD_T - PAD_B);
  const line = (pick: (p: typeof pts[number]) => number) =>
    pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(asPct(pick(p))).toFixed(1)}`).join(" ");

  const last = pts[pts.length - 1];
  const first = pts[0];
  const days = Math.round((last.ts - first.ts) / 86_400);
  /** Axis ticks round to one place; the legend matches the ladder's two. */
  const fmt = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`;
  const fmt2 = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}%`;
  const date = (ts: number) =>
    new Date(ts * 1000).toLocaleDateString([], { day: "numeric", month: "short", timeZone: "UTC" });

  /** Ticks on round numbers the line actually reaches, never a fixed count. */
  const step = (() => {
    const raw = (top - bot) / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  })();
  const ticks: number[] = [];
  for (let t = Math.ceil(bot / step) * step; t <= top; t += step) ticks.push(t);

  const endPct = asPct(last.product);
  const endY = y(endPct);

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
          The vault vs holding the assets
        </span>
        {/*
          The sample count, not a "gaps" badge. This window carries 48 samples
          across 56 days, so days ARE missing — but an amber warning tag made
          an ordinary property of a daily feed look like a fault. Stating both
          numbers says the same thing without the alarm.
        */}
        <span className="text-[9.5px] text-gray-600">
          {pts.length} daily samples across {days} days
        </span>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
        aria-label={`The vault returned ${fmt(endPct)} over ${days} days; holding the two assets returned ${fmt(asPct(last.hold))}`}>
        <defs>
          <linearGradient id="cva-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(74 222 128)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="rgb(74 222 128)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)}
              stroke="rgba(255,255,255,0.055)" strokeWidth={1} />
            <text x={PAD_L - 6} y={y(t) + 3} textAnchor="end"
              className="fill-gray-600 text-[9px]">{fmt(t)}</text>
          </g>
        ))}

        {/* Zero — where a depositor breaks even. Drawn over the grid. */}
        {bot < 0 && top > 0 && (
          <line x1={PAD_L} x2={W - PAD_R} y1={y(0)} y2={y(0)}
            stroke="rgba(255,255,255,0.3)" strokeDasharray="3 3" strokeWidth={1} />
        )}

        {/* Where the shorter windows begin, so the ladder maps onto the line. */}
        {marks.map((m) => {
          const i = pts.length - 1 - Math.round(m.days / ((last.ts - first.ts) / 86_400 / (pts.length - 1)));
          if (i <= 0 || i >= pts.length - 1) return null;
          return (
            <g key={m.label}>
              <line x1={x(i)} x2={x(i)} y1={PAD_T} y2={H - PAD_B}
                stroke="rgba(255,255,255,0.14)" strokeDasharray="2 4" strokeWidth={1} />
              <text x={x(i)} y={H - PAD_B + 12} textAnchor="middle"
                className="fill-gray-600 text-[9px]">{m.label}</text>
            </g>
          );
        })}

        <path d={`${line((p) => p.product)} L${x(pts.length - 1)},${y(Math.max(bot, 0))} L${x(0)},${y(Math.max(bot, 0))} Z`}
          fill="url(#cva-area)" stroke="none" />
        {/* Benchmark under the vault line, so the vault reads as the subject. */}
        <path d={line((p) => p.hold)} fill="none" stroke="rgb(148 163 184)"
          strokeWidth={1.5} strokeOpacity={0.55} strokeDasharray="4 3" />
        <path d={line((p) => p.product)} fill="none" stroke="rgb(74 222 128)"
          strokeWidth={2} strokeLinejoin="round" />
        <circle cx={x(pts.length - 1)} cy={endY} r={3.5} fill="rgb(74 222 128)" />

        <text x={PAD_L} y={H - PAD_B + 23} className="fill-gray-600 text-[9px]">{date(first.ts)}</text>
        <text x={W - PAD_R} y={H - PAD_B + 23} textAnchor="end"
          className="fill-gray-600 text-[9px]">{date(last.ts)}</text>
      </svg>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px]">
        <span className="flex items-center gap-1.5">
          <span className="h-[2px] w-4 rounded bg-green-400" />
          <span className="text-gray-400">C-Vault share price</span>
          <span className="font-mono font-semibold text-green-400">{fmt2(endPct)}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-[2px] w-4 rounded bg-slate-400/70" />
          <span className="text-gray-400">Holding ALGO + USDC</span>
          <span className={`font-mono font-semibold ${
            last.hold >= 1 ? "text-gray-300" : "text-red-300"
          }`}>{fmt2(asPct(last.hold))}</span>
        </span>
      </div>
    </div>
  );
}
