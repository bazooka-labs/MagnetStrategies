// ── Governance — voter writes (cast_vote, claim_tokens) ─────────────────────
// Signing goes through use-wallet's signTransactions.

import algosdk from "algosdk";
import {
  MVOTE, VOTE_BOX_MBR, propBoxName, voteBoxName,
  type GovernanceEra,
} from "./governance";

type SignFn = (txns: Uint8Array[]) => Promise<(Uint8Array | null)[]>;

const enc = new TextEncoder();

async function sendGroup(
  algod: algosdk.Algodv2, signTransactions: SignFn, txns: algosdk.Transaction[],
): Promise<string> {
  if (txns.length > 1) algosdk.assignGroupID(txns);
  const signed = await signTransactions(txns.map((t) => algosdk.encodeUnsignedTransaction(t)));
  const blobs = signed.filter((s): s is Uint8Array => !!s);
  if (blobs.length !== txns.length) throw new Error("Transaction signing cancelled.");
  const res = await algod.sendRawTransaction(blobs).do();
  await algosdk.waitForConfirmation(algod, res.txid, 4);
  return res.txid;
}

/**
 * Cast a vote: atomic group of 3, in this order —
 *  [0] Payment        VOTE_BOX_MBR -> contract (voter funds their own vote box)
 *  [1] AssetTransfer  whole mUSD -> contract (locked voting weight)
 *  [2] AppCall cast_vote(proposalId, choiceIndex)
 *
 * The payment comes FIRST and the contract asserts it. Algorand checks an
 * account's minimum balance at the end of each transaction rather than at the
 * end of the group, so an app call that creates the vote box before the ALGO
 * covering it has landed forces the app to carry a standing 26,900 µALGO
 * buffer — which is the deploy requirement UVote's audit could never close,
 * because that app is immutable. Reordering closes it. Do not resequence this.
 *
 * `lockBaseUnits` must be a whole-token multiple; the contract asserts it and
 * the caller floors it. Only an `accepting` era can be voted in — the retired
 * $U app is readable and claimable, never votable, and that is enforced here
 * rather than left to whoever builds a button.
 */
export async function castVote(
  algod: algosdk.Algodv2,
  signTransactions: SignFn,
  sender: string,
  proposalId: number,
  choiceIndex: number,
  lockBaseUnits: number,
  era: GovernanceEra = MVOTE,
): Promise<string> {
  // Two different refusals, because they are two different facts about the
  // world and a voter deserves the right one.
  if (era.retired) {
    throw new Error(`${era.name} is retired and no longer accepts votes.`);
  }
  if (!era.appId) {
    throw new Error(`${era.name} is not deployed yet.`);
  }
  if (lockBaseUnits <= 0 || lockBaseUnits % 10 ** era.decimals !== 0) {
    throw new Error(`Lock a whole number of ${era.unit}.`);
  }

  const sp = await algod.getTransactionParams().do();
  const appAddr = algosdk.getApplicationAddress(era.appId).toString();

  const appCall = algosdk.makeApplicationNoOpTxnFromObject({
    sender,
    appIndex: era.appId,
    appArgs: [
      enc.encode("cast_vote"),
      algosdk.encodeUint64(proposalId),
      algosdk.encodeUint64(choiceIndex),
    ],
    boxes: [
      { appIndex: era.appId, name: propBoxName(proposalId) },
      { appIndex: era.appId, name: voteBoxName(proposalId, sender) },
    ],
    foreignAssets: [era.asaId],
    suggestedParams: sp,
  });

  const lockXfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender,
    receiver: appAddr,
    assetIndex: era.asaId,
    amount: lockBaseUnits,
    suggestedParams: sp,
  });

  const mbrPay = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender,
    receiver: appAddr,
    amount: VOTE_BOX_MBR,
    suggestedParams: sp,
  });

  return sendGroup(algod, signTransactions, [mbrPay, lockXfer, appCall]);
}

/**
 * Reclaim locked tokens (and the pre-funded MBR) after the window closes.
 *
 * Works on ANY era, including the retired $U app. That is the point: measured
 * 2026-11-05 nobody has an outstanding $U lock, but a measurement is about one
 * moment and a stranded voter is forever, so the path stays.
 *
 * Sent alone, never grouped — mVote asserts `group_size == 1` on this call.
 * The contract issues two inner txns, so the outer AppCall covers fee=3000.
 */
export async function claimTokens(
  algod: algosdk.Algodv2,
  signTransactions: SignFn,
  sender: string,
  proposalId: number,
  era: GovernanceEra = MVOTE,
): Promise<string> {
  const sp = await algod.getTransactionParams().do();
  sp.flatFee = true;
  sp.fee = BigInt(3000); // outer 1000 + 2 inner (asset return + MBR refund)

  const appCall = algosdk.makeApplicationNoOpTxnFromObject({
    sender,
    appIndex: era.appId,
    appArgs: [enc.encode("claim_tokens"), algosdk.encodeUint64(proposalId)],
    boxes: [
      { appIndex: era.appId, name: propBoxName(proposalId) },
      { appIndex: era.appId, name: voteBoxName(proposalId, sender) },
    ],
    foreignAssets: [era.asaId],
    suggestedParams: sp,
  });

  return sendGroup(algod, signTransactions, [appCall]);
}
