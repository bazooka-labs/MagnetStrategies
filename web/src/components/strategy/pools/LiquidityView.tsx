"use client";

/**
 * Strategy — PEX liquidity provision. See strategy/pools/SPEC.md.
 *
 * ── Why all three cards glow purple ───────────────────────────────────────
 * On the Finance page gold means "this collateral is not $U" — it marks a
 * different risk family, which is why ALGO/USDC is the only gold vault there.
 * Here all three destinations hold the SAME collateral (ALGO + USDC), so a gold
 * card would assert a distinction that does not exist. An early mockup used gold
 * for the ALGO market and was wrong for exactly that reason.
 *
 * ── Signing happens here, not on PEX ──────────────────────────────────────
 * The two direct market pools take deposits and withdrawals in this UI:
 * `strategy/client.ts` composes the gates, the build, the assertion and the
 * simulation, and `LiquidityActions` is the form. An earlier revision linked
 * out to a PEX frontend instead; that is deliberately gone, URL included.
 *
 * The C-Vault signs here too, via `cvaClient.ts`. It is the harder shape by a
 * distance — the vault asserts `gm2:[40..48] == global Round` exactly, plus a
 * verified `mark_market` leg per funded allocation in the SAME group, so every
 * action carries a pricing preamble whose length depends on vault state. Its
 * NAV ran 36-257 rounds stale against a 5-round window while this was built,
 * which is why that preamble is the normal case and not an edge one. The SDK
 * assembles it; strategy/pools/SIGNING.md §11.7 has the detail.
 *
 * Its withdrawals are denominated in DOLLARS rather than a share percentage,
 * unlike the pools: every constraint on this vault is a dollar figure, so a
 * percentage slider would make the $5 floor a surprise exactly where it bites.
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Coins, Droplets, Layers, Shield, Sparkles, TrendingUp } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { PEX_APPS } from "@/lib/strategy/pex/config";
import { MAGNETFI_ADMIN_ADDRESS } from "@/lib/magnetfi";
import { RAISED_AMBER, RAISED_AMBER_ON } from "@/components/raisedButton";
import { Panel, MAGNET_GLOW } from "@/components/magnetfi/v2/shared";
import { StrategySplash } from "./StrategySplash";
import { LiquidityActions } from "./LiquidityActions";
import { CvaActions } from "./CvaActions";
import { CvaAbout } from "./CvaAbout";
import {
  benchmarkLabel, cvaKey, fetchPerformanceBundle, marketKey, pickLongest,
  type PerformanceBundle, type PoolStats,
} from "@/lib/strategy/pools/performance";
import {
  cvaShareOfMarket, readStrategyLiquidity, type StrategyLiquidity,
} from "@/lib/strategy/pools/reads";

/**
 * ── There is deliberately no PEX URL in this file ──
 *
 * It used to hold one, and the history is worth keeping because it is the
 * reason the product decision went the way it did. The constant read
 * `https://pex.ultrade.org` until 2026-10-20, a hostname that **does not
 * exist** — no A record, no AAAA, no resolution. It was invented, nothing in
 * this repo could contradict it, and so every call to action on the page
 * pointed at a browser DNS error. Its replacement, `app.ultrade.org`, resolved
 * but was never confirmed to be where PEX liquidity provision lives.
 *
 * The decision was to stop linking out altogether: "don't use the URL, forget
 * that as an option — I wanted to have the signing happen directly on the
 * Magnet UI." So the market pools sign here, and the C-Vault says it is not
 * ready rather than sending anyone anywhere.
 */

const usd = (v: number | null, dp = 0) =>
  v === null ? "—" : `$${v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
const pct = (v: number | null, dp = 1) => (v === null ? "—" : `${v.toFixed(dp)}%`);
const num = (v: number | null, dp = 0) =>
  v === null ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

/** The page's sections. One today; the track exists because more are coming. */
type Tab = "pools";

/**
 * One pill, identical to the Finance and Tokens tracks.
 *
 * Deliberately a real segmented control rather than a heading, even with a
 * single option: a track that gains its second tab is a one-line change, and a
 * heading that has to become a track later is a rewrite. The active pill still
 * reads as selected, so it looks like a chosen view rather than a dead control.
 */
function TabButton({ active, onClick, icon: Icon, label }: {
  active: boolean; onClick: () => void; icon: typeof Droplets; label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors ${
        active
          ? "bg-gradient-to-r from-magnet-600 to-magnet-500 text-white shadow-lg shadow-magnet-900/40"
          : "text-white/60 hover:text-white"
      }`}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {label}
    </button>
  );
}

/**
 * PEX's income APR, with its own split and the benchmark beneath it.
 *
 * Labelled "Fees + yield APR" because that is what PEX calls it and what it
 * contains; they explicitly forbid calling either figure APY, and forbid adding
 * the APR to the period return. `stats === null` renders "—", never 0% — their
 * instruction and the failure mode that matters most here.
 */
function YieldFigure({ stats, stale }: { stats: PoolStats | null; stale: boolean }) {
  const i = stats?.income ?? null;
  const r = stats?.ret ?? null;
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
          Fees + yield APR
        </span>
        <span className="text-[9.5px] text-gray-600">past 7d · PEX</span>
      </div>
      <div className="mt-0.5 flex items-baseline gap-2">
        <span className="font-mono text-[32px] font-semibold leading-none tracking-tight text-white">
          {pct(i?.totalPct ?? null)}
        </span>
        {stale && (
          <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[9.5px] font-semibold text-amber-300">
            STALE
          </span>
        )}
      </div>
      <p className="mt-1.5 text-[11px] text-gray-400">
        {i
          ? <>{pct(i.feePct)} fees + {pct(i.yieldPct)} yield{i.missingEvents > 0 && (
              <span className="text-amber-300/90"> · {i.missingEvents} unvalued events</span>
            )}</>
          : "PEX has not published a rate for this pool"}
      </p>
      {/* The benchmark: the one number that answers "would I have been better
          off just holding the two assets?" It includes trader P&L, which the
          APR above explicitly does not. */}
      {r ? (
        <p className="mt-1 text-[11px] text-gray-400">
          <span className={r.vsHoldingPoints >= 0 ? "text-gray-200" : "text-amber-300/90"}>
            {r.vsHoldingPoints >= 0 ? "+" : ""}{r.vsHoldingPoints.toFixed(2)}pp
          </span>{" "}
          {benchmarkLabel(r.benchmarkKind)} over {r.period}
          {r.hasGaps && <span className="text-amber-300/90"> · gaps in history</span>}
        </p>
      ) : (
        <p className="mt-1 text-[11px] text-gray-500">
          {stats?.retUnavailableReason === "insufficient_history"
            || stats?.retUnavailableReason === "no_valid_completed_samples"
            ? "Insufficient history for a return"
            : "Return unavailable"}
        </p>
      )}
    </div>
  );
}

/**
 * The empty cell in a two-up grid.
 *
 * Rendered LAST, always, so it absorbs whatever hole the row count leaves: one
 * strategy puts it beside the C-Vault, three put it beside BTC/USD in the
 * second row. Either way the grid reads as deliberate rather than as a card
 * that failed to load — which is what the bare gap looked like.
 *
 * Deliberately not a tease. It names the two things actually queued in
 * strategy/pools/OVERVIEW.md and says the honest thing about each: PactFi's
 * CLMM is waiting on PactFi, and the structured vaults are not designed yet.
 * A "coming soon" with no content behind it is worse than an empty cell.
 */
function NextStrategyTile() {
  return (
    <div className="flex min-h-[220px] flex-col justify-center rounded-2xl border border-dashed border-white/[0.09] bg-white/[0.012] p-6 text-center">
      <Sparkles className="mx-auto h-5 w-5 text-gray-600" aria-hidden="true" />
      <p className="mt-3 text-sm font-semibold text-gray-400">More strategies coming</p>
      <p className="mx-auto mt-1.5 max-w-[22rem] text-[11.5px] leading-relaxed text-gray-600">
        Concentrated liquidity on PactFi, once they release the platform, and
        structured vaults of our own. Neither is built yet — this space is held,
        not promised.
      </p>
    </div>
  );
}

/**
 * The C-Vault's rate, in the metric box the token pages use.
 *
 * Same frame as PoolsSection's "Total 7-Day APR" headline — `rounded-xl
 * border-white/5 bg-black/30 p-4`, uppercase label, `font-mono text-3xl
 * font-bold text-green-400`, components in a small row beneath. Matching it
 * exactly is the point: an APR should look the same wherever this site shows
 * one, and a bespoke treatment here made /strategy read as a different site.
 *
 * `text-green-400` is that green, from STAT_TONES. An earlier version used lime
 * — close enough to look like a mistake and far enough to be one.
 *
 * The direct pool cards keep `YieldFigure` above: this is the card the page is
 * built around, and three identical headline boxes rank nothing.
 */
function CvaRateBox({ stats, stale }: { stats: PoolStats | null; stale: boolean }) {
  const i = stats?.income ?? null;
  /**
   * The headline is the LONGEST window annualised — never a short one. The
   * same vault read 2026-10-28 gave +812% from 7 days and **−26% from 30**,
   * so the window choice moves the answer more than the vault does. The
   * shorter windows render beneath precisely so that dispersion is visible
   * rather than hidden behind one flattering figure.
   */
  const ann = pickLongest(stats);
  return (
    <div className="rounded-xl border border-white/5 bg-black/30 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[11px] uppercase tracking-wider text-gray-500">
          {ann ? "Annualised performance" : "Fees + Yield APR"}
        </p>
        <span className="text-[10px] text-gray-600">
          {ann ? `derived · past ${Math.round(ann.days)}d` : "past 7d · PEX"}
        </span>
      </div>
      <div className="mt-1 flex items-baseline gap-2.5">
        <p className={`font-mono text-3xl font-bold ${
          ann && ann.annualisedPct < 0 ? "text-red-300" : "text-green-400"
        }`}>
          {ann
            ? `${ann.annualisedPct >= 0 ? "+" : ""}${ann.annualisedPct.toFixed(0)}%`
            : pct(i?.totalPct ?? null, 2)}
        </p>
        {stale && (
          <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[9.5px] font-semibold text-amber-300">
            STALE
          </span>
        )}
      </div>
      {/* The realised figure is the FACT; the headline above is derived from
          it. It travels directly beneath so the two are never separated — see
          the long note on `pickLongest` in pools/performance.ts. */}
      {ann && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-gray-400">
          From{" "}
          <strong className="font-semibold text-gray-200">
            {ann.realisedPct >= 0 ? "+" : ""}{ann.realisedPct.toFixed(2)}%
          </strong>{" "}
          actually realised over {Math.round(ann.days)} days — the longest window
          PEX publishes. <span className="text-gray-500">Not a forecast.</span>
        </p>
      )}

      {/*
        ── Three sources, named and not quantified ──
        A depositor arriving at this card is asking two things: what is the
        strategy, and what does it return. Every extra figure competes with
        that. So the breakdown is qualitative here and quantified in the About
        modal, where someone has opted into detail.

        Ordered by actual contribution, measured 2026-10-28: trader P&L is
        ~96% of what the vault adds, ALGO's price is the entire source of the
        swing between windows, and swap fees are 0-3% of income — $0.00 on
        BTC/USD over the measured week. Listing fees first, as this page used
        to, put the smallest term in the most prominent position.
      */}
      <div className="mt-2.5 text-[11px] leading-relaxed text-gray-400">
        <span className="text-gray-500">Comes from</span>{" "}
        earnings from losing trades, ALGO/USDC price movement, and swap fees.
      </div>

      {/* The shorter windows, shown as REALISED returns and never annualised.
          This row is the third condition the headline rests on: a reader who
          sees −2.38% over 30 days beside it cannot mistake the big number for
          a promise. Removing this row makes the headline indefensible. */}
      <div className="mt-3 border-t border-white/[0.07] pt-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[11px] text-gray-500">Realised</span>
          <span className="flex items-baseline gap-3.5">
            {(["7d", "30d", "90d"] as const).map((p) => {
              const w = stats?.returns[p];
              return (
                <span key={p} className="flex items-baseline gap-1">
                  <span className="text-[10px] text-gray-600">{p}</span>
                  <span className={`font-mono text-[12px] font-semibold ${
                    !w ? "text-gray-600" : w.productPct >= 0 ? "text-green-400" : "text-red-300"
                  }`}>
                    {w ? `${w.productPct >= 0 ? "+" : ""}${w.productPct.toFixed(2)}%` : "—"}
                  </span>
                </span>
              );
            })}
          </span>
        </div>
        {!ann && (
          <p className="mt-1.5 text-[10.5px] text-gray-500">
            {stats?.retUnavailableReason === "insufficient_history"
              || stats?.retUnavailableReason === "no_valid_completed_samples"
              ? "Not enough history to annualise yet."
              : "Return history unavailable."}
          </p>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10.5px] text-gray-500">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm text-gray-200">{value}</dd>
    </div>
  );
}

/** ALGO vs USDC split. Lightness differs as well as hue, so it reads without colour. */
function Composition({ longShare, longLabel, shortLabel }: {
  longShare: number | null; longLabel: string; shortLabel: string;
}) {
  if (longShare === null) {
    return <p className="text-[10.5px] text-gray-500">Pool is empty — no composition to show.</p>;
  }
  const l = Math.round(longShare * 100);
  return (
    <div>
      <div className="mb-1.5 flex justify-between text-[10.5px] text-gray-500">
        <span>Composition</span>
        <span className="font-mono">{l}% / {100 - l}%</span>
      </div>
      <div className="flex h-[7px] overflow-hidden rounded-full bg-white/[0.06]">
        <div className="bg-amber-400" style={{ width: `${l}%` }} />
        <div className="bg-sky-400" style={{ width: `${100 - l}%` }} />
      </div>
      <div className="mt-1.5 flex gap-3.5 text-[10.5px] text-gray-400">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-[7px] w-[7px] rounded-sm bg-amber-400" />{longLabel}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-[7px] w-[7px] rounded-sm bg-sky-400" />{shortLabel}
        </span>
      </div>
    </div>
  );
}

function CardShell({ children }: { children: React.ReactNode }) {
  return <Panel glowClass={MAGNET_GLOW} className="p-5">{children}</Panel>;
}

export function LiquidityView() {
  const { algodClient, address, signTransactions, isConnected } = useWallet();
  /**
   * ── Only the C-Vault is public ──
   * The two direct market pools are admin-only for now. Not because they are
   * unfinished — both paths are built, asserted, simulated and ALGO/USD has
   * real signatures behind it — but because the C-Vault is the product going
   * in front of users first, and a page offering three destinations invites a
   * choice nobody has been given the context to make.
   *
   * Gating is COSMETIC and deliberately so. Everything here is a PEX call
   * signed by the user's own wallet; anyone can deposit to either pool through
   * PEX directly, and `isAdmin` hides a card rather than guarding an
   * authority. Real authority lives in the contracts' own admin checks. Same
   * pattern and same address as /magnetfi and /contact.
   */
  const isAdmin = isConnected && address === MAGNETFI_ADMIN_ADDRESS;
  const [showPools, setShowPools] = useState(false);
  /** The direct pools render only for an admin who has opened them. */
  const showDirect = isAdmin && showPools;
  const [data, setData] = useState<StrategyLiquidity | null>(null);
  const [perf, setPerf] = useState<PerformanceBundle | null>(null);
  /**
   * Held in state because the deposit form needs it for the $5 minimum.
   *
   * Cleared on a failed read alongside `data`, for the same reason: the minimum is
   * better not enforced than enforced against a stale price, and a dollar hint
   * from before is worse than none.
   */
  const [algoUsd, setAlgoUsd] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!algodClient) return;
    try {
      // ALGO price: the short leg is USDC so it needs no mark, but the long leg
      // does. Same source the terminal's chart strip already uses.
      const r = await fetch("https://api.exchange.coinbase.com/products/ALGO-USD/ticker");
      const algoUsd = Number((await r.json()).price);
      if (!Number.isFinite(algoUsd) || algoUsd <= 0) throw new Error("no ALGO price");
      setAlgoUsd(algoUsd);
      setData(await readStrategyLiquidity(algodClient, algoUsd, address));
      setErr(null);
      /**
       * PEX's own statistics, fetched separately and allowed to fail alone.
       *
       * This is the authoritative APR and the only source of the benchmark
       * comparison. It replaced a figure we derived on chain which read 15.3%
       * against a real 4.83% — that derivation annualised fees since inception
       * while trading had slowed 4.1x, and omitted yield income, which is the
       * larger half here.
       *
       * Unsigned by design ("trusted through HTTPS/storage delivery"), so it is
       * attributed to PEX in the UI and never mixed with chain reads. Its own
       * failure does not blank the pool sizes, which ARE chain reads.
       */
      try {
        setPerf(await fetchPerformanceBundle("30d"));
      } catch {
        // A 404 "must not be presented as zero performance" — so the figure is
        // absent, and the pool data stands on its own.
        setPerf(null);
      }
    } catch (e) {
      // `data` is CLEARED, not left standing.
      //
      // This previously set `err` and kept the last successful read on screen,
      // under a banner reading "Figures below are omitted rather than
      // guessed" — directly contradicted by the figures below it. The path is
      // easy to hit: the page loads, the user connects a wallet, `load` re-runs
      // because `address` is a dependency, the ALGO price fetch 429s, and every
      // pool size and share price on screen is now from before.
      setData(null);
      setPerf(null);
      setAlgoUsd(null);
      setErr(e instanceof Error ? e.message : "Could not read pool state");
    }
  }, [algodClient, address]);
  useEffect(() => { void load(); }, [load]);

  const m = (id: "algo-usd" | "btc-usd") => data?.markets.find((x) => x.id === id) ?? null;
  const [tab, setTab] = useState<Tab>("pools");

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      {/* A SIBLING of the content, never a parent of it: the splash blurs the
          live page behind it, and an ancestor with a running opacity animation
          becomes a backdrop root, leaving it blurring nothing. Same placement
          as /magnetfi — see ArrivalSplash's header. */}
      <StrategySplash />
      {/*
        ── No page header, and no headline metrics ──
        This carried an h1 reading "Strategy", a paragraph about traders on the
        terminal, and two boxes totalling PEX pool liquidity and PEX fees to
        date. All four were written when this page WAS the PEX liquidity page.

        It is the strategies page now, and a header describing one venue
        misdescribes the rest as they arrive: a CLMM pool on PactFi earns
        nothing from "traders on the terminal", and adding its TVL into a single
        "total liquidity" beside PEX would be summing unlike things. The splash
        above already says "Strategy", exactly as /magnetfi relies on its own.

        Per-venue figures belong on the card for that venue, which is where the
        C-Vault's are.
      */}

      {err && (
        <div className="mb-6 flex items-start gap-2 rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-xs text-red-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Could not read pool state: {err}. Figures below are omitted rather than guessed.</span>
        </div>
      )}

      <div className="animate-enter mb-7 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-full border border-white/10 bg-black/40 p-1 backdrop-blur-sm">
          <TabButton
            active={tab === "pools"}
            onClick={() => setTab("pools")}
            icon={Droplets}
            label="Pools"
          />
        </div>
        {/* Amber, like every other "this is not ordinary browsing" control in
            the app. Pressed-in when open, so the row shows its own state. */}
        {isAdmin && (
          <button
            onClick={() => setShowPools((v) => !v)}
            aria-pressed={showPools}
            className={showPools ? RAISED_AMBER_ON : RAISED_AMBER}
          >
            <Shield className="h-3.5 w-3.5" /> Direct pools
          </button>
        )}
      </div>

      {/*
        TWO PER ROW, always — not a column count that tracks how many cards
        happen to exist today.
        ──────────────────────────────────────────────────────────────────────
        More strategies are coming, and the two previous versions of this both
        failed by sizing to the current contents: three columns left two
        obvious holes once the direct pools went admin-only, and the single
        `max-w-2xl` column that replaced it gave one card a 42rem span it had
        no content to fill. A fixed two-up grid means a new strategy lands
        beside this one without touching the layout.

        The whole column is capped at `max-w-5xl` and the CAVEAT is inside it,
        because the two have to share a width: a card above a full-bleed amber
        panel made the warning the largest object on the page. Both checked by
        rasterising, not by reasoning about it.
      */}
      <div className="max-w-5xl">
      <div className="grid gap-5 md:grid-cols-2">
        {/* ── C-Vault ──
            The hero card: it is the only product the public sees, so it gets
            the display heading, the drifting blob and the green rate box. The
            two admin pool cards keep the quieter treatment they had — a page
            where everything glows ranks nothing. */}
        <CardShell>
          {/* Behind the content and non-interactive, same as SectionHero's.
              The Panel already clips (`overflow-hidden`), so it cannot bleed
              past the rounded corner. */}
          <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
            <div className="animate-blob-drift absolute -right-20 -top-20 h-56 w-56 rounded-full bg-magnet-600/20 blur-3xl" />
          </div>

          <div className="relative flex flex-col gap-4">
            {/* Title, subtitle and the two things attached to them on one row.
                `glow-text-card` rather than `magnet-glow-soft` or `glow-text`:
                the first is a drop-shadow filter tuned for the hero LOGO and
                produced no visible halo here at all, and the second's 24/55px
                radii are tuned for a 48-60px splash title and dilute at
                heading size. The card variant has the same hue family with
                tighter radii. All three were rasterised and compared; only
                this one reads as a glow on a 22px heading. */}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Layers className="h-5 w-5 shrink-0 text-magnet-400" aria-hidden="true" />
                  <h2 className="glow-text-card font-display text-[22px] font-bold tracking-tight text-white">
                    C-Vault Strategy
                  </h2>
                </div>
                <p className="mt-1.5 text-[11.5px] text-gray-500">Managed by PEX · spans both markets</p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-2">
                <span className="rounded-full border border-magnet-500/30 bg-magnet-500/10 px-2.5 py-0.5 text-[10px] font-semibold text-magnet-300">
                  AUTO
                </span>
                {/* Beside the title, not on a row of its own: a lone pill under
                    the heading read as an orphan with a band of dead space
                    around it, which was most of the "empty" in this card. */}
                <CvaAbout
                  stats={perf?.byKey[cvaKey(PEX_APPS.cvaVault)] ?? null}
                  stale={!!perf?.stale}
                />
              </div>
            </div>

            {/* PEX publishes the vault's own APR under its own key, so no
                blending of ours is needed — and theirs follows the vault's
                historical ownership and counts idle capital in the
                denominator, which ours could not. */}
            <CvaRateBox
              stats={perf?.byKey[cvaKey(PEX_APPS.cvaVault)] ?? null}
              stale={!!perf?.stale}
            />

            {/*
              ── Why "Your position" is dollars and shares both ──
              Shares are what the contract holds and what a withdrawal burns;
              dollars are the only unit a depositor thinks in. Showing one
              without the other means either a number nobody can value, or a
              value with nothing behind it. `yourUsd` is priced at the
              CONTRACT's own NAV per share, which is the same basis the
              withdraw form below spends against — see the note in reads.ts.

              Two rows of two with a rule between the pool's figures and
              yours: they are different subjects, and a flat 2x2 grid of four
              equal cells made the reader work out which was which.
            */}
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
              <Stat label="Pool liquidity" value={usd(data?.cva.navUsd ?? null)} />
              <Stat label="Shares outstanding" value={num(data?.cva.totalShares ?? null, 2)} />
            </dl>
            <div className="h-px bg-white/[0.07]" />
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
              <Stat
                label="Your position"
                value={data?.cva.yourUsd != null ? usd(data.cva.yourUsd, 2) : "—"}
              />
              <Stat label="Your shares" value={num(data?.cva.yourShares ?? null, 4)} />
            </dl>

            <div className="rounded-lg border border-white/[0.06] bg-black/30 px-3 py-2.5 text-[10.5px] leading-relaxed text-gray-500">
              Takes <strong className="font-semibold text-gray-300">ALGO + USDC</strong>. You do not pick a
              market — the vault allocates across both and rebalances itself.
              {/* The managed option is the only one with a fixed entry/exit cost
                  and a lock, and a page comparing three destinations that showed
                  its APR but not its spread would flatter it. Values are PEX's
                  own globals on app 3690309167.

                  "Stays in the vault" is verified, not assumed — see the long
                  note in CvaAbout.tsx. It reads as a fee to a third party
                  otherwise, which is the opposite of what it is. */}
              <span className="mt-1.5 block text-gray-400">
                Costs <strong className="font-semibold text-gray-300">0.2% in and 0.2% out</strong> —
                which <strong className="font-semibold text-gray-300">stays in the vault</strong>,
                not paid to PEX. Plus a ~1 hour withdrawal cooldown and a $5 minimum withdrawal.
                The direct pools have no such spread.
              </span>
            </div>

            <CvaActions
              algoUsd={algoUsd}
              algod={algodClient ?? null}
              address={address ?? null}
              signTransactions={signTransactions ?? null}
              onDone={() => void load()}
            />
          </div>
        </CardShell>

        {/* ── the two market pools ── */}
        {showDirect && (["algo-usd", "btc-usd"] as const).map((id) => {
          const mk = m(id);
          const slice = data && mk ? cvaShareOfMarket(data, mk.marketId) : null;
          return (
            <CardShell key={id}>
              <div className="flex flex-col gap-4">
                <div className="flex items-start justify-between gap-2.5">
                  <div>
                    <div className="flex items-center gap-2">
                      {id === "algo-usd"
                        ? <Coins className="h-5 w-5 shrink-0 text-magnet-400" aria-hidden="true" />
                        : <TrendingUp className="h-5 w-5 shrink-0 text-magnet-400" aria-hidden="true" />}
                      <h2 className="text-[17px] font-bold text-white">
                        {mk?.label ?? (id === "algo-usd" ? "ALGO/USD" : "BTC/USD")}
                      </h2>
                    </div>
                    <p className="mt-1.5 text-[11.5px] text-gray-500">
                      Direct LP · market {mk?.marketId ?? (id === "algo-usd" ? 1 : 2)}
                      {mk?.synthetic ? " · synthetic" : ""}
                    </p>
                  </div>
                  {slice !== null && (
                    <span className="shrink-0 rounded-full border border-magnet-500/30 bg-magnet-500/10 px-2.5 py-0.5 text-[10px] font-semibold text-magnet-300">
                      {Math.round(slice * 100)}% C-VAULT
                    </span>
                  )}
                </div>

                <YieldFigure
                  stats={mk ? (perf?.byKey[marketKey(mk.marketId)] ?? null) : null}
                  stale={!!perf?.stale}
                />

                <div className="h-px bg-white/[0.07]" />

                <dl className="grid grid-cols-2 gap-x-3 gap-y-3">
                  <Stat label="Pool size" value={usd(mk?.value.totalUsd ?? null)} />
                  <Stat label="Pool / share" value={usd(mk?.poolValuePerShare ?? null, 4)} />
                  <Stat label="Your shares" value={num(mk?.yourShares ?? null, 4)} />
                  <Stat label="Share supply" value={num(mk?.shareSupply ?? null, 0)} />
                </dl>

                {/* Open interest against PEX's admin-set cap. Without this a
                    depositor cannot see that a market is full — market 1 sat at
                    99.8% of its cap when this shipped, so capital added there
                    bought almost no additional tradable size. */}
                {mk && (
                  <div>
                    <div className="mb-1.5 flex justify-between text-[10.5px] text-gray-500">
                      <span>Long OI vs PEX cap</span>
                      <span className="font-mono">
                        {usd(mk.oi.longUsd)} / {usd(mk.oi.capLongUsd)}
                      </span>
                    </div>
                    <div className="flex h-[7px] overflow-hidden rounded-full bg-white/[0.06]">
                      <div
                        className={mk.oi.utilisation !== null && mk.oi.utilisation > 0.9
                          ? "bg-amber-400" : "bg-magnet-500"}
                        style={{ width: `${Math.min(100, (mk.oi.utilisation ?? 0) * 100)}%` }}
                      />
                    </div>
                    {mk.oi.utilisation !== null && mk.oi.utilisation > 0.9 && (
                      <p className="mt-1.5 text-[10.5px] leading-relaxed text-amber-300/90">
                        This market is at {pct(mk.oi.utilisation * 100, 0)} of its cap. The cap is set
                        by PEX and a deposit does not raise it.
                      </p>
                    )}
                  </div>
                )}

                {/* Suppressed, not footnoted, when the legs are not what we
                    think: `micro()` assumes 6 decimals on both and the long leg
                    is priced as ALGO, so a changed asset makes the bar and the
                    pool size confidently wrong rather than slightly off. */}
                {mk && !mk.legsVerified ? (
                  <div className="rounded-lg border border-amber-400/30 bg-amber-400/[0.07] px-3 py-2.5 text-[10.5px] leading-relaxed text-amber-200">
                    This market&apos;s assets no longer read as ALGO/USDC on chain, so the
                    composition and pool size are not shown — they would be wrong rather than
                    approximate.
                  </div>
                ) : (
                <Composition
                  longShare={mk?.value.longShare ?? null}
                  longLabel={mk ? `${num(mk.legs.longAmount)} ALGO` : "ALGO"}
                  shortLabel={mk ? `${num(mk.legs.shortAmount)} USDC` : "USDC"}
                />
                )}

                <div className="rounded-lg border border-white/[0.06] bg-black/30 px-3 py-2.5 text-[10.5px] leading-relaxed text-gray-500">
                  {mk?.syntheticVerified
                    ? <>BTC exposure, backed with <strong className="font-semibold text-gray-300">ALGO + USDC</strong> — there is no BTC in this pool.</>
                    : <>Takes <strong className="font-semibold text-gray-300">ALGO + USDC</strong>, both legs.</>}
                </div>

                {mk && (
                  <LiquidityActions
                    marketId={mk.marketId}
                    label={mk.label}
                    algoUsd={algoUsd}
                    poolValuePerShare={mk.poolValuePerShare}
                    algod={algodClient ?? null}
                    address={address ?? null}
                    signTransactions={signTransactions ?? null}
                    onDone={() => void load()}
                  />
                )}
              </div>
            </CardShell>
          );
        })}
        {/* Last child, so it fills whichever cell the row count leaves open. */}
        <NextStrategyTile />
      </div>

      {/*
        ── The amber caveat panel is gone ──
        It explained PEX's APR basis, the unsigned feed and the missing audit —
        all true, all PEX-specific, and all of it under a page that now hosts
        more than PEX. Nothing was dropped: every claim moved into the C-Vault's
        own About modal under "What you carry", which is where a reader deciding
        about THAT product actually is. Check there before assuming a disclosure
        was lost.
      */}
      </div>
    </div>
  );
}
