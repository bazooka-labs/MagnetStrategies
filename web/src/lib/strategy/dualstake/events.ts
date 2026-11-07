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

/**
 * Pagination, and the honesty it exists to buy.
 *
 * ── Why this is not a single bounded scan any more ────────────────────────
 * It was `limit: 300`, one call, and the modal headed the result "Every
 * harvest so far". That was true on the day — three harvests inside about
 * ninety transactions — and it was going to stop being true without anything
 * breaking: deposits are what fill the window, so the busier the product
 * gets, the sooner the oldest harvests fall off the end while the heading
 * goes on claiming completeness.
 *
 * That is the same shape as the two bounds that expired here on 2026-11-07
 * (the `$U` surplus pin, and the perps gate before it): a constant sized to
 * today's volume, with no test that can notice when today's volume changes.
 * See [[feedback-temporary-gates-expire]].
 *
 * So the scan pages to exhaustion, and when it cannot finish it SAYS so —
 * `complete: false` — and the modal retitles itself rather than overclaiming.
 * Truncation is reported, never silent.
 */
const PAGE_SIZE = 1000;          // the indexer's maximum
const MAX_PAGES = 12;            // 12,000 transactions before we admit defeat

/** A harvest scan, and whether it reached the beginning of the record. */
export interface HarvestScan {
  /** Newest first. */
  harvests: Harvest[];
  /** The scan exhausted the app's history rather than hitting MAX_PAGES. */
  complete: boolean;
  /** App transactions examined, so a truncated scan can name its window. */
  scanned: number;
}

/**
 * Every harvest the indexer will give us, newest first.
 *
 * `null` is unread and an empty `harvests` is "read successfully, none yet" —
 * the modal renders those differently, for the same reason `readHolding`
 * distinguishes them.
 *
 * ── Called lazily, when the modal opens ──
 * Not on card mount. A full scan costs one round trip per thousand app
 * transactions and grows with the product, which is not a price the card
 * should pay to render four stats and a rate the user may never scroll past.
 * The reader who opens Learn more is the one who wants it.
 */
export async function readHarvests(
  algodServer: string, indexerServer: string,
): Promise<HarvestScan | null> {
  try {
    const client = readClient(algodServer);
    const indexer = new algosdk.Indexer("", indexerServer, "");

    const out: Harvest[] = [];
    let next: string | undefined;
    let scanned = 0;
    let complete = false;

    for (let page = 0; page < MAX_PAGES; page++) {
      let q = indexer.searchForTransactions()
        .applicationID(DUALSTAKE_APP_ID)
        .limit(PAGE_SIZE);
      if (next) q = q.nextToken(next);
      const res = await q.do();

      const txns = res.transactions ?? [];
      scanned += txns.length;

      for (const txn of txns) {
        /* Walks inner transactions and filters to our app id. The swap is
           logged on an inner call, so a scan of outer logs alone finds none. */
        for (const ev of client.getParsedArc28EventsFromTransaction(txn)) {
          if (ev.spec.name !== "swap") continue;
          const algoMicro = ev.argsByName["algo_amount"];
          const rewardBase = ev.argsByName["asa_amount"];
          if (typeof algoMicro !== "bigint" || typeof rewardBase !== "bigint") continue;
          /* A swap of nothing is not a harvest, and would divide by zero in
             the realised-rate column. */
          if (algoMicro <= BigInt(0)) continue;
          out.push({
            round: Number(ev.outerTransaction.confirmedRound ?? 0),
            timestamp: Number(ev.outerTransaction.roundTime ?? 0),
            algoMicro,
            rewardBase,
          });
        }
      }

      next = res.nextToken;
      /* No continuation token, or a short page: the indexer has nothing
         further. Either one means we reached the beginning of the record. */
      if (!next || txns.length < PAGE_SIZE) { complete = true; break; }
    }

    out.sort((a, b) => b.round - a.round);
    return { harvests: out, complete, scanned };
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
