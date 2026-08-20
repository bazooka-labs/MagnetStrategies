// ── UVote — read-only on-chain queries (algosdk only, no signing) ────────────

import algosdk from "algosdk";
import {
  UVOTE_APP_ID, MAGNET_ASA_ID,
  propBoxName, voteBoxName, decodeProposal, decodeVote,
  type UVoteProposal, type UVoteRecord,
} from "./uvote";

function globalUint(app: algosdk.modelsv2.Application, key: string): number | undefined {
  const target = Buffer.from(key).toString("base64");
  for (const kv of app.params.globalState ?? []) {
    const k = typeof kv.key === "string" ? kv.key : Buffer.from(kv.key).toString("base64");
    if (k === target && kv.value.type === 2) return Number(kv.value.uint);
  }
  return undefined;
}

/** Number of proposals ever created (proposal ids run 1..count). 0 if not deployed. */
export async function getProposalCount(algod: algosdk.Algodv2, appId = UVOTE_APP_ID): Promise<number> {
  if (!appId) return 0;
  const app = await algod.getApplicationByID(appId).do();
  return globalUint(app, "proposal_count") ?? 0;
}

export async function getProposal(
  algod: algosdk.Algodv2, id: number, appId = UVOTE_APP_ID,
): Promise<UVoteProposal | null> {
  if (!appId) return null;
  try {
    const box = await algod.getApplicationBoxByName(appId, propBoxName(id)).do();
    return decodeProposal(id, box.value);
  } catch {
    return null;
  }
}

/** All proposals, newest first. */
export async function listProposals(algod: algosdk.Algodv2, appId = UVOTE_APP_ID): Promise<UVoteProposal[]> {
  const count = await getProposalCount(algod, appId);
  if (count === 0) return [];
  const ids = Array.from({ length: count }, (_, i) => count - i); // count..1
  const results = await Promise.all(ids.map((id) => getProposal(algod, id, appId)));
  return results.filter((p): p is UVoteProposal => p !== null);
}

/** This voter's record for a proposal, or null if they haven't voted (or already claimed). */
export async function getVoteRecord(
  algod: algosdk.Algodv2, proposalId: number, voter: string, appId = UVOTE_APP_ID,
): Promise<UVoteRecord | null> {
  if (!appId) return null;
  try {
    const box = await algod.getApplicationBoxByName(appId, voteBoxName(proposalId, voter)).do();
    return decodeVote(proposalId, box.value);
  } catch {
    return null;
  }
}

/** $U balance (base units) for an address. 0 if not opted in. */
export async function getUBalance(algod: algosdk.Algodv2, address: string): Promise<number> {
  try {
    const acct = await algod.accountInformation(address).do();
    const holding = (acct.assets ?? []).find((a) => Number(a.assetId) === MAGNET_ASA_ID);
    return holding ? Number(holding.amount) : 0;
  } catch {
    return 0;
  }
}
