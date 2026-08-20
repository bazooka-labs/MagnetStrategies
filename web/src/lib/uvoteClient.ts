// ── UVote — voter writes (cast_vote, claim_tokens) ───────────────────────────
// Signing goes through use-wallet's signTransactions (same as the DAO v1 flow).

import algosdk from "algosdk";
import {
  UVOTE_APP_ID, MAGNET_ASA_ID, VOTE_BOX_MBR,
  propBoxName, voteBoxName,
} from "./uvote";

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
 * Cast a vote: atomic group of 3 —
 *  [0] AppCall cast_vote(proposalId, choiceIndex)
 *  [1] AssetTransfer  whole $U -> contract (locked voting weight)
 *  [2] Payment        VOTE_BOX_MBR -> contract (voter funds their own vote box)
 * `lockBaseUnits` must be a whole-$U multiple (caller floors it).
 */
export async function castVote(
  algod: algosdk.Algodv2,
  signTransactions: SignFn,
  sender: string,
  proposalId: number,
  choiceIndex: number,
  lockBaseUnits: number,
  appId = UVOTE_APP_ID,
): Promise<string> {
  const sp = await algod.getTransactionParams().do();
  const appAddr = algosdk.getApplicationAddress(appId).toString();

  const appCall = algosdk.makeApplicationNoOpTxnFromObject({
    sender,
    appIndex: appId,
    appArgs: [enc.encode("cast_vote"), algosdk.encodeUint64(proposalId), algosdk.encodeUint64(choiceIndex)],
    boxes: [
      { appIndex: appId, name: propBoxName(proposalId) },
      { appIndex: appId, name: voteBoxName(proposalId, sender) },
    ],
    foreignAssets: [MAGNET_ASA_ID],
    suggestedParams: sp,
  });

  const lockXfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender,
    receiver: appAddr,
    assetIndex: MAGNET_ASA_ID,
    amount: lockBaseUnits,
    suggestedParams: sp,
  });

  const mbrPay = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender,
    receiver: appAddr,
    amount: VOTE_BOX_MBR,
    suggestedParams: sp,
  });

  return sendGroup(algod, signTransactions, [appCall, lockXfer, mbrPay]);
}

/**
 * Reclaim locked $U (and the pre-funded MBR) after the window closes.
 * The contract issues two inner txns, so the outer AppCall covers fee=3000.
 */
export async function claimTokens(
  algod: algosdk.Algodv2,
  signTransactions: SignFn,
  sender: string,
  proposalId: number,
  appId = UVOTE_APP_ID,
): Promise<string> {
  const sp = await algod.getTransactionParams().do();
  sp.flatFee = true;
  sp.fee = BigInt(3000); // outer 1000 + 2 inner (asset return + MBR refund)

  const appCall = algosdk.makeApplicationNoOpTxnFromObject({
    sender,
    appIndex: appId,
    appArgs: [enc.encode("claim_tokens"), algosdk.encodeUint64(proposalId)],
    boxes: [
      { appIndex: appId, name: propBoxName(proposalId) },
      { appIndex: appId, name: voteBoxName(proposalId, sender) },
    ],
    foreignAssets: [MAGNET_ASA_ID],
    suggestedParams: sp,
  });

  return sendGroup(algod, signTransactions, [appCall]);
}
