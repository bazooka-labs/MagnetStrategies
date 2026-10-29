"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import {
  X, BookOpen, TrendingUp, Coins, Scale, Settings2, AlertTriangle,
} from "lucide-react";
import { RAISED_AMBER } from "@/components/raisedButton";
import { PerformanceChart } from "./PerformanceChart";
import type { PoolStats, PerfPeriod } from "@/lib/strategy/pools/performance";
import { benchmarkLabel } from "@/lib/strategy/pools/performance";

/**
 * "What am I actually depositing into?" — the C-Vault explainer.
 *
 * Modelled on LpVaultLearnMore so the two products read as one site: amber
 * trigger pill, portal modal, magnet-tinted frame, same hairline.
 *
 * ── What this must not do ──
 * Everything here is a claim about someone else's protocol and someone else's
 * money. Two rules held throughout:
 *
 *   1. Nothing is a projection. Every figure comes from PEX's published
 *      bundle and is labelled with the window it covers. No annualizing of a
 *      short window — see the APR note below, which is the whole reason the
 *      headline is still 7d.
 *   2. The counterparty risk is stated in the body, not in a footnote. A
 *      depositor is the other side of every trade; a page that explains the
 *      upside in four panels and the downside in grey 10px type is a brochure.
 */

const pct = (v: number | null | undefined, dp = 2) =>
  v === null || v === undefined ? "—" : `${v >= 0 ? "" : ""}${v.toFixed(dp)}%`;
const signed = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;

const SECTIONS: { icon: React.ReactNode; title: string; body: React.ReactNode }[] = [
  {
    icon: <TrendingUp className="h-5 w-5" />,
    title: "What PEX is",
    body: (
      <>
        PEX is Ultrade&apos;s perpetual futures protocol on Algorand — the same protocol the{" "}
        <strong className="font-semibold text-gray-300">Trading Terminal</strong> on this site trades
        against. Perpetuals are leveraged bets on a price with no expiry date: a trader posts
        collateral, picks a direction, and holds for as long as they keep enough margin.
        Everything settles on chain in Algorand smart contracts. Magnet Strategies writes none of
        those contracts and custodies none of the money — this page builds the calls and your own
        wallet signs them.
      </>
    ),
  },
  {
    icon: <Coins className="h-5 w-5" />,
    title: "Who is on the other side",
    body: (
      <>
        Every trader who opens a position needs someone to take the opposite one. That is what this
        vault does. Traders come here to get leverage on ALGO and BTC; liquidity providers come here
        to be paid for supplying it. When you deposit, your capital joins the pool that backs those
        positions — so you are short whatever the traders are long, in proportion to your share.
      </>
    ),
  },
  {
    icon: <Scale className="h-5 w-5" />,
    title: "How it earns",
    body: (
      <>
        {/* Moved here from the card on 2026-10-28, where it was the only
            sentence left beside the figure. Ordered by contribution: trader
            P&L is ~96% of what the vault adds, swap fees 0-3%. */}
        Three sources, in the order they matter.{" "}
        <strong className="font-semibold text-gray-300">Earnings from opposite trade
        positions</strong> — when a trader loses, the pool is the other side, and this is most of
        the return. <strong className="font-semibold text-gray-300">ALGO/USDC price
        movement</strong>, because the vault holds both and is not hedged; this is what makes the
        figure swing between windows. And <strong className="font-semibold text-gray-300">pool
        swap fees</strong> plus yield on idle capital — steady, and the smallest of the three.
        <br /><br />
        All of it accrues to the share price, so you hold a growing number of dollars per share
        rather than being paid out — there is nothing to claim.
      </>
    ),
  },
  {
    icon: <Settings2 className="h-5 w-5" />,
    title: "How PEX manages it",
    body: (
      <>
        You deposit <strong className="font-semibold text-gray-300">ALGO + USDC</strong>. This is
        the <em>managed</em> option, which is the difference between it and depositing into
        a single market directly. The vault <strong className="font-semibold text-gray-300">spans
        both markets</strong> — ALGO/USD and BTC/USD — and PEX decides how much sits in each and
        rebalances between them; it marks the vault&apos;s net asset value on chain, and that mark
        is what your shares are priced against when you deposit or withdraw. PEX can also pause
        deposits or withdrawals. You do not pick a market and cannot override an allocation —
        you are buying their allocation decisions along with the exposure.
      </>
    ),
  },
];

/** One row of the return ladder. */
function ReturnRow({ period, stats }: { period: PerfPeriod; stats: PoolStats }) {
  const r = stats.returns[period];
  const label = period === "total" ? "All time" : `${period.replace("d", "")} days`;
  if (!r) {
    const why = stats.reasons[period];
    return (
      <div className="flex items-baseline justify-between gap-3 py-1.5">
        <span className="text-[11.5px] text-gray-500">{label}</span>
        <span className="text-[11px] text-gray-600">
          {why === "insufficient_history" || why === "no_valid_completed_samples"
            ? "not enough history yet"
            : "unavailable"}
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="text-[11.5px] text-gray-500">
        {label}
        {r.hasGaps && <span className="text-amber-300/90"> · gaps</span>}
      </span>
      <span className="flex items-baseline gap-2.5">
        <span className={`font-mono text-[13px] font-semibold ${
          r.productPct >= 0 ? "text-green-400" : "text-red-300"
        }`}>
          {signed(r.productPct)}%
        </span>
        {/* Spelled out, not "vs bm": the whole point of this column is that
            the reader understands it is a COMPARISON, and an abbreviation they
            have to decode is the same as no column. */}
        <span className="w-[132px] text-right font-mono text-[11px] text-gray-500">
          {signed(r.vsHoldingPoints)}pp vs benchmark
        </span>
      </span>
    </div>
  );
}

export function CvaAbout({ stats, stale }: { stats: PoolStats | null; stale: boolean }) {
  const [open, setOpen] = useState(false);
  const i = stats?.income ?? null;
  const thirty = stats?.returns["30d"] ?? null;
  /** The chart uses the longest real window — never a label, never padded. */
  const longest = (["total", "90d", "30d", "7d"] as const)
    .map((p) => stats?.returns[p])
    .find((r): r is NonNullable<typeof r> => !!r && r.series.length > 1) ?? null;

  return (
    <>
      {/* Amber pill — the shape this site already uses for "press here to
          understand what you are looking at". Worded "Learn more" to match
          the MagnetFi LP-vault button exactly — same control, same shape, same
          words. */}
      <button onClick={() => setOpen(true)} aria-haspopup="dialog" className={RAISED_AMBER}>
        <BookOpen className="h-3.5 w-3.5" /> Learn more
      </button>

      {open && createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="About the C-Vault Strategy"
        >
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

          <div
            className="relative z-10 w-full max-w-3xl overflow-hidden rounded-2xl border border-magnet-500/20 bg-gradient-to-br from-magnet-950/90 via-[#0d0818]/95 to-magnet-950/80 shadow-2xl shadow-magnet-900/40"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-magnet-500/60 to-transparent" />

            <div className="flex items-center justify-between border-b border-white/5 px-6 pb-4 pt-6 sm:px-7">
              <div>
                <h2 className="font-display magnet-glow-soft text-xl font-bold text-white">
                  C-Vault Strategy
                </h2>
                <p className="mt-0.5 text-xs text-gray-500">
                  Managed liquidity on PEX — what it is, how it pays, and what you carry.
                </p>
              </div>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-white/5 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="max-h-[75vh] space-y-5 overflow-y-auto px-6 py-6 sm:px-7">
              {/* ── The rate, up top, because it is what the button was pressed for ── */}
              <div className="rounded-xl border border-green-500/20 bg-green-500/[0.04] p-5">
                <div className="flex flex-wrap items-end justify-between gap-4">
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                      Fees + yield APR
                    </div>
                    <div className="mt-1 flex items-baseline gap-2.5">
                      <span className="font-mono text-[40px] font-bold leading-none tracking-tight text-green-400">
                        {pct(i?.totalPct)}
                      </span>
                      {stale && (
                        <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[9.5px] font-semibold text-amber-300">
                          STALE
                        </span>
                      )}
                    </div>
                    <p className="mt-2 text-[11.5px] text-gray-400">
                      {i
                        ? <>{pct(i.feePct)} fees + {pct(i.yieldPct)} yield · published by PEX over the past 7 days</>
                        : "PEX has not published a rate for this vault."}
                    </p>
                  </div>
                  {thirty && (
                    <div className="text-right">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                        Last 30 days
                      </div>
                      <div className={`mt-1 font-mono text-[26px] font-semibold leading-none ${
                        thirty.productPct >= 0 ? "text-green-400" : "text-red-300"
                      }`}>
                        {signed(thirty.productPct)}%
                      </div>
                      <p className="mt-1.5 text-[11px] text-gray-500">
                        share price, {signed(thirty.vsHoldingPoints)}pp {benchmarkLabel(thirty.benchmarkKind)}
                      </p>
                    </div>
                  )}
                </div>

                {/*
                  ── Two different quantities, and the card headlines the
                     second one ──
                  INCOME APR (fees + yield) is published by PEX as
                  `total_apr_7d_bps` and friends. It is already a rate, it is
                  7-day only, and there is no longer-window equivalent.

                  SHARE-PRICE RETURN is the whole picture — the same income
                  plus or minus trader P&L and asset price moves. It is NOT a
                  rate, and the card's headline annualizes it from the longest
                  available window as a deliberate product decision.

                  The ladder below is the counterweight to that headline, and
                  it is why the headline is defensible: a reader who sees the
                  30-day window negative cannot read the annualized figure as
                  a promise. The reasoning and the three conditions the
                  headline rests on are in pools/performance.ts, on
                  `pickLongest`.
                */}
                <div className="mt-5 border-t border-white/[0.07] pt-4">
                  <div className="mb-1 flex items-baseline justify-between">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                      Share price, by window
                    </span>
                    <span className="text-[9.5px] text-gray-600">incl. trader P&amp;L</span>
                  </div>
                  {stats
                    ? (["7d", "30d", "90d", "total"] as const).map((p) => (
                        <ReturnRow key={p} period={p} stats={stats} />
                      ))
                    : <p className="py-2 text-[11.5px] text-gray-500">No published history yet.</p>}
                  <p className="mt-2.5 text-[10.5px] leading-relaxed text-gray-500">
                    The APR above counts fees and yield only. These returns are the whole picture —
                    the same income, plus or minus what the pool won or lost against traders.
                    <strong className="text-gray-300"> Shown here as realized, never annualized</strong>,
                    because the windows disagree sharply: on 2026-10-28 these same figures
                    annualized to +812%, −26% and +183% depending on which one you picked. The
                    card headlines the longest of them,{" "}
                    <strong className="text-gray-300">run on to the live share price</strong> so it
                    refreshes between PEX&rsquo;s daily updates — which is why its window reads a
                    day or two longer than the one above. This is the spread behind it.
                  </p>
                </div>
              </div>

              {/*
                ── The chart, and why it is here rather than on the card ──
                Nothing in it is extrapolated: every point is a day PEX
                recorded, and both lines start at 0% on the same day. It is
                the only place a depositor can SEE the thing that matters
                most — that in the losing month the benchmark fell further
                than the vault did. The card's headline is annualized and
                therefore derived; this is the opposite, and the two belong in
                different places for that reason.
              */}
              <div className="rounded-xl border border-white/10 bg-black/30 p-4">
                <PerformanceChart ret={longest} />
                <p className="mt-2.5 text-[10.5px] leading-relaxed text-gray-500">
                  Both lines start at 0% on the same day, so they are directly
                  comparable. The grey line is what simply holding ALGO and USDC would
                  have done over the same period — when the vault stays above it, the
                  strategy added value regardless of which way the market went.
                </p>
              </div>

              {/* ── The explainer ── */}
              <div className="grid gap-3 sm:grid-cols-2">
                {SECTIONS.map((s) => (
                  <div key={s.title} className="rounded-xl border border-white/10 bg-black/30 p-4">
                    <div className="mb-2.5 flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-magnet-600 to-magnet-800 text-white">
                      {s.icon}
                    </div>
                    <p className="text-sm font-semibold text-white">{s.title}</p>
                    <p className="mt-1 text-xs leading-relaxed text-gray-400">{s.body}</p>
                  </div>
                ))}
              </div>

              {/* ── What you carry. Same weight as the four panels above it. ── */}
              <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.05] p-4">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
                  <p className="text-sm font-semibold text-amber-100">What you carry</p>
                </div>
                <ul className="mt-2.5 space-y-1.5 text-xs leading-relaxed text-amber-100/80">
                  <li>
                    <strong className="font-semibold text-amber-100">You can lose money.</strong>{" "}
                    The share price falls when traders win against the pool, and it holds two
                    volatile assets — ALGO and USDC — so it moves with ALGO&apos;s price too. The
                    benchmark column above is there to show when holding would have beaten it.
                  </li>
                  {/*
                    ── Where the spread goes, verified against the bytecode ──
                    Added 2026-10-26 after a $25.00 deposit arrived as a $24.95
                    position and the obvious reading was "PEX took five cents".
                    It did not. Checked against the deployed program (sha256
                    b2fd9b6f…, which matches our pin):

                      - the burn-spread routine is `proto 1 1` — one value in,
                        one out. It returns `v - v*bps/10000` and performs no
                        transfer, writes no global, touches no address;
                      - every outbound payment in all 6,578 lines goes to
                        `txn Sender` or to a market app's AppAddress. There is
                        no third recipient;
                      - none of the 26 globals the contract writes is a fee
                        destination or accumulator, and the strings fee,
                        treasury, collect, protocol and revenue appear nowhere
                        in the program.

                    So it is a dilution guard, not a fee: the mover pays it and
                    the stayers receive it, which is what stops someone
                    entering or exiting against a stale NAV mark from taking
                    value off the people who sat still.

                    Worth stating plainly because the UI previously said only
                    "costs 0.2% in and 0.2% out", which reads as a fee to a
                    third party — the opposite of what it is, and a worse story
                    than the truth.
                  */}
                  <li>
                    <strong className="font-semibold text-amber-100">It costs 0.2% in and 0.2% out,
                    and that money stays in the vault.</strong>{" "}
                    It is not a fee to PEX, and nobody collects it: a $25 deposit becomes about
                    $24.95 of shares, and the five cents is left behind in the pool, where it
                    raises the share price for everyone already in it. The same happens in reverse
                    when you leave. It exists so that someone entering or exiting against a
                    slightly stale valuation cannot take value off the people who stayed — so you
                    pay it when you move, and you collect it when others do. A round trip still
                    starts about 0.4% behind. There is a withdrawal cooldown of roughly an hour
                    and a $5 minimum withdrawal.
                  </li>
                  <li>
                    <strong className="font-semibold text-amber-100">PEX controls the vault.</strong>{" "}
                    Allocations, the NAV mark and the pause switches are theirs. These figures come
                    from a PEX feed delivered over HTTPS, which PEX documents as unsigned — we
                    check the envelope, but it is not a chain read and is not presented as one.
                    Pool sizes and your own position are read directly from the chain and do not
                    depend on that feed.
                  </li>
                  {/*
                    Moved here from the page's amber caveat panel, which was
                    removed with the rest of the PEX-specific page chrome. The
                    panel was the only place either of these was stated, and
                    deleting the box is not a reason to stop saying them — so
                    they live with the product they are about.
                  */}
                  <li>
                    <strong className="font-semibold text-amber-100">PEX has had no external
                    audit.</strong>{" "}
                    Capital goes to a third-party protocol by Ultrade. Magnet Strategies holds no
                    funds and operates no exchange.
                  </li>
                  <li>
                    <strong className="font-semibold text-amber-100">The APR is income, not a
                    forecast.</strong>{" "}
                    It excludes asset price moves and net trader P&amp;L, so a positive APR can sit
                    alongside a negative return. It is not a promised future rate, and it is not
                    APY.
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
