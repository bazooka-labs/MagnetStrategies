// Perps — the preflight checks, and the one place that caches them.
//
// Two controls were written, documented, and then never called. That is worse
// than not having them: `verifyProgramPins` describes itself as our sole
// automatic detection of a PEX upgrade, so an unwired copy is a claimed defence
// that defends nothing. This module wires both and is the only caller of either.
//
// ── Why they are cached here rather than run where they are needed ───────────
// Neither belongs in the market refresh. `verifyProgramPins` is six
// `getApplicationByID` round trips plus six SHA-256 digests, and the card
// refreshes every ten seconds; `assertBuilderAddressUsable` reads a property of
// our own treasury configuration, which cannot change between two quotes.
//
// So: one shared in-flight promise, one TTL. The card starts it on mount, which
// means it is warm by the time anyone clicks, and the write path awaits the same
// promise instead of duplicating the work.

import algosdk from "algosdk";
import { BUILDER_ADDRESS, COLLATERAL_ASSET_ID } from "./perps";
import { assertBuilderAddressUsable, dynamicOiLayoutProblem, verifyProgramPins } from "./perpsReads";

/**
 * Which refusals apply to EXITING, as opposed to opening.
 *
 * Review of the audit-8 remediation (M-3): gating close and cancel on `canOpen`
 * swept in two kinds that cannot affect them.
 *
 * - `builder` is `assertBuilderAddressUsable` — OUR treasury's USDC opt-in.
 *   A cancel group has zero transfers and zero payments, and a close pays no
 *   builder fee we need an opt-in for. Blocking escrow recovery on our own
 *   misconfiguration is the trade-blocking pattern, not caution.
 * - `layout` is `dynamicOiLayoutProblem`, which sets the leverage CEILING.
 *   `cancel_order` takes one uint64; there is no ceiling to get wrong.
 *
 * `drift` and `unreachable` do apply: a redeployed app or an unreadable chain
 * means we would be guessing at the ABI, and that is no safer because the user
 * is trying to get out.
 */
export const EXIT_BLOCKING_KINDS: ReadonlySet<string> = new Set(["drift", "unreachable"]);

export type PreflightResult = {
  /** False means opens must be refused. Exits: see `EXIT_BLOCKING_KINDS`. */
  canOpen: boolean;
  /**
   * User-facing reason opens are refused, or null.
   *
   * Phrased for whoever reads it: a builder-address problem is ours, not
   * theirs, and saying "unavailable" is honest where naming our treasury
   * configuration would only be confusing.
   */
  reason: string | null;
  /** Detail for the console and for us — never rendered. */
  detail: string | null;
  /**
   * Why opens are refused, as a value rather than as prose.
   *
   * The cache policy used to be decided by `reason.startsWith("Could not
   * verify")` — i.e. by string-matching the sentence shown to the user. Editing
   * that copy would have silently started caching transient failures for the
   * full TTL, holding trading down over one dropped request: exactly the
   * outcome the comment below says it prevents. Copy is for people; this is for
   * code.
   */
  kind: "ok" | "drift" | "builder" | "layout" | "unreachable";
  checkedAt: number;
};

/**
 * Five minutes.
 *
 * A PEX redeploy is a rare, deliberate act, not something that lands mid-session
 * — the point of the check is to catch a swap that happened while we were not
 * looking, not to race one in progress. Five minutes bounds the exposure without
 * putting six extra round trips behind every trade.
 */
const TTL_MS = 5 * 60 * 1000;

let cached: PreflightResult | null = null;
let inFlight: Promise<PreflightResult> | null = null;

async function run(algod: algosdk.Algodv2): Promise<PreflightResult> {
  const checkedAt = Date.now();
  // Cheapest first, and entirely local: if our three declarations of the `doi:`
  // layout disagree, the dynamic-OI margin factors are being misread and those
  // set the leverage ceiling. Stop trading; do not stop the page.
  const layout = dynamicOiLayoutProblem();
  if (layout) {
    return {
      // Opens only — this is the leverage ceiling, which an exit does not use.
      canOpen: false, kind: "layout",
      reason: "New positions are paused: the exchange's data format no longer matches what this build expects. Closing and cancelling are unaffected.",
      detail: layout,
      checkedAt,
    };
  }
  try {
    const [pins, builder] = await Promise.all([
      verifyProgramPins(algod),
      assertBuilderAddressUsable(algod, BUILDER_ADDRESS, COLLATERAL_ASSET_ID),
    ]);

    // Drift first: it is the more serious of the two, and it is the one whose
    // remedy is "stop opening", not "fix a setting".
    //
    /**
     * ── This comment and this string were both wrong ─────────────────────────
     * They claimed the close path "deliberately does not consult this" and told
     * the user "Existing positions can still be closed." `closePositionInner`
     * does consult it and throws `reason` verbatim — so the banner promised
     * closing worked, and pressing Close produced an error whose own text said
     * closing worked. Audit 8 HIGH 6.
     *
     * **The gate is kept; the claim is fixed.** Refusing to build against a
     * drifted manifest is right, and it is not safer because the user is trying
     * to get OUT — we would be guessing at the ABI in either direction, on a
     * group that moves their collateral. Stranding someone is bad; signing a
     * group we cannot decode on their behalf is worse.
     *
     * So this now says what is true, and `cancelOrder` consults the preflight
     * too — otherwise a user in this state could remove their take-profit but
     * not close, leaving liquidation as the only remaining exit.
     */
    if (!pins.ok) {
      return {
        canOpen: false, kind: "drift",
        reason: "PEX has been upgraded since this build was pinned. Everything is paused — opening, closing and cancelling — until we have re-verified against the new contracts. Your position is untouched and PEX's own interface can still act on it.",
        detail: `program drift: ${pins.drifted.join("; ")}`,
        checkedAt,
      };
    }
    if (!builder.ok) {
      // Every open would fail at the chain with the builder-fee transfer, which
      // presents as our bug because it is one. Refuse early and plainly rather
      // than letting each user discover it at signing time.
      return {
        canOpen: false, kind: "builder",
        reason: "Trading is temporarily unavailable. This is a configuration problem on our side, not with your wallet.",
        detail: `builder address: ${builder.problem}`,
        checkedAt,
      };
    }
    return { canOpen: true, kind: "ok", reason: null, detail: null, checkedAt };
  } catch (e) {
    // Fail CLOSED. A read that did not complete is not evidence the programs are
    // unchanged, and this is the check that stands between a user and a PEX we
    // have not verified. A flaky node blocking opens is the acceptable side of
    // this trade; the card offers a retry and the result is not cached, so the
    // next attempt re-runs rather than serving the failure for five minutes.
    return {
      canOpen: false, kind: "unreachable",
      reason: "Could not verify the exchange contracts. Check your connection and try again.",
      detail: e instanceof Error ? e.message : String(e),
      checkedAt,
    };
  }
}

/**
 * The cached preflight. Concurrent callers share one round trip.
 *
 * `force` skips the cache — for the retry button, so a user who fixed their
 * connection is not told to wait out a TTL they cannot see.
 */
export function preflight(algod: algosdk.Algodv2, force = false): Promise<PreflightResult> {
  if (!force && cached && Date.now() - cached.checkedAt < TTL_MS) return Promise.resolve(cached);
  if (!force && inFlight) return inFlight;

  const p = run(algod).then((r) => {
    // A failure is not cached: it is usually transient, and caching it would
    // hold trading down for the full TTL over one dropped request. Drift and a
    // misconfigured builder address ARE cached — both are real states that will
    // still be true in five minutes, and re-checking them every click is waste.
    cached = r.kind === "unreachable" ? null : r;
    if (inFlight === p) inFlight = null;
    return r;
  }).catch((e) => {
    if (inFlight === p) inFlight = null;
    throw e;
  });

  inFlight = p;
  return p;
}

/** Test seam, and for a hard refresh. */
export function resetPreflightCache(): void {
  cached = null;
  inFlight = null;
}
