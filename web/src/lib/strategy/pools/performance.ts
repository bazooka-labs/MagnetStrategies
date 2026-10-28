/**
 * PEX's own pool statistics, from the public R2 bundle.
 *
 * Added 2026-10-21, after Ultrade published the feed. It replaces a fee APR we
 * derived on chain, and the replacement is not a refinement — the derived
 * figure was WRONG in the direction we claimed it was not:
 *
 *     ALGO/USD   derived 15.3%   PEX fee APR 4.83%   PEX total 11.22%
 *
 * That derivation annualised fees since inception against the current pool.
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
  /** True when any point has missing history before it. */
  hasGaps: boolean;
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
