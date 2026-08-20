// ── UVote — admin writes (deploy handshake, create_proposal, founder transfer) ─
// Wallet-signed; the connected admin (== MagnetFi admin) becomes the contract
// `founder`. Bytecode below is compiled from contracts/magnetdao/uvote/uvote.py
// (PyTeal v8) — approval hash VQXFHFXPBUWFAH6QLIA5VZNEETAHQM3HVCRIKIO7HAB2HR5HZNHX64W55E.

import algosdk from "algosdk";
import {
  UVOTE_APP_ID, MAGNET_ASA_ID, CONTRACT_FUND_AMOUNT,
  QUESTION_MAX, CHOICE_MAX, PROPOSAL_BOX_SIZE, propBoxName,
} from "./uvote";
import { getProposalCount } from "./uvoteReads";

const UVOTE_APPROVAL_B64 =
  "CCAMAAFgIAQQlNIBAwgCKBgmCA9wZW5kaW5nX2ZvdW5kZXINbWFnbmV0X2FzYV9pZA5wcm9wb3NhbF9jb3VudAdmb3VuZGVyBXByb3BfCGxhc3RfZW5kAAV2b3RlXzEYIhJAA2QxGSMSQANbMRkiEkAAByNAAAEAIkM2GgCACW9wdGluX2FzYRJAAyI2GgCAD2NyZWF0ZV9wcm9wb3NhbBJAAiI2GgCACWNhc3Rfdm90ZRJAAM42GgCADGNsYWltX3Rva2VucxJAAFA2GgCADnVwZGF0ZV9mb3VuZGVyEkAAKDYaAIAOYWNjZXB0X2ZvdW5kZXISQAABADEAKGQSRCsoZGcoJwZnI0OIAtM2GgEVJRJEKDYaAWcjQycENhoBUDURNBG+NRM1EjQTRDIHNBJXCAgXD0QnBzYaATEAUFA1FDQUvjUWNRU0FkQ0FVcICBc1FzQXIg1ENBS8SLEhBLIQMQCyFClkshE0F7ISIrIBs7EjshAxALIHIQayCCKyAbMjQzIEIQcSRDEWIhJEMwEQIQQSRDMBADEAEkQzARMyAxJEMwEUMgoSRDMBFTIDEkQzAREpZBJEMwESIg1EMwESgaCNBhgiEkQzAhAjEkQzAgAxABJEMwIHMgoSRDMCCTIDEkQzAgghBhJEJwQ2GgFQNQU0Bb41BzUGNAdEMgc0BlcACBcPRDIHNAZXCAgXDEQ2GgIXNQg0BlcwCBc1CTQINAkMRCcHNhoBMQBQUDUKNAohBbk1CzQLIxJEMwESNQw0CiI0CBa7NAohCDQMFrs0BlcQCBc1DTQGVxgIFzUONAZXIAgXNQ80BlcoCBc1EDQIIhJAAEA0CCMSQAArNAghCRJAABY0CCEHEkAAAQA0BSEKNBA0DAgWuyNDNAUlNA80DAgWu0L/8TQFIQs0DjQMCBa7Qv/jNAUhBTQNNAwIFrtC/9WIARcyBycFZA9ENhoBFYGAAg5ENhoCFSINRDYaAhUkDkQ2GgMVIg1ENhoDFSQORDYaBBUkDkQ2GgUVJA5ENhoFFSISNhoEFSINEUQqKmQjCGcqZDUAJwQ0ABZQNQEyBzUCNAKBgPUkCDUDIQk2GgQVIg0INhoFFSINCDUENAGBuAW5SDQBIjQCFrs0ASEINAMWuzQBIQUiFrs0ASELIha7NAElIha7NAEhCiIWuzQBgTA0BBa7NAGBODYaAbs0AYG4AjYaArs0AYGYAzYaA7s0AYH4AzYaBLs0AYHYBDYaBbsnBTQDZyNDiAAvsSEEshAyCrIUKWSyESKyEiKyAbMjQyJDKzEAZyk2GgAXZyoiZygnBmcnBSJnI0OKAAAxACtkEkSJ";
const UVOTE_CLEAR_B64 = "CIEBQw==";

// Proposal box MBR: 2500 + 400*(key 13 + value 696) = 286,100 µALGO. Bundled with
// create_proposal so the app account can always fund the new box.
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
 *   1. Create the UVote app (founder = signer, schema uints=3 / bytes=2).
 *   2. Fund the app + optin_asa so it can custody/return $U.
 * Returns the new App ID to paste into uvote.ts (UVOTE_APP_IDS).
 */
export async function deployUVote(
  algod: algosdk.Algodv2,
  sign: SignFn,
  sender: string,
  onStep?: (step: DeployStep) => void,
): Promise<{ appId: number; appAddress: string }> {
  // Step 1 — create
  onStep?.("create");
  const sp = await algod.getTransactionParams().do();
  const createTxn = algosdk.makeApplicationCreateTxnFromObject({
    sender,
    suggestedParams: sp,
    onComplete: algosdk.OnApplicationComplete.NoOpOC,
    approvalProgram: b64ToBytes(UVOTE_APPROVAL_B64),
    clearProgram: b64ToBytes(UVOTE_CLEAR_B64),
    numGlobalInts: 3,
    numGlobalByteSlices: 2,
    numLocalInts: 0,
    numLocalByteSlices: 0,
    appArgs: [algosdk.encodeUint64(MAGNET_ASA_ID)],
  });
  const { confirmed: created } = await signSend(algod, sign, [createTxn]);
  const appId = Number(created.applicationIndex);
  if (!appId) throw new Error("App creation did not return an application id.");
  const appAddress = algosdk.getApplicationAddress(appId).toString();

  // Step 2 — fund + optin_asa (grouped: one wallet prompt)
  onStep?.("setup");
  const sp2 = await algod.getTransactionParams().do();
  const fund = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender, receiver: appAddress, amount: CONTRACT_FUND_AMOUNT, suggestedParams: sp2,
  });
  const optin = algosdk.makeApplicationNoOpTxnFromObject({
    sender,
    appIndex: appId,
    appArgs: [enc.encode("optin_asa")],
    foreignAssets: [MAGNET_ASA_ID],
    suggestedParams: { ...sp2, flatFee: true, fee: BigInt(2000) }, // outer + 1 inner optin
  });
  await signSend(algod, sign, [fund, optin]);

  return { appId, appAddress };
}

/**
 * Founder creates a 7-day proposal. Bundles the proposal-box MBR payment so the
 * app can always afford the new box. `choices` is 2–4 non-empty labels.
 */
export async function createProposal(
  algod: algosdk.Algodv2,
  sign: SignFn,
  sender: string,
  question: string,
  choices: string[],
  appId = UVOTE_APP_ID,
): Promise<string> {
  const q = question.trim();
  const cleaned = choices.map((c) => c.trim());
  if (q.length === 0 || q.length > QUESTION_MAX) throw new Error("Question must be 1–256 characters.");
  if (cleaned.length < 2 || cleaned.length > 4) throw new Error("Provide 2–4 choices.");
  if (!cleaned[0] || !cleaned[1]) throw new Error("Choices A and B are required.");
  if (cleaned.some((c) => c.length > CHOICE_MAX)) throw new Error("Each choice must be ≤ 96 characters.");

  const nextId = (await getProposalCount(algod, appId)) + 1;
  const [a, b, c = "", d = ""] = cleaned;

  const sp = await algod.getTransactionParams().do();
  const appAddress = algosdk.getApplicationAddress(appId).toString();

  const mbr = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender, receiver: appAddress, amount: PROPOSAL_BOX_MBR, suggestedParams: sp,
  });

  const call = algosdk.makeApplicationNoOpTxnFromObject({
    sender,
    appIndex: appId,
    appArgs: [
      enc.encode("create_proposal"),
      enc.encode(q), enc.encode(a), enc.encode(b), enc.encode(c), enc.encode(d),
    ],
    boxes: [{ appIndex: appId, name: propBoxName(nextId) }],
    suggestedParams: sp,
  });

  const { txid } = await signSend(algod, sign, [mbr, call]);
  return txid;
}

/** Optional: hand founder authority to another wallet (two-step: this + accept). */
export async function updateFounder(
  algod: algosdk.Algodv2, sign: SignFn, sender: string, newFounder: string, appId = UVOTE_APP_ID,
): Promise<void> {
  const sp = await algod.getTransactionParams().do();
  const call = algosdk.makeApplicationNoOpTxnFromObject({
    sender,
    appIndex: appId,
    appArgs: [enc.encode("update_founder"), algosdk.decodeAddress(newFounder).publicKey],
    suggestedParams: sp,
  });
  await signSend(algod, sign, [call]);
}
