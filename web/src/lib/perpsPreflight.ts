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

/** Every refusal the preflight can return. One source for the map below. */
export type PreflightKind =
  | "ok"
  | "drift"
  /** Builder address not opted in to the collateral asset. Blocks exits too. */
  | "builder_optin"
  /** Builder address below its minimum balance. Does NOT block exits. */
  | "builder_balance"
  | "layout"
  | "unreachable";

/**
 * Which refusals block an EXIT (close, cancel), as opposed to an open.
 *
 * ── The builder split, and the claim that was false ────────────────────────
 * Audit 8 excluded `builder` from the exit gate on the stated grounds that "a
 * close pays no builder fee we need an opt-in for". **That is wrong.** The close
 * group charges one: `closePosition` passes
 * `builderFee: { BUILDER_ADDRESS, POSITION_BUILDER_FEE_BPS }`, and
 * `assertCloseGroup` REQUIRES the close leg's builder tuple to be exactly that —
 * it fails with `builder_address` otherwise. Audit 9's own remediation repeated
 * the claim in three comments before review caught it.
 *
 * So the two causes behind the old single `builder` kind are not alike, and
 * `BuilderCheck` already distinguishes them:
 *
 * - **not opted in** — the close's builder-fee transfer fails at the chain, so
 *   the close fails. This MUST block exits, or the panel offers a button that
 *   dies in simulation with an opaque message: "offered, then refuses", which is
 *   the defect this lineage keeps reintroducing.
 * - **below minimum balance** — receiving an ASA needs no spendable ALGO, so a
 *   close is unaffected. This must NOT block exits; trapping a user in a
 *   leveraged position over our treasury's ALGO balance is the self-inflicted
 *   trap the narrow gate exists to prevent.
 *
 * `layout` is `dynamicOiLayoutProblem`, which sets the leverage CEILING. It is a
 * local three-way declaration check and the close path never reads `doi:`, so it
 * is genuinely irrelevant to an exit.
 *
 * `drift` and `unreachable` block everything: a redeployed app or an unreadable
 * chain means we would be guessing at the ABI, and that is no safer because the
 * user is trying to get out.
 *
 * ── Why a total Record and not a Set ───────────────────────────────────────
 * This was `ReadonlySet<string>`, and audit 9 (LOW 4) showed a typo in it
 * compiled with ZERO errors: `"drifttypo"` type-checks, and `drift` silently
 * stops blocking exits. A total `Record` makes that impossible: every key must be
 * a real kind, and every kind must be given an answer.
 */
export const EXIT_BLOCKS: Record<PreflightKind, boolean> = {
  ok: false,
  drift: true,
  unreachable: true,
  builder_optin: true,
  builder_balance: false,
  layout: false,
};

/** Whether this refusal should stop a close or a cancel. */
/**
 * Whether this refusal should stop a close or a cancel.
 *
 * `?? true`, not a bare lookup. The `Record` is total at COMPILE time, but a
 * value arriving from outside the type — a cached result from an older build,
 * say — indexes to `undefined` and reads as "does not block", which is the same
 * runtime fail-open the `Set` had. Review of audit 9 (LOW 5) caught the comment
 * above claiming the Record closed a hole it had only closed statically. An
 * unknown refusal blocks.
 */
export const exitBlocked = (kind: PreflightKind): boolean => EXIT_BLOCKS[kind] ?? true;

export type PreflightResult = {
  /** False means opens must be refused. Exits: see `exitBlocked`. */
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
  kind: PreflightKind;
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
      // The cause decides whether EXITS are blocked too — see `EXIT_BLOCKS`. A
      // missing opt-in breaks the close's builder fee as surely as an open's; a
      // low ALGO balance does not, because receiving an ASA costs the receiver
      // nothing.
      return {
        canOpen: false, kind: builder.optedIn ? "builder_balance" : "builder_optin",
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

/**
 * The exit banner text for a positions panel, or null when exits are allowed.
 *
 * Extracted from `PositionsPanel` so it can be tested. The panel's gate is the
 * thing audit 9 HIGH 1 found broken, and it had NO coverage: reverting it to
 * `canOpen !== true`, or reordering the ternary so a null kind read as
 * permission, left the whole suite green. A rule that only exists inside JSX is
 * a rule nothing can check.
 *
 * Ordering is the substance, not the formatting:
 *   1. `null` means the first check has not landed. It must read as "not yet",
 *      never as permission — that regression has been introduced twice.
 *   2. Otherwise block only on refusals that actually affect an exit.
 */
export function exitBanner(
  canOpen: boolean | null,
  kind: PreflightKind | null,
  reason: string | null,
): string | null {
  if (canOpen === null || kind === null) return "Checking the exchange contracts…";
  if (exitBlocked(kind)) return reason ?? "Trading is unavailable right now.";
  return null;
}
