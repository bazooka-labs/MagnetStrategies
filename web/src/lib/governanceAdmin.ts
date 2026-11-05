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
 * Approval hash: WSIBLQX6LOIRT4KHAXFOZEV4JPMNN6ZFLNW5UMTZMR44YN4EZG2N4WEM3Q
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
  "CCAMAAFgIAQCEJTSAQMIKBgmCA9wZW5kaW5nX2ZvdW5kZXILbXVzZF9hc2FfaWQOcHJvcG9zYWxfY291bnQHZm91bmRlcgVwcm9wXwhsYXN0X2VuZAAFdm90ZV8xGCISQANuMRkjEkADZTEZIhJAAAcjQAABACJDNhoAgAlvcHRpbl9hc2ESQAMsNhoAgA9jcmVhdGVfcHJvcG9zYWwSQAIqNhoAgAljYXN0X3ZvdGUSQADVNhoAgAxjbGFpbV90b2tlbnMSQABQNhoAgA51cGRhdGVfZm91bmRlchJAACg2GgCADmFjY2VwdF9mb3VuZGVyEkAAAQAxAChkEkQrKGRnKCcGZyNDiALdNhoBFSUSRCg2GgFnI0MyBCMSRCcENhoBUDURNBG+NRM1EjQTRDIHNBJXCAgXD0QnBzYaATEAUFA1FDQUvjUWNRU0FkQ0FVcICBc1FzQXIg1ENBS8IxJEsSEEshAxALIUKWSyETQXshIisgGzsSOyEDEAsgchB7IIIrIBsyNDMgQhCBJEMRYhBRJEMwAQIxJEMwAAMQASRDMABzIKEkQzAAkyAxJEMwAIIQcSRDMBECEEEkQzAQAxABJEMwETMgMSRDMBFDIKEkQzARUyAxJEMwERKWQSRDMBEiINRDMBEoHAhD0YIhJEJwQ2GgFQNQU0Bb41BzUGNAdEMgc0BlcACBcPRDIHNAZXCAgXDEQ2GgIXNQg0BlcwCBc1CTQINAkMRCcHNhoBMQBQUDUKNAohBrk1CzQLIxJEMwESNQw0CiI0CBa7NAohCTQMFrs0BlcQCBc1DTQGVxgIFzUONAZXIAgXNQ80BlcoCBc1EDQIIhJAAEA0CCMSQAArNAghBRJAABY0CCEIEkAAAQA0BSEKNBA0DAgWuyNDNAUlNA80DAgWu0L/8TQFIQs0DjQMCBa7Qv/jNAUhBjQNNAwIFrtC/9WIARkyBycFZA9ENhoBFYGAAg5ENhoCFSINRDYaAhUkDkQ2GgMVIg1ENhoDFSQORDYaBBUkDkQ2GgUVJA5ENhoFFSISNhoEFSINEUQqKmQjCGcqZDUAJwQ0ABZQNQEyBzUCNAKBgPUkCDUDIQU2GgQVIg0INhoFFSINCDUENAGBuAW5IxJENAEiNAIWuzQBIQk0Axa7NAEhBiIWuzQBIQsiFrs0ASUiFrs0ASEKIha7NAGBMDQEFrs0AYE4NhoBuzQBgbgCNhoCuzQBgZgDNhoDuzQBgfgDNhoEuzQBgdgENhoFuycFNANnI0OIAC+xIQSyEDIKshQpZLIRIrISIrIBsyNDIkMrMQBnKTYaABdnKiJnKCcGZycFImcjQ4oAADEAK2QSRIk=";
const MVOTE_CLEAR_B64 = "CIEBQw==";

// Proposal box MBR: 2500 + 400*(key 13 + value 696) = 286,100 µALGO. Bundled
// with create_proposal so the app account can always fund the new box. The
// contract does not require this payment — it checks the box was created, and
// an under-funded app fails that — so sending it is how the UI makes the
// founder's own call succeed rather than a guard it satisfies.
const PROPOSAL_BOX_MBR = 2500 + 400 * (13 + PROPOSAL_BOX_SIZE); // 286_100

type SignFn = (txns: Uint8Array[]) => Promise<(Uint8Array | null)[]>;
const enc = new TextEncoder();
/** What the contract's `Len()` actually measures. */
export const byteLen = (s: string): number => enc.encode(s).length;
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
 * Step 2 on its own: fund the app and opt it into mUSD.
 *
 * Separate and exported so a half-finished deploy can be FINISHED instead of
 * repeated. Step 1 creates a real app on mainnet; if step 2 was then rejected
 * in the wallet, or the connection dropped, the old code threw away the App ID
 * and the only way forward was to click Deploy again — creating a second,
 * permanently inert app and leaving the operator to dig the first one out of
 * the indexer by hand.
 *
 * Safe to re-run against an app that is already set up: `optin_asa` on an
 * existing holding is a zero-amount transfer to itself, and extra funding only
 * raises the buffer.
 */
export async function setupMVote(
  algod: algosdk.Algodv2,
  sign: SignFn,
  sender: string,
  appId: number,
): Promise<void> {
  const appAddress = algosdk.getApplicationAddress(appId).toString();
  const sp = await algod.getTransactionParams().do();
  const fund = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender, receiver: appAddress, amount: CONTRACT_FUND_AMOUNT, suggestedParams: sp,
  });
  const optin = algosdk.makeApplicationNoOpTxnFromObject({
    sender,
    appIndex: appId,
    appArgs: [enc.encode("optin_asa")],
    foreignAssets: [MVOTE.asaId],
    suggestedParams: { ...sp, flatFee: true, fee: BigInt(2000) }, // outer + 1 inner
  });
  await signSend(algod, sign, [fund, optin]);
}

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
  /**
   * Fired the instant step 1 confirms, BEFORE step 2 is attempted.
   *
   * The App ID exists from that moment and is unrecoverable from this function
   * if step 2 throws. Hand it to the caller immediately so it can be shown
   * even on a failure.
   */
  onCreated?: (appId: number) => void,
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
  onCreated?.(appId);

  onStep?.("setup");
  await setupMVote(algod, sign, sender, appId);

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
  // BYTES, not characters. The contract asserts `Len(arg) <= 256`, and Len is
  // a byte length, while `String.length` counts UTF-16 units. One emoji is 4
  // bytes and 2 units, so a "251-character" question could be 300+ bytes and
  // fail the assert after the founder had already signed.
  if (q.length === 0) throw new Error("Question must not be empty.");
  if (byteLen(q) > QUESTION_MAX) {
    throw new Error(`Question is ${byteLen(q)} bytes; the limit is ${QUESTION_MAX}. `
      + "Accented characters and emoji take more than one byte each.");
  }
  if (cleaned.length < 2 || cleaned.length > 4) throw new Error("Provide 2–4 choices.");
  if (!cleaned[0] || !cleaned[1]) throw new Error("Choices A and B are required.");
  const tooLong = cleaned.find((c) => byteLen(c) > CHOICE_MAX);
  if (tooLong !== undefined) {
    throw new Error(`Choice "${tooLong.slice(0, 20)}…" is ${byteLen(tooLong)} bytes; `
      + `the limit is ${CHOICE_MAX}.`);
  }
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

/**
 * Step 2 of the founder transfer, signed by the INCOMING wallet.
 *
 * The contract has always had this; the UI never did, so a key rotation needed
 * a hand-written script and the protocol's only governance key could not be
 * rotated through its own admin panel.
 */
export async function acceptFounder(
  algod: algosdk.Algodv2, sign: SignFn, sender: string, era: GovernanceEra = MVOTE,
): Promise<void> {
  const sp = await algod.getTransactionParams().do();
  await signSend(algod, sign, [algosdk.makeApplicationNoOpTxnFromObject({
    sender, appIndex: era.appId, appArgs: [enc.encode("accept_founder")], suggestedParams: sp,
  })]);
}

/** Step 1: nominate a new founder. Nothing changes until they accept. */
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
