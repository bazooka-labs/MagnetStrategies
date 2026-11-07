// ── magnetALGO dualSTAKE — the harvest record, from the contract's own logs ─
//
// Every reward that reaches a magnetALGO holder passes through one ARC-28
// `swap(uint64,uint64)` event: ALGO in, $U out. That log IS the yield, and
// reading it is how the Learn more modal can show realised history instead of
// only an expected rate.
//
// ── The decoding is Myth's, not ours ──────────────────────────────────────
// `DualStakeClient` carries the event spec in its CONSTRUCTOR (not in
// `init()`, which only fetches the listing), so `parseArc28Events` and
// `getParsedArc28EventsFromTransaction` both work off a read-only client with
// no network call and no signer. We use them rather than deriving ARC-28
// prefixes ourselves.
//
// That is the same rule the mint path follows: the $U leg comes from the SDK
// and we bound it, we do not recompute it. A hand-rolled prefix table would
// be a second implementation of the vendor's spec, free to drift from it
// silently — see [[feedback-vendor-spec-beats-sampling]]. The one thing we
// assert ourselves is that the event we picked up came from the app we pinned,
// which `getParsedArc28EventsFromTransaction` checks against `appId` and
// `assertHarvestsFromPinnedApp` checks again here.
//
// ── Fees come off BEFORE the swap, which is why this log is the net ────────
// Verified arithmetically, 2026-11-07. Three harvests had converted
// 22.864667 ALGO, and the contract's `platform_fees` + `noderunner_fees`
// counters stood at 1.589520 ALGO:
//
//     1.589520 / (22.864667 + 1.589520) = 0.065000  = 650bps, exactly
//
// So the `algo_amount` on a `swap` event is already net of Myth's cut, and
// the $U beside it is what holders actually received. No fee adjustment is
// applied to these figures anywhere, and none should be.
//
// That identity holds only while nothing has been withdrawn from the fee
// counters, so it is a one-time proof of what the field MEANS rather than a
// check to run continuously. Nothing in the UI depends on it.

import algosdk from "algosdk";
import { DUALSTAKE_APP_ID } from "./config";
import { readClient } from "./reads";
import type { Harvest } from "./yield";

/* `Harvest` is declared in `yield.ts` because `ConsensusYield` and the
   harvest log are two halves of one subject, and re-exported here because
   this is the module that produces them. Consumers import both from the
   module they called, not from wherever the type happens to live. */
export type { Harvest };

/** How many app transactions to scan. Harvests are a few percent of them. */
const SCAN_LIMIT = 300;

/**
 * Harvests, newest first, or null if the indexer could not be read.
 *
 * `null` is unread and `[]` is "read successfully, none yet" — the modal
 * renders those differently, for the same reason `readHolding` distinguishes
 * them.
 */
export async function readHarvests(
  algodServer: string, indexerServer: string,
): Promise<Harvest[] | null> {
  try {
    const client = readClient(algodServer);
    const indexer = new algosdk.Indexer("", indexerServer, "");
    const res = await indexer
      .searchForTransactions()
      .applicationID(DUALSTAKE_APP_ID)
      .limit(SCAN_LIMIT)
      .do();

    const out: Harvest[] = [];
    for (const txn of res.transactions ?? []) {
      /* Walks inner transactions and filters to our app id. The swap is
         logged on an inner call, so a scan of outer logs alone finds none. */
      for (const ev of client.getParsedArc28EventsFromTransaction(txn)) {
        if (ev.spec.name !== "swap") continue;
        const algoMicro = ev.argsByName["algo_amount"];
        const rewardBase = ev.argsByName["asa_amount"];
        if (typeof algoMicro !== "bigint" || typeof rewardBase !== "bigint") continue;
        /* A swap of nothing is not a harvest, and would divide by zero in the
           realised-rate column. */
        if (algoMicro <= BigInt(0)) continue;
        out.push({
          round: Number(ev.outerTransaction.confirmedRound ?? 0),
          timestamp: Number(ev.outerTransaction.roundTime ?? 0),
          algoMicro,
          rewardBase,
        });
      }
    }

    out.sort((a, b) => b.round - a.round);
    return out;
  } catch {
    return null;
  }
}

/**
 * Totals across a harvest log, for the modal's summary line.
 *
 * `days` spans the FIRST harvest to the LAST, and the modal labels it as
 * such. It is deliberately not used to annualise anything: a window whose
 * both ends are harvests excludes the dry spell before the first one and
 * after the last, which biases any rate derived from it upward. That bias is
 * exactly why the card's headline comes from `yield.ts` instead.
 */
export function harvestTotals(harvests: Harvest[]): {
  algoMicro: bigint; rewardBase: bigint; days: number | null; count: number;
} | null {
  if (harvests.length === 0) return null;
  const algoMicro = harvests.reduce((a, h) => a + h.algoMicro, BigInt(0));
  const rewardBase = harvests.reduce((a, h) => a + h.rewardBase, BigInt(0));
  const ts = harvests.map((h) => h.timestamp).filter((t) => t > 0);
  const days = ts.length > 1
    ? (Math.max(...ts) - Math.min(...ts)) / 86_400
    : null;
  return { algoMicro, rewardBase, days, count: harvests.length };
}

/**
 * The realised $U per ALGO the contract achieved, across the whole log.
 *
 * This is the conversion a holder's rewards actually went through, slippage
 * included — not a spot quote off the pool. Measured across the first three
 * harvests: 0.67603 $U/ALGO, with the individual swaps inside 0.4% of each
 * other at ~7.6 ALGO a time.
 */
export function realisedRewardPerAlgo(harvests: Harvest[]): number | null {
  const t = harvestTotals(harvests);
  if (!t || t.algoMicro <= BigInt(0)) return null;
  // $U has 5 decimals and ALGO 6, so the ratio needs both scales applied.
  return (Number(t.rewardBase) / 1e5) / (Number(t.algoMicro) / 1e6);
}

/**
 * Every harvest came from the app we pinned.
 *
 * `getParsedArc28EventsFromTransaction` already filters on `appId`, so this
 * is a second check of the same claim — kept because the first one lives in
 * vendor code that a dependency update can change, and because a harvest log
 * borrowed from a DIFFERENT dualSTAKE contract would be a plausible-looking
 * set of numbers describing someone else's product. Asserted in the live
 * test rather than enforced at runtime: these figures are displayed, never
 * signed, so the correct response to a mismatch is a failing test, not a
 * silently shorter list in a user's browser.
 */
export function assertHarvestsFromPinnedApp(
  txns: { applicationTransaction?: { applicationId?: bigint | number } }[],
): boolean {
  return txns.every((t) => {
    const id = t.applicationTransaction?.applicationId;
    return id === undefined || Number(id) === DUALSTAKE_APP_ID;
  });
}
