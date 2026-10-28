/**
 * Signing and submitting an asserted group, with three outcomes rather than two.
 *
 * ── Why this is its own module ──
 * `perpsClient.ts` learned every rule below the hard way, and the liquidity
 * path needs all of them. The alternative to sharing was a second copy, and the
 * notes in `perpsGroup.ts` record what the last second copy cost: a hardening
 * pass went into the open path only, and the close path silently kept the weaker
 * set.
 *
 * `perpsClient` is NOT yet routed through here. Rewiring the live trading
 * submit path for a feature that is still hidden is the riskier of the two
 * choices available today, so this module is the shared home and the trading
 * path should adopt it the next time it is touched. Until then the duplication
 * is real and deliberate, which is why it is written down.
 *
 * ── The three outcomes ──
 * `waitForConfirmation` throws for two structurally different things:
 * `Transaction Rejected: <poolError>`, where the node has definitively refused
 * the group, and `Transaction not confirmed after N rounds`, where the answer
 * is genuinely unknown. Collapsing them into `confirmed: false` once told a
 * user whose transaction had been REJECTED that it would most likely confirm
 * and not to retry — every clause false, and it steers them away from the one
 * correct action.
 *
 * A wait that runs out is NOT a failure: the group stays valid for the rest of
 * its window and will most likely commit. algod here is load-balanced and the
 * SDK swallows the 404s that come from polling a node other than the one that
 * accepted the submission, so a successful action reported as failed was not an
 * edge case — it was the expected outcome of a slow round, after which the user
 * retried and did it twice.
 */

import algosdk from "algosdk";

export type SignFn = (txns: Uint8Array[]) => Promise<(Uint8Array | null)[]>;

/**
 * `partial` exists because a multi-group action can stop half way: an earlier
 * group committed and a later one did not. Reporting that as "failed" or as
 * "done" would both be false, and the user needs to know which half happened.
 */
export type SubmitOutcome = "confirmed" | "rejected" | "unknown" | "partial";

export type SubmitResult = {
  txId: string;
  outcome: SubmitOutcome;
  /** The node's reason, when it gave one. */
  reason?: string;
  /** How many groups committed, for a multi-group action. */
  committedGroups?: number;
  totalGroups?: number;
};

/**
 * Rounds to wait. Algorand blocks are ~2.8s, so this is about two minutes —
 * long enough to cover a slow round and a load-balanced poll, short enough not
 * to strand the UI. Running out is reported, never thrown.
 */
export const CONFIRM_ROUNDS = 40;

/**
 * Sent, but the response was lost.
 *
 * Distinct from a rejection because the remedy is opposite: here the user must
 * check before retrying, since the action may already have happened.
 */
/**
 * The node REFUSED the submission. Nothing was sent.
 *
 * Distinct from `SubmissionUnknownError`, and the distinction matters more
 * than it looks: on 2026-10-23 a refused submission was reported to a user as
 * "it will most likely still go through". It had not gone through, and the
 * advice attached to that message — check before retrying — was wrong in the
 * one direction that wastes someone's time and erodes trust in every later
 * message the app shows them.
 *
 * A 4xx from algod with a body is a definitive refusal. A dropped connection
 * is not, and stays `SubmissionUnknownError`.
 */
export class SubmissionRefusedError extends Error {
  constructor(readonly reason: string) {
    super(`The network refused this, so nothing was sent: ${reason}`);
    this.name = "SubmissionRefusedError";
  }
}

export class SubmissionUnknownError extends Error {
  constructor(readonly txId: string, readonly cause: string) {
    super(
      "This was sent but the response was lost, so its outcome is unknown. "
      + "Check the link before trying again — doing it twice would move funds twice.",
    );
    this.name = "SubmissionUnknownError";
  }
}

/**
 * Sign one or more groups in ONE wallet prompt, then submit them.
 *
 * ── Why `groups`, not a flat array ──
 * `sendRawTransaction` accepts exactly ONE complete group per call. Submitting
 * a flat array spanning two groups is refused with `incomplete group`, which
 * is how the first real C-Vault exit failed: 22 transactions were signed in a
 * single prompt — the wallet handled that correctly — and then rejected by the
 * node in one submission call.
 *
 * Verified against MainNet: a two-group batch returns
 * `transactionGroup: incomplete group: <id> != <id>`, while a one-group batch
 * of the same shape gets as far as complaining about the signatures.
 *
 * So: ARC-0001 `signTxns` takes the flattened array and the wallet prompts
 * once; submission then goes group by group.
 *
 * ── Ordering, and the state between groups ──
 * Groups are submitted in order and each is confirmed before the next is sent.
 * They are NOT atomic with each other: if group 2 fails after group 1
 * committed, the result says so rather than reporting a clean success or a
 * clean failure, because the user is in neither state.
 */
export async function signAndSubmit(input: {
  algod: algosdk.Algodv2;
  signTransactions: SignFn;
  /** A single group. Use `groups` for more than one. */
  txns?: algosdk.Transaction[];
  /** Several groups, signed together and submitted one call each. */
  groups?: algosdk.Transaction[][];
  onStage?: (s: "signing" | "submitting" | "confirming") => void;
}): Promise<SubmitResult> {
  const { algod, signTransactions, onStage = () => {} } = input;
  const groups = input.groups ?? (input.txns ? [input.txns] : []);
  if (groups.length === 0 || groups.some((g) => g.length === 0)) {
    throw new Error("Nothing to submit.");
  }

  onStage("signing");
  // Flattened for ONE prompt. Already grouped by the SDK; re-assigning group
  // ids would invalidate the assertions that passed over these exact bytes.
  const flat = groups.flat();
  const signed = await signTransactions(flat.map((t) => algosdk.encodeUnsignedTransaction(t)));
  const blobs = signed.filter((s): s is Uint8Array => !!s);
  if (blobs.length !== flat.length) throw new Error("Signing cancelled.");

  // Split the signed blobs back into their groups, in order.
  const perGroup: Uint8Array[][] = [];
  let i = 0;
  for (const g of groups) { perGroup.push(blobs.slice(i, i + g.length)); i += g.length; }

  // Computed BEFORE submission: the id is a property of the signed bytes, not
  // of the response, and losing it on a dropped socket is how a committed
  // group gets reported as a failure with no link.
  const firstTxId = groups[0][0].txID();
  let committed = 0;

  for (let n = 0; n < groups.length; n++) {
    const txId = groups[n][0].txID();
    onStage("submitting");
    try {
      await algod.sendRawTransaction(perGroup[n]).do();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A node that answered with a reason refused it. Only a connection that
      // died is genuinely unknown.
      const refused = /\b4\d\d\b|incomplete group|transactionGroup|rejected|malformed|overspend|logic eval/i
        .test(msg);
      if (n === 0) {
        if (refused) throw new SubmissionRefusedError(msg);
        throw new SubmissionUnknownError(txId, msg);
      }
      // A later group failed after an earlier one committed. The user is
      // mid-way, and saying "failed" would be as wrong as saying "done".
      return {
        txId: firstTxId, outcome: "partial", committedGroups: committed,
        totalGroups: groups.length,
        reason: refused ? msg : `${msg} (outcome of this step unknown)`,
      };
    }

    onStage("confirming");
    try {
      await algosdk.waitForConfirmation(algod, txId, CONFIRM_ROUNDS);
      committed++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const rejected = /^Transaction Rejected:/i.test(msg);
      if (n === 0 && groups.length === 1) {
        return rejected
          ? { txId, outcome: "rejected", reason: msg.replace(/^Transaction Rejected:\s*/i, "") }
          : { txId, outcome: "unknown", reason: msg };
      }
      // Multi-group: stop rather than send the next step against a state that
      // may not exist.
      return {
        txId: firstTxId,
        outcome: committed > 0 ? "partial" : rejected ? "rejected" : "unknown",
        committedGroups: committed, totalGroups: groups.length, reason: msg,
      };
    }
  }

  return {
    txId: firstTxId, outcome: "confirmed",
    committedGroups: committed, totalGroups: groups.length,
  };
}
