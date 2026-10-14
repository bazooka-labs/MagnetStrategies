/**
 * Is the posted LP price RIGHT? — an independent cross-check.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * Every other check on the oracle answers "is the price FRESH". `FeedWatch`
 * reads `lp_ts_` age, and `getOracleHealth`'s `level` is computed from age
 * alone. The one non-age signal there — distance to the contract's anchor band
 * — disappears with the lean oracle, because there is no anchor to measure
 * against.
 *
 * Nothing compares the number the vault actually borrows against to a source
 * outside our own pricing path. `check_algo_against_pex` in the bot comes
 * closest, but it validates the bot's own ALGO *input* against PEX, for ALGO
 * only, inside the bot process — not the posted LP price, and not per pool.
 *
 * The gap that matters is a price that is **wrong but fresh**. The specific
 * bug class: $U has 5 decimals, one digit from 6, and a one-sided decimals slip
 * puts the LP price at roughly 0.55x truth with every asset-price bound
 * satisfied, the multi-route cross-check green and CompX green — because all
 * three check *asset* prices, while the posted number comes out of
 * `compute_lp_price` and its three decimal divisions. A TWAP then faithfully
 * smooths a consistently wrong number into a borrow and liquidation input.
 *
 * ── How it is independent ─────────────────────────────────────────────────
 *     independent price = third-party pool TVL (USD) / issued LP tokens
 *
 * The numerator is Tinyman's own analytics figure and the denominator is read
 * from chain, so neither touches our asset prices, our decimals handling, our
 * route selection or our TWAP. A 0.55x error shows up as ~45% divergence.
 *
 * ── The thresholds are PROVISIONAL ────────────────────────────────────────
 * Measured against mainnet 2026-10-14, all four registered pools diverged by
 * **0.26%-4.20%** — but the feed had been down since 2026-10-13, so the posted
 * leg was frozen 24-109 hours old and every one of those readings is an
 * upper bound on what a live feed would show, not a sample of it.
 *
 * Those numbers therefore CANNOT calibrate the bands, and they are never judged
 * anyway: `classifyDivergence` returns "unknown" whenever the feed is stale, so
 * a verdict only ever applies to fresh data, of which there is currently none.
 * Re-measure once the bot is running and tighten or widen accordingly. Until
 * then 5% is a guess informed by the composition check's agreed tolerance, and
 * the value that actually matters is the 15% ceiling's distance from the ~45%
 * decimals-slip signature.
 *
 * ── What it is NOT ────────────────────────────────────────────────────────
 * Not a gate and not an alert: a pull-only readout, like the rest of this
 * panel. It cannot block a post, so a Tinyman outage degrades it to "unknown"
 * rather than affecting the protocol.
 */
import algosdk from "algosdk";

/** Tinyman v2 validator app — pools keep `issued_pool_tokens` in local state under it. */
export const TINYMAN_VALIDATOR_APP = 1_002_541_853;

/**
 * Pool account per oracle pool id (the pool id IS the LP ASA id — see POOL_WIRING).
 *
 * Deliberately NOT added to `POOL_WIRING`: presence there means a pool is wired
 * for live vault interaction, and ALGO/USDC and U/ALGO are registered on the
 * oracle only. They are listed here so the cross-check already covers them when
 * the vault side catches up.
 */
export const POOL_ADDRESS: Record<number, string> = {
  3163770927: "AIR4CSC54U33WCX4JTMJA4X6PHBVG7OGX7XVV2MCACYSSDULZNJ2KNGRZI", // U/tALGO
  3673941603: "ONUEZGER6ZTBW7IT2FNWQVSTXJJEMG4BK2YK25FTDKEBTDE72BKV7SJUSI", // U/USDC
  1002590888: "2PIFZW53RHCSFSYMCFUBW4XOCXOMB7XOYQSQ6KGT3KVGJTL4HM6COZRNMM", // ALGO/USDC
  3617313492: "35I7TSPBSYCEP276DHLZDTOP3W77GY76VOLBCAKWICVFJUOTQAMRR6QZA4", // U/ALGO
};

const TINYMAN_POOLS_API = "https://mainnet.analytics.tinyman.org/api/v1/pools";

/**
 * Divergence bands.
 *
 * 5% matches the tolerance already agreed for the bot's composition check, and
 * is wide enough for the two legitimate sources of disagreement: the posted
 * price is TWAP-smoothed so it lags spot, and the third-party TVL is computed
 * at a different instant. 15% is far above any plausible lag yet far below the
 * ~45% signature of the decimals-slip bug this is here to catch.
 */
export const DIVERGE_WARN_PCT = 5;
export const DIVERGE_CRITICAL_PCT = 15;
/** vault/contract.py ORACLE_FRESHNESS — past this, staleness explains divergence. */
const ORACLE_FRESHNESS = 1_800;

export type CrossCheckLevel = "ok" | "warn" | "critical" | "unknown";

export type PriceCrossCheck = {
  poolId: number;
  /** Price the oracle currently publishes, in mUSD per LP. */
  posted: number | null;
  /** TVL / issued LP, from sources outside our pricing path. */
  independent: number | null;
  divergencePct: number | null;
  level: CrossCheckLevel;
  /** Why the level is what it is, when it needs saying. */
  note: string | null;
};

/**
 * Classify a divergence.
 *
 * `ageSec` is taken because a stale feed makes divergence uninformative — the
 * price is simply old, the freshness alarm has already fired, and reporting it
 * a second time as "wrong" would be two alarms for one fault. Returning
 * "unknown" there keeps this signal about wrongness alone.
 */
export function classifyDivergence(
  divergencePct: number | null,
  ageSec: number,
  hasPosted: boolean,
): { level: CrossCheckLevel; note: string | null } {
  if (!hasPosted) return { level: "unknown", note: "never posted" };
  if (ageSec >= ORACLE_FRESHNESS) {
    return { level: "unknown", note: "feed is stale — divergence is expected and says nothing new" };
  }
  if (divergencePct === null) {
    return { level: "unknown", note: "no independent price available" };
  }
  if (divergencePct >= DIVERGE_CRITICAL_PCT) {
    return {
      level: "critical",
      note: "fresh but far from an independent read — suspect a decimals or route fault, not a market move",
    };
  }
  if (divergencePct >= DIVERGE_WARN_PCT) {
    return { level: "warn", note: "wider than TWAP lag alone usually explains" };
  }
  return { level: "ok", note: null };
}

/** `|a − b| / b` as a percentage. Null unless both sides are usable. */
export function divergencePct(posted: number | null, independent: number | null): number | null {
  if (posted === null || independent === null || independent <= 0) return null;
  return (Math.abs(posted - independent) / independent) * 100;
}

/** Read `issued_pool_tokens` out of a Tinyman v2 pool's local state. */
async function issuedLpTokens(algod: algosdk.Algodv2, poolAddress: string): Promise<number | null> {
  const info = (await algod.accountInformation(poolAddress).do()) as unknown as {
    appsLocalState?: { id: number | bigint; keyValue?: { key: string | Uint8Array; value: { uint?: number | bigint } }[] }[];
  };
  const state = (info.appsLocalState ?? []).find((s) => Number(s.id) === TINYMAN_VALIDATOR_APP);
  if (!state) return null;
  for (const kv of state.keyValue ?? []) {
    const key =
      typeof kv.key === "string"
        ? Buffer.from(kv.key, "base64").toString("utf8")
        : Buffer.from(kv.key).toString("utf8");
    if (key === "issued_pool_tokens") {
      const n = Number(kv.value?.uint ?? 0);
      return n > 0 ? n : null;
    }
  }
  return null;
}

async function poolTvlUsd(poolAddress: string): Promise<number | null> {
  try {
    // Timed out rather than left hanging: without this a stalled third party
    // never resolves, so the panel's verdict silently stops refreshing while its
    // freshness rows keep updating beside it.
    const r = await fetch(`${TINYMAN_POOLS_API}/${poolAddress}/`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) return null;
    const p = await r.json();
    const tvl = Number(p?.liquidity_in_usd);
    return Number.isFinite(tvl) && tvl > 0 ? tvl : null;
  } catch {
    return null;   // a third party being down must never look like a bad price
  }
}

/** Cross-check one pool. LP tokens carry 6 decimals, as does the posted price. */
export async function crossCheckPool(
  algod: algosdk.Algodv2,
  poolId: number,
  posted: number | null,
  ageSec: number,
): Promise<PriceCrossCheck> {
  const address = POOL_ADDRESS[poolId];
  if (!address) {
    return {
      poolId, posted, independent: null, divergencePct: null,
      level: "unknown", note: "no pool address on record for this pool id",
    };
  }

  const [issued, tvl] = await Promise.all([
    issuedLpTokens(algod, address).catch(() => null),
    poolTvlUsd(address),
  ]);

  const independent = issued !== null && tvl !== null ? tvl / (issued / 1e6) : null;
  const d = divergencePct(posted, independent);
  const { level, note } = classifyDivergence(d, ageSec, posted !== null && posted > 0);
  return { poolId, posted, independent, divergencePct: d, level, note };
}

/** Cross-check several pools at once. Never throws: a failure degrades to "unknown". */
export async function crossCheckPools(
  algod: algosdk.Algodv2,
  pools: { poolId: number; price: number; ageSec: number; ts: number }[],
): Promise<Record<number, PriceCrossCheck>> {
  const results = await Promise.all(
    pools.map((p) =>
      crossCheckPool(algod, p.poolId, p.ts === 0 ? null : p.price, p.ageSec).catch(
        (): PriceCrossCheck => ({
          poolId: p.poolId, posted: p.price, independent: null, divergencePct: null,
          level: "unknown", note: "cross-check read failed",
        }),
      ),
    ),
  );
  return Object.fromEntries(results.map((r) => [r.poolId, r]));
}
