// ── Governance — read-only on-chain queries (algosdk only, no signing) ──────

import algosdk from "algosdk";
import {
  GOVERNANCE_ERAS, MVOTE, TREASURY_ADDRESS, USDC_ASA_ID,
  propBoxName, voteBoxName, decodeProposal, decodeVote,
  type GovernanceEra, type Proposal, type VoteRecord,
} from "./governance";

function globalUint(app: algosdk.modelsv2.Application, key: string): number | undefined {
  const target = Buffer.from(key).toString("base64");
  for (const kv of app.params.globalState ?? []) {
    const k = typeof kv.key === "string" ? kv.key : Buffer.from(kv.key).toString("base64");
    if (k === target && kv.value.type === 2) return Number(kv.value.uint);
  }
  return undefined;
}

/** Proposals ever created in an era (ids run 1..count). 0 if not deployed. */
export async function getProposalCount(
  algod: algosdk.Algodv2, era: GovernanceEra,
): Promise<number> {
  if (!era.appId) return 0;
  const app = await algod.getApplicationByID(era.appId).do();
  return globalUint(app, "proposal_count") ?? 0;
}

export async function getProposal(
  algod: algosdk.Algodv2, era: GovernanceEra, id: number,
): Promise<Proposal | null> {
  if (!era.appId) return null;
  try {
    const box = await algod.getApplicationBoxByName(era.appId, propBoxName(id)).do();
    return decodeProposal(era, id, box.value);
  } catch {
    return null;
  }
}

/** One era's proposals, newest first. */
export async function listEraProposals(
  algod: algosdk.Algodv2, era: GovernanceEra,
): Promise<Proposal[]> {
  const count = await getProposalCount(algod, era);
  if (count === 0) return [];
  const ids = Array.from({ length: count }, (_, i) => count - i); // count..1
  const results = await Promise.all(ids.map((id) => getProposal(algod, era, id)));
  return results.filter((p): p is Proposal => p !== null);
}

/**
 * Every proposal from every era, newest first.
 *
 * Eras are read in parallel and one era failing does not blank the others: a
 * dead read on the retired app must not take the live vote off the page. Sorted
 * by end time across eras rather than concatenated, so the list reads as one
 * history even though it spans two contracts.
 */
export async function listProposals(algod: algosdk.Algodv2): Promise<Proposal[]> {
  const perEra = await Promise.all(
    GOVERNANCE_ERAS.map((era) => listEraProposals(algod, era).catch(() => [] as Proposal[])),
  );
  return perEra.flat().sort((a, b) => b.endTime - a.endTime);
}

/** This voter's record for a proposal, or null if they never voted (or claimed). */
export async function getVoteRecord(
  algod: algosdk.Algodv2, era: GovernanceEra, proposalId: number, voter: string,
): Promise<VoteRecord | null> {
  if (!era.appId) return null;
  try {
    const box = await algod.getApplicationBoxByName(
      era.appId, voteBoxName(proposalId, voter)).do();
    return decodeVote(era, proposalId, box.value);
  } catch {
    return null;
  }
}

/** Balance (base units) of an era's voting asset for an address. 0 if not opted in. */
export async function getVotingBalance(
  algod: algosdk.Algodv2, address: string, era: GovernanceEra = MVOTE,
): Promise<number> {
  try {
    const acct = await algod.accountInformation(address).do();
    const holding = (acct.assets ?? []).find((a) => Number(a.assetId) === era.asaId);
    return holding ? Number(holding.amount) : 0;
  } catch {
    return 0;
  }
}

/** Treasury wallet USDC balance (base units). 0 if not opted in / unreachable. */
export async function getTreasuryUsdc(algod: algosdk.Algodv2): Promise<number> {
  try {
    const acct = await algod.accountInformation(TREASURY_ADDRESS).do();
    const holding = (acct.assets ?? []).find((a) => Number(a.assetId) === USDC_ASA_ID);
    return holding ? Number(holding.amount) : 0;
  } catch {
    return 0;
  }
}
