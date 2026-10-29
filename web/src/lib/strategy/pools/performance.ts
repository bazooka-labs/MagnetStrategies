/**
 * PEX's own pool statistics, from the public R2 bundle.
 *
 * Added 2026-10-21, after Ultrade published the feed. It replaces a fee APR we
 * derived on chain, and the replacement is not a refinement — the derived
 * figure was WRONG in the direction we claimed it was not:
 *
 *     ALGO/USD   derived 15.3%   PEX fee APR 4.83%   PEX total 11.22%
 *
 * That derivation annualized fees since inception against the current pool.
 * Trading has since slowed 4.1x ($1.088/day averaged over 48.9 days, against
 * $0.268/day over the last seven), so an inception average overstates the rate
 * a depositor would actually earn today by 3.2x. It also omitted yield income
 * entirely, which on these pools is the LARGER half (6.39% against 4.83%).
 *
 * ── Why this is fetched here rather than through the SDK ──
 * SDK 0.6.10 adds `loadPoolPerformanceBundleFromR2`, but our SDK is vendored at
 * 0.6.6 and `vendor/README.md` is explicit: "Do not bump this in isolation" —
 * `PEX_SDK_VERSION`, the pinned program hashes and the solver verification all
 * move with it, and the closed-form solver is checked against
 * `quoteV2OpenPosition`. Bumping the SDK to read a JSON file would put the
 * terminal's trading maths in scope for a liquidity-page feature. The loader is
 * a fetch plus validation, so it is reimplemented here with the same contract.
 *
 * ── The trust model, stated because it differs from everything else we read ──
 * PEX documents this feed as "unsigned and trusted through HTTPS/storage
 * delivery", and that `manifest_sha256` "identifies the deployment context; it
 * is not a signature or integrity proof for the data". Our oracle bundle IS
 * signed and we verify it per-payload; this is not, and cannot be.
 *
 * That is acceptable because nothing here reaches a transaction: these numbers
 * are displayed, never signed against. It is NOT acceptable to present them as
 * equivalent in confidence to a chain read, so the UI attributes them to PEX
 * and the envelope checks below are the only integrity we have.
 */

const BUNDLE_URL =
  "https://pub-1e72beea87f04ebfafce248132310425.r2.dev/mainnet/v2/pool-performance/mainnet/current.json";

/** The one `apr_basis` PEX says is displayable. Anything else is unavailable. */
const REQUIRED_APR_BASIS = "historical_capital_v1";
const EXPECTED_TYPE = "v2_pool_performance_bundle_current";
const EXPECTED_NETWORK = "mainnet";
const EXPECTED_PATH = "v2/pool-performance/mainnet/current.json";

export type PerfPeriod = "7d" | "30d" | "90d" | "total";

export type IncomeApr = {
  /** Fee + yield, the headline. Percent. */
  totalPct: number;
  feePct: number;
  yieldPct: number;
  feeUsd7d: number;
  yieldUsd7d: number;
  /** Unix seconds — the window the APR actually covers. */
  windowStart: number;
  windowEnd: number;
  /** Income events PEX could not value. Non-zero means incomplete coverage. */
  missingEvents: number;
};

export type PoolReturn = {
  period: PerfPeriod;
  /** Share-price change over the period, percent. Includes trader P&L. */
  productPct: number;
  /** The benchmark's return over the same period, percent. */
  holdPct: number;
  /** Additive percentage POINTS against the benchmark, not a ratio. */
  vsHoldingPoints: number;
  /** `geometric_mean_50_50` or `single_asset` — changes the label. */
  benchmarkKind: string;
  /** Completed daily observations behind it. */
  points: number;
  /**
   * Days actually spanned by the observations, first timestamp to last.
   *
   * NOT the period label: the bundle's "90d" window currently holds 55 days
   * because that is all the history the vault has. Annualizing against the
   * label rather than the span would understate the rate by whatever the gap
   * is — on today's data, 17.00% over a claimed 90 days reads 89% instead of
   * the true 183%.
   */
  days: number;
  /** True when any point has missing history before it. */
  hasGaps: boolean;
  /**
   * The index series behind the summary, for charting.
   *
   * Both indices start at 1.0 on the window's first day, so they plot
   * directly against each other: `product` is the vault, `hold` is what the
   * two assets would have done. Kept because the chart is the only place a
   * depositor can SEE that the benchmark fell harder than the vault in the
   * losing month — a number cannot show that shape.
   */
  series: { ts: number; product: number; hold: number }[];
  /**
   * Share price on the window's FIRST day, and that day's timestamp.
   *
   * The anchor that lets the annualized figure refresh faster than the bundle
   * does. PEX republishes once a day at 00:10 UTC, but the share price itself
   * moves on every re-mark — so pairing this historical start with the LIVE
   * price extends the window to "now" instead of to midnight.
   *
   * Crucially this does not shorten the window, which is what would
   * reintroduce the short-window volatility the headline is designed around.
   * It only moves the end point forward: 55 days becomes 57 and keeps growing.
   */
  startSharePrice: number | null;
  startTs: number;
};

export const PERF_PERIODS: readonly PerfPeriod[] = ["7d", "30d", "90d", "total"];

export type PoolStats = {
  /** Null when apr_status is not ready, or the basis is one PEX says not to show. */
  income: IncomeApr | null;
  /** Null when PEX reported insufficient_history / no_valid_completed_samples. */
  ret: PoolReturn | null;
  /** PEX's reason string when `ret` is null, for display rather than a blank. */
  retUnavailableReason: string | null;
  /**
   * EVERY window PEX published, not just the selected one.
   *
   * The card shows one period; the About modal shows the ladder, because a
   * single window is exactly what makes a pool's record easy to misread — the
   * C-Vault's 7d and 90d returns were +2.90% and +15.27% on the same day.
   * A period absent here is one PEX did not publish or could not compute;
   * `reasons` says which.
   */
  returns: Partial<Record<PerfPeriod, PoolReturn>>;
  reasons: Partial<Record<PerfPeriod, string>>;
};

export type PerformanceBundle = {
  /** UTC midnight cutoff the figures are as of. */
  asOf: number;
  updatedAt: number;
  expiresAt: number;
  sourceRound: number;
  /** True past `expires_at`: show it WITH its date and a stale label, not hidden. */
  stale: boolean;
  byKey: Record<string, PoolStats>;
};

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/** bps → percent. PEX: "divide by 100 to display a percentage: 1250 means 12.5%." */
const pct = (bps: unknown): number | null => {
  const n = num(bps);
  return n === null ? null : n / 100;
};

function parseIncome(raw: unknown): IncomeApr | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  // PEX: "Display APR only when status is ready and basis is
  // historical_capital_v1; missing/non-ready values mean unavailable, not 0%."
  if (o.apr_status !== "ready" || o.apr_basis !== REQUIRED_APR_BASIS) return null;
  const total = pct(o.total_apr_7d_bps);
  const fee = pct(o.fee_apr_7d_bps);
  const yld = pct(o.yield_apr_7d_bps);
  if (total === null || fee === null || yld === null) return null;
  return {
    totalPct: total, feePct: fee, yieldPct: yld,
    feeUsd7d: (num(o.fee_usd_7d) ?? 0) / 1_000_000,
    yieldUsd7d: (num(o.yield_usd_7d) ?? 0) / 1_000_000,
    windowStart: num(o.apr_window_start) ?? 0,
    windowEnd: num(o.apr_window_end) ?? 0,
    missingEvents: num(o.apr_missing_events) ?? 0,
  };
}

function parseReturn(raw: unknown, period: PerfPeriod): {
  ret: PoolReturn | null; reason: string | null;
} {
  if (!raw || typeof raw !== "object") return { ret: null, reason: "unavailable" };
  const o = raw as Record<string, unknown>;
  // PEX names insufficient_history and no_valid_completed_samples as VALID
  // results to surface, not errors to swallow.
  if (typeof o.reason === "string" && o.reason) return { ret: null, reason: o.reason };
  const pts = Array.isArray(o.points) ? o.points : [];
  // "fewer than two points exist -> show Insufficient history, not the
  // placeholder zero returns as 0% performance."
  if (pts.length < 2) return { ret: null, reason: "insufficient_history" };
  const sm = (o.summary ?? {}) as Record<string, unknown>;
  const bm = (o.benchmark ?? {}) as Record<string, unknown>;
  const product = pct(sm.product_return_bps);
  const hold = pct(sm.hold_return_bps);
  const vs = pct(sm.vs_holding_bps);
  if (product === null || hold === null || vs === null) {
    return { ret: null, reason: "insufficient_history" };
  }
  return {
    ret: {
      period, productPct: product, holdPct: hold, vsHoldingPoints: vs,
      benchmarkKind: typeof bm.kind === "string" ? bm.kind : "unknown",
      points: pts.length,
      series: pts.map((raw) => {
        const o = raw as Record<string, unknown>;
        return {
          ts: num(o.timestamp) ?? 0,
          product: (num(o.product_index) ?? 0) / 1e6,
          hold: (num(o.hold_index) ?? 0) / 1e6,
        };
      }).filter((pt) => pt.ts > 0 && pt.product > 0 && pt.hold > 0),
      startSharePrice: (() => {
        const raw = (pts[0] as Record<string, unknown>)?.share_price_usd;
        const v = num(raw);
        return v !== null && v > 0 ? v / 1e6 : null;
      })(),
      startTs: num((pts[0] as Record<string, unknown>)?.timestamp) ?? 0,
      days: (() => {
        const t0 = Number((pts[0] as Record<string, unknown>)?.timestamp ?? 0);
        const t1 = Number((pts[pts.length - 1] as Record<string, unknown>)?.timestamp ?? 0);
        return t1 > t0 ? (t1 - t0) / 86_400 : 0;
      })(),
      hasGaps: pts.some((p) => !!(p as Record<string, unknown>)?.gap_before),
    },
    reason: null,
  };
}

export class PerformanceBundleError extends Error {}

/**
 * Validate and shape the bundle.
 *
 * Throws on a malformed or wrong-deployment bundle rather than returning
 * partial data — PEX's own loader "throws" on malformed data, and a bundle for
 * the wrong network silently displayed is worse than no figure.
 */
export function parsePerformanceBundle(
  raw: unknown, nowSec: number, period: PerfPeriod = "30d",
): PerformanceBundle {
  if (!raw || typeof raw !== "object") throw new PerformanceBundleError("bundle is not an object");
  const o = raw as Record<string, unknown>;
  if (o.network !== EXPECTED_NETWORK) {
    throw new PerformanceBundleError(`bundle network is ${String(o.network)}, expected ${EXPECTED_NETWORK}`);
  }
  if (o.type !== EXPECTED_TYPE) {
    throw new PerformanceBundleError(`bundle type is ${String(o.type)}, expected ${EXPECTED_TYPE}`);
  }
  // Self-consistency: the bundle names its own path, so a file served from the
  // wrong key is detectable even though nothing here is signed.
  if (o.current_path !== EXPECTED_PATH) {
    throw new PerformanceBundleError(`bundle current_path is ${String(o.current_path)}`);
  }
  const asOf = num(o.as_of);
  const expiresAt = num(o.expires_at);
  if (asOf === null || expiresAt === null) throw new PerformanceBundleError("missing as_of/expires_at");

  const payloads = (o.payloads ?? {}) as Record<string, unknown>;
  const byKey: Record<string, PoolStats> = {};
  for (const [k, v] of Object.entries(payloads)) {
    const p = (v ?? {}) as Record<string, unknown>;
    const perf = (p.performance ?? {}) as Record<string, unknown>;
    // Every window, so the About modal can show the ladder without a second
    // fetch. `ret` stays the selected one — the card is unchanged by this.
    const returns: Partial<Record<PerfPeriod, PoolReturn>> = {};
    const reasons: Partial<Record<PerfPeriod, string>> = {};
    for (const w of PERF_PERIODS) {
      const parsed = parseReturn(perf[w], w);
      if (parsed.ret) returns[w] = parsed.ret;
      if (parsed.reason) reasons[w] = parsed.reason;
    }
    byKey[k] = {
      income: parseIncome(p.income_apr),
      ret: returns[period] ?? null,
      retUnavailableReason: reasons[period] ?? null,
      returns,
      reasons,
    };
  }

  return {
    asOf, updatedAt: num(o.updated_at) ?? 0, expiresAt,
    sourceRound: num(o.source_round) ?? 0,
    // PEX: "an expired valid object returns stale: true so it can be displayed
    // with its date and an explicit stale label." Not hidden, not zeroed.
    stale: nowSec > expiresAt,
    byKey,
  };
}

/** Bundle key for a market pool, and for the CVA vault. */
export const marketKey = (marketId: number) => `market-${marketId}`;
export const cvaKey = (vaultAppId: number) => `cva-${vaultAppId}`;

export async function fetchPerformanceBundle(
  period: PerfPeriod = "30d", nowSec: number = Math.floor(Date.now() / 1000),
): Promise<PerformanceBundle> {
  // no-store: the file is regenerated daily around 00:10 UTC and carries its
  // own expiry, so a CDN-cached copy would defeat the staleness check.
  const res = await fetch(BUNDLE_URL, { cache: "no-store" });
  if (!res.ok) {
    // PEX: "a 404 must not be presented as zero performance."
    throw new PerformanceBundleError(`performance bundle HTTP ${res.status}`);
  }
  return parsePerformanceBundle(await res.json(), nowSec, period);
}

/** How a benchmark should be described. PEX forbids calling the paired one buy-and-hold. */
export function benchmarkLabel(kind: string): string {
  // "It is NOT a literal buy-and-hold 50/50 basket: if one asset doubles and
  // the other is unchanged, the benchmark gains about 41.42%, while that basket
  // gains 50%." So it is never labelled "vs holding" when it is the geometric one.
  return kind === "geometric_mean_50_50" ? "vs 50/50 geometric benchmark" : "vs holding";
}

/**
 * The longest window with real history, and its return annualized.
 *
 * ── Why this exists, and the argument against it ──
 * Annualizing a realised return is NOT a rate. The same vault on the same day
 * gives wildly different answers depending on the window chosen — measured
 * 2026-10-28: +812% from 7 days, **−26% from 30 days**, +183% from 55. The
 * number is as much a statement about the window as about the vault, and this
 * repo has already shipped that mistake once (a derived 15.3% APR against a
 * real 4.83%, removed — see the header of this file).
 *
 * It is displayed anyway, as a product decision, under three conditions that
 * are what make it defensible and must not be quietly dropped:
 *
 *   1. **Longest window only.** Short windows are the volatile ones; a seven-
 *      day headline would be indefensible. `pickLongest` enforces this.
 *   2. **The realised figure travels with it** — "+17.00% over 55 days" is the
 *      fact; the annualization is derived from it and labelled as such.
 *   3. **The shorter windows stay visible**, so a reader sees the dispersion
 *      rather than one flattering point. The card shows 7d/30d beneath it and
 *      the About modal carries the full ladder.
 *
 * Never annualize income APR with this — that figure is already a rate.
 */
export type AnnualizedReturn = {
  /** The window it came from. */
  period: PerfPeriod;
  /** Days actually spanned, not the period label. */
  days: number;
  /** The realised share-price return over those days, percent. A FACT. */
  realisedPct: number;
  /** What simply holding the two assets returned over the same days. A FACT. */
  holdPct: number;
  /**
   * PEX's own `vs_holding_bps` — how far the vault beat holding, in
   * percentage points. A FACT, and theirs rather than ours.
   *
   * This is the headline, because it is the only figure here that measures
   * the STRATEGY rather than the market. Measured 2026-10-28 the share-price
   * return across windows ran −2.38% to +17.00% while this ran +8.19 to
   * +11.37pp — the swing in the former is ALGO's price, which the vault does
   * not choose and a depositor can hedge.
   *
   * The 30-day window is the case that matters: the vault was DOWN 2.38%
   * while beating the benchmark by 10.04pp, because ALGO fell 12.42%. A
   * headline that cannot stay honest in that month is the wrong headline.
   */
  vsHoldingPoints: number;
  /** Compounded to a year, percent. This is DERIVED, and demoted on the card. */
  annualizedPct: number;
};

/**
 * What to call a window on screen.
 *
 * ── Why this is not just `days` ──
 * `days` is the ELAPSED SPAN — last sample minus first — because that is the
 * denominator compounding needs. Seven daily samples have six intervals
 * between them, so a full 7-day window measures `days === 6`.
 *
 * That is right for the arithmetic and wrong on a label. PEX's `7d` carries
 * exactly 7 daily samples and `30d` exactly 30 (verified against the live
 * bundle 2026-10-29); they are the 7- and 30-day windows, and every other
 * venue calls them that. Printing "6 days" and "29 days" made correct figures
 * look like off-by-one bugs.
 *
 * So: the publisher's own name when the data FILLS the window, the measured
 * span when it does not. `90d` holds 48 samples against a nominal 90 — short
 * by 42 — so calling it "90 days" would claim history this vault has never
 * had. It reads "56 days" and will say "90 days" on its own once there are 90
 * days to say it about.
 *
 * `total` has no nominal length, so it always reports its span.
 *
 * This is a LABEL. Nothing here feeds annualization, which keeps using the
 * elapsed span — compounding 15.27% over 57 days instead of 56 would quietly
 * understate the result.
 */
export function periodDays(r: PoolReturn): number {
  const nominal = /^(\d+)d$/.exec(r.period)?.[1];
  return nominal && r.points >= Number(nominal) ? Number(nominal) : Math.round(r.days);
}

export function periodLabel(r: PoolReturn): string {
  const d = periodDays(r);
  return `${d} day${d === 1 ? "" : "s"}`;
}

/**
 * The distinct windows PEX published, shortest first.
 *
 * Deduped by SPAN, because the bundle's period names outrun its history: with
 * 56 days recorded, `90d` and `total` are the same 48 points under two names,
 * and listing both padded the ladder with a duplicate row that looked like a
 * fourth data point. Measured 2026-10-29 both carried product_return_bps 1715.
 *
 * Keyed on the real elapsed span rather than the label, for the same reason
 * the headline annualizes the span: `7d` holds 7 daily samples spanning 6
 * days, and the return it reports is the 6 days of movement between them.
 */
export function holdingPeriods(stats: PoolStats | null): PoolReturn[] {
  const seen = new Map<number, PoolReturn>();
  for (const w of Object.values(stats?.returns ?? {})) {
    if (!w) continue;
    const key = Math.round(w.days);
    const prev = seen.get(key);
    // Prefer the denser series when two labels cover one span.
    if (!prev || w.points > prev.points) seen.set(key, w);
  }
  return [...seen.values()].sort((a, b) => a.days - b.days);
}

/** Days below which annualizing is refused outright, however it is labelled. */
export const MIN_ANNUALIZE_DAYS = 14;

export function pickLongest(
  stats: PoolStats | null,
  /**
   * The vault's live share price, `total_nav_usd / total_cva_shares`. When
   * given, the window runs from the bundle's first day to NOW rather than to
   * the bundle's last day — fresher by up to 24 hours, and refreshing on every
   * re-mark instead of once daily.
   *
   * The same basis the rest of the card uses, so the figures agree.
   */
  liveSharePrice?: number | null,
  nowSec: number = Math.floor(Date.now() / 1000),
): AnnualizedReturn | null {
  if (!stats) return null;
  // Longest first. `total` and `90d` are the same window until the vault has
  // more than 90 days of history, so either may be the longest.
  let best: PoolReturn | null = null;
  for (const p of PERF_PERIODS) {
    const r = stats.returns[p];
    if (r && r.days > (best?.days ?? 0)) best = r;
  }
  if (!best) return null;

  // Extend to now when we have both ends. Falls back to the bundle's own
  // summary whenever the live price or the start anchor is missing — a fresher
  // figure is worth having, never at the cost of inventing one.
  let days = best.days;
  let realised = best.productPct;
  if (liveSharePrice && liveSharePrice > 0 && best.startSharePrice && best.startTs > 0) {
    const extended = (nowSec - best.startTs) / 86_400;
    if (extended >= days) {
      days = extended;
      realised = (liveSharePrice / best.startSharePrice - 1) * 100;
    }
  }

  if (days < MIN_ANNUALIZE_DAYS) return null;
  const growth = 1 + realised / 100;
  // A total loss cannot be compounded; refuse rather than return NaN.
  if (growth <= 0) return null;
  return {
    period: best.period,
    days,
    realisedPct: realised,
    holdPct: best.holdPct,
    vsHoldingPoints: best.vsHoldingPoints,
    annualizedPct: (Math.pow(growth, 365 / days) - 1) * 100,
  };
}
