// ── Governance — admin writes (deploy handshake, create_proposal, founder xfer) ─
// Wallet-signed; the connected admin (== MagnetFi admin) becomes the contract
// `founder`. No seed phrase touches a script or a terminal.

import algosdk from "algosdk";
import {
  MVOTE, CONTRACT_FUND_AMOUNT,
  QUESTION_MAX, CHOICE_MAX, PROPOSAL_BOX_SIZE, propBoxName,
  type GovernanceEra,
} from "./governance";
import { getProposalCount } from "./governanceReads";

/**
 * mVote, compiled from `contracts/mvote/mvote/mvote.py` (PyTeal v8).
 *
 * Approval hash: DACCITMPNDIAMKOACRDG7KZWZ6UTNLE6CGCPQKNRHNCPTZGSJRBH6GQ6OM
 * Clear hash:    OHV4S2PM4R3XXXQOIKERQ6OV2OYRZZG6A66XSUVR5ADF4NXVPEZRXMYYQE
 *
 * Verify rather than trust these bytes — the toolchain is reproducible, which
 * was confirmed by compiling UVote with it and matching the deployed app
 * byte-for-byte before any of this was written:
 *
 *   cd contracts/mvote && python3 -c "from pyteal import *; \
 *     from mvote.mvote import approval_program; \
 *     print(compileTeal(approval_program(), mode=Mode.Application, version=8))" \
 *     | curl -s --data-binary @- -H 'Content-Type: text/plain' \
 *       https://mainnet-api.algonode.cloud/v2/teal/compile
 *
 * After deploying, check the live app reports the same hash before trusting the
 * UI against it.
 */
const MVOTE_APPROVAL_B64 =
  "CCAMAAFgIAQQlNIBAwgCKBgmCA9wZW5kaW5nX2ZvdW5kZXILbXVzZF9hc2FfaWQOcHJvcG9zYWxfY291bnQHZm91bmRlcgVwcm9wXwhsYXN0X2VuZAAFdm90ZV8xGCISQANtMRkjEkADZDEZIhJAAAcjQAABACJDNhoAgAlvcHRpbl9hc2ESQAMrNhoAgA9jcmVhdGVfcHJvcG9zYWwSQAIpNhoAgAljYXN0X3ZvdGUSQADVNhoAgAxjbGFpbV90b2tlbnMSQABQNhoAgA51cGRhdGVfZm91bmRlchJAACg2GgCADmFjY2VwdF9mb3VuZGVyEkAAAQAxAChkEkQrKGRnKCcGZyNDiALcNhoBFSUSRCg2GgFnI0MyBCMSRCcENhoBUDURNBG+NRM1EjQTRDIHNBJXCAgXD0QnBzYaATEAUFA1FDQUvjUWNRU0FkQ0FVcICBc1FzQXIg1ENBS8IxJEsSEEshAxALIUKWSyETQXshIisgGzsSOyEDEAsgchBrIIIrIBsyNDMgQhBxJEMRYiEkQzARAhBBJEMwEAMQASRDMBEzIDEkQzARQyChJEMwEVMgMSRDMBESlkEkQzARIiDUQzARKBwIQ9GCISRDMCECMSRDMCADEAEkQzAgcyChJEMwIJMgMSRDMCCCEGEkQnBDYaAVA1BTQFvjUHNQY0B0QyBzQGVwAIFw9EMgc0BlcICBcMRDYaAhc1CDQGVzAIFzUJNAg0CQxEJwc2GgExAFBQNQo0CiEFuTULNAsjEkQzARI1DDQKIjQIFrs0CiEINAwWuzQGVxAIFzUNNAZXGAgXNQ40BlcgCBc1DzQGVygIFzUQNAgiEkAAQDQIIxJAACs0CCEJEkAAFjQIIQcSQAABADQFIQo0EDQMCBa7I0M0BSU0DzQMCBa7Qv/xNAUhCzQONAwIFrtC/+M0BSEFNA00DAgWu0L/1YgBGTIHJwVkD0Q2GgEVgYACDkQ2GgIVIg1ENhoCFSQORDYaAxUiDUQ2GgMVJA5ENhoEFSQORDYaBRUkDkQ2GgUVIhI2GgQVIg0RRCoqZCMIZypkNQAnBDQAFlA1ATIHNQI0AoGA9SQINQMhCTYaBBUiDQg2GgUVIg0INQQ0AYG4BbkjEkQ0ASI0Aha7NAEhCDQDFrs0ASEFIha7NAEhCyIWuzQBJSIWuzQBIQoiFrs0AYEwNAQWuzQBgTg2GgG7NAGBuAI2GgK7NAGBmAM2GgO7NAGB+AM2GgS7NAGB2AQ2GgW7JwU0A2cjQ4gAL7EhBLIQMgqyFClkshEishIisgGzI0MiQysxAGcpNhoAF2cqImcoJwZnJwUiZyNDigAAMQArZBJEiQ==";
const MVOTE_CLEAR_B64 = "CIEBQw==";

// Proposal box MBR: 2500 + 400*(key 13 + value 696) = 286,100 µALGO. Bundled
// with create_proposal so the app account can always fund the new box. The
// contract does not require this payment — it checks the box was created, and
// an under-funded app fails that — so sending it is how the UI makes the
// founder's own call succeed rather than a guard it satisfies.
const PROPOSAL_BOX_MBR = 2500 + 400 * (13 + PROPOSAL_BOX_SIZE); // 286_100

type SignFn = (txns: Uint8Array[]) => Promise<(Uint8Array | null)[]>;
const enc = new TextEncoder();
const b64ToBytes = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

async function signSend(
  algod: algosdk.Algodv2, sign: SignFn, txns: algosdk.Transaction[],
): Promise<{ txid: string; confirmed: algosdk.modelsv2.PendingTransactionResponse }> {
  if (txns.length > 1) algosdk.assignGroupID(txns);
  const signed = await sign(txns.map((t) => algosdk.encodeUnsignedTransaction(t)));
  const blobs = signed.filter((s): s is Uint8Array => !!s);
  if (blobs.length !== txns.length) throw new Error("Transaction signing cancelled.");
  const res = await algod.sendRawTransaction(blobs).do();
  const confirmed = await algosdk.waitForConfirmation(algod, res.txid, 4);
  return { txid: res.txid, confirmed };
}

export type DeployStep = "create" | "setup";

/**
 * The deploy handshake — two signed steps the admin approves in-wallet:
 *   1. Create the mVote app (founder = signer, schema uints=3 / bytes=2,
 *      appArgs = [mUSD asa id] — set at creation, with no setter, forever).
 *   2. Fund the app + optin_asa so it can custody and return mUSD.
 *
 * The funding is not optional padding. The app must hold at least one vote-box
 * MBR at all times: the vote box is created at group index 0 but the voter's
 * MBR payment settles at index 2, so without a standing buffer the FIRST vote
 * fails its own min-balance check. UVote's audit raised this as L1 and the same
 * gap exists here; 0.4 ALGO covers base 0.1 + ASA opt-in 0.1 + that buffer.
 *
 * Returns the new App ID to paste into MVOTE_APP_IDS in governance.ts.
 */
export async function deployMVote(
  algod: algosdk.Algodv2,
  sign: SignFn,
  sender: string,
  onStep?: (step: DeployStep) => void,
): Promise<{ appId: number; appAddress: string }> {
  onStep?.("create");
  const sp = await algod.getTransactionParams().do();
  const createTxn = algosdk.makeApplicationCreateTxnFromObject({
    sender,
    suggestedParams: sp,
    onComplete: algosdk.OnApplicationComplete.NoOpOC,
    approvalProgram: b64ToBytes(MVOTE_APPROVAL_B64),
    clearProgram: b64ToBytes(MVOTE_CLEAR_B64),
    numGlobalInts: 3,
    numGlobalByteSlices: 2,
    numLocalInts: 0,
    numLocalByteSlices: 0,
    appArgs: [algosdk.encodeUint64(MVOTE.asaId)],
  });
  const { confirmed: created } = await signSend(algod, sign, [createTxn]);
  const appId = Number(created.applicationIndex);
  if (!appId) throw new Error("App creation did not return an application id.");
  const appAddress = algosdk.getApplicationAddress(appId).toString();

  onStep?.("setup");
  const sp2 = await algod.getTransactionParams().do();
  const fund = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender, receiver: appAddress, amount: CONTRACT_FUND_AMOUNT, suggestedParams: sp2,
  });
  const optin = algosdk.makeApplicationNoOpTxnFromObject({
    sender,
    appIndex: appId,
    appArgs: [enc.encode("optin_asa")],
    foreignAssets: [MVOTE.asaId],
    suggestedParams: { ...sp2, flatFee: true, fee: BigInt(2000) }, // outer + 1 inner
  });
  await signSend(algod, sign, [fund, optin]);

  return { appId, appAddress };
}

/**
 * Founder creates a 7-day proposal. `choices` is 2–4 non-empty labels.
 *
 * The contract allows only one open window at a time, so this fails while a
 * proposal is still running. That is the griefing guard, not a bug.
 */
export async function createProposal(
  algod: algosdk.Algodv2,
  sign: SignFn,
  sender: string,
  question: string,
  choices: string[],
  era: GovernanceEra = MVOTE,
): Promise<string> {
  if (era.retired) {
    throw new Error(`${era.name} is retired and no longer accepts proposals.`);
  }
  if (!era.appId) {
    throw new Error(`${era.name} is not deployed yet.`);
  }
  const q = question.trim();
  const cleaned = choices.map((c) => c.trim());
  if (q.length === 0 || q.length > QUESTION_MAX) throw new Error("Question must be 1–256 characters.");
  if (cleaned.length < 2 || cleaned.length > 4) throw new Error("Provide 2–4 choices.");
  if (!cleaned[0] || !cleaned[1]) throw new Error("Choices A and B are required.");
  if (cleaned.some((c) => c.length > CHOICE_MAX)) throw new Error("Each choice must be ≤ 96 characters.");
  // The contract enforces contiguity (D requires C) and would reject this, but
  // a wallet prompt that fails on submit is a worse way to learn it.
  if (!cleaned[2] && cleaned[3]) throw new Error("Choice C is required before choice D.");

  const nextId = (await getProposalCount(algod, era)) + 1;
  const [a, b, c = "", d = ""] = cleaned;

  const sp = await algod.getTransactionParams().do();
  const appAddress = algosdk.getApplicationAddress(era.appId).toString();

  const mbr = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender, receiver: appAddress, amount: PROPOSAL_BOX_MBR, suggestedParams: sp,
  });

  const call = algosdk.makeApplicationNoOpTxnFromObject({
    sender,
    appIndex: era.appId,
    appArgs: [
      enc.encode("create_proposal"),
      enc.encode(q), enc.encode(a), enc.encode(b), enc.encode(c), enc.encode(d),
    ],
    boxes: [{ appIndex: era.appId, name: propBoxName(nextId) }],
    suggestedParams: sp,
  });

  const { txid } = await signSend(algod, sign, [mbr, call]);
  return txid;
}

/** Optional: hand founder authority to another wallet (two-step: this + accept). */
export async function updateFounder(
  algod: algosdk.Algodv2, sign: SignFn, sender: string, newFounder: string,
  era: GovernanceEra = MVOTE,
): Promise<void> {
  const sp = await algod.getTransactionParams().do();
  const call = algosdk.makeApplicationNoOpTxnFromObject({
    sender,
    appIndex: era.appId,
    appArgs: [enc.encode("update_founder"), algosdk.decodeAddress(newFounder).publicKey],
    suggestedParams: sp,
  });
  await signSend(algod, sign, [call]);
}
