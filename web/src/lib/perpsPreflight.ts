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

export type PreflightResult = {
  /** False means opens must be refused. Exits are unaffected — see below. */
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
      canOpen: false, kind: "layout",
      reason: "New positions are paused: the exchange's data format no longer matches what this build expects.",
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
    // Blocking opens while leaving exits live is deliberate. A redeploy leaves
    // existing positions in the old app, so a blanket halt strands whoever is
    // holding one — and the close path deliberately does not consult this.
    if (!pins.ok) {
      return {
        canOpen: false, kind: "drift",
        reason: "PEX has been upgraded since this build was pinned. New positions are paused while we re-verify. Existing positions can still be closed.",
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
