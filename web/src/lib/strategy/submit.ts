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

export type SubmitOutcome = "confirmed" | "rejected" | "unknown";

export type SubmitResult = {
  txId: string;
  outcome: SubmitOutcome;
  /** The node's reason, when it gave one. */
  reason?: string;
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
export class SubmissionUnknownError extends Error {
  constructor(readonly txId: string, readonly cause: string) {
    super(
      "This was sent but the response was lost, so its outcome is unknown. "
      + "Check the link before trying again — doing it twice would move funds twice.",
    );
    this.name = "SubmissionUnknownError";
  }
}

export async function signAndSubmit(input: {
  algod: algosdk.Algodv2;
  signTransactions: SignFn;
  /** The exact transactions the assertion passed over. */
  txns: algosdk.Transaction[];
  onStage?: (s: "signing" | "submitting" | "confirming") => void;
}): Promise<SubmitResult> {
  const { algod, signTransactions, txns, onStage = () => {} } = input;

  onStage("signing");
  // Already grouped by the SDK; re-assigning the group id would invalidate the
  // assertion that just passed over these exact bytes.
  const signed = await signTransactions(txns.map((t) => algosdk.encodeUnsignedTransaction(t)));
  const blobs = signed.filter((s): s is Uint8Array => !!s);
  if (blobs.length !== txns.length) throw new Error("Signing cancelled.");

  onStage("submitting");
  // Computed BEFORE submission. A dropped socket or a timeout after the node
  // accepted the group used to reject out of `sendRawTransaction`, discarding
  // the id — so the user got "failed" with no link for a group that may well
  // have committed. Nothing forces that: the id is a property of the signed
  // bytes, not of the response.
  const txId = txns[0].txID();
  try {
    await algod.sendRawTransaction(blobs).do();
  } catch (e) {
    throw new SubmissionUnknownError(txId, e instanceof Error ? e.message : String(e));
  }

  // Past this line the money may already have moved. Nothing below may throw
  // away the txid, and a wait that runs out is not a failure.
  onStage("confirming");
  try {
    await algosdk.waitForConfirmation(algod, txId, CONFIRM_ROUNDS);
    return { txId, outcome: "confirmed" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/^Transaction Rejected:/i.test(msg)) {
      return { txId, outcome: "rejected", reason: msg.replace(/^Transaction Rejected:\s*/i, "") };
    }
    return { txId, outcome: "unknown", reason: msg };
  }
}
