// ── Governance — read-only on-chain queries (algosdk only, no signing) ──────

import algosdk from "algosdk";
import {
  GOVERNANCE_ERAS, MVOTE, TREASURY_ADDRESS, USDC_ASA_ID,
  propBoxName, voteBoxName, decodeProposal, decodeVote,
  type GovernanceEra, type Proposal, type VoteRecord,
} from "./governance";

/**
 * A 404 from algod means the box genuinely does not exist. Anything else — a
 * 429, a 5xx, a dropped connection — means we DO NOT KNOW, and the two must
 * not collapse into the same answer.
 *
 * They used to. Every read here caught and returned null/0, so a rate-limited
 * node turned a live proposal into "Nothing to vote on right now", a cast vote
 * into "you have not voted", and a 5,000 mUSD balance into "you need at least
 * 1 mUSD to vote". Each of those is a confident false statement built from a
 * network blip.
 */
function isNotFound(e: unknown): boolean {
  const status = (e as { status?: number })?.status;
  // A status is authoritative BOTH ways. Falling through to the message when a
  // status says 500 let a body that merely contained "404" — a digit run in an
  // id, say — be read as "absent", which is the exact confusion this function
  // exists to prevent.
  if (typeof status === "number") return status === 404;
  const msg = String((e as Error)?.message ?? e);
  return /\b404\b|not found|no such box/i.test(msg);
}

function globalUint(app: algosdk.modelsv2.Application, key: string): number | undefined {
  const target = Buffer.from(key).toString("base64");
  for (const kv of app.params.globalState ?? []) {
    const k = typeof kv.key === "string" ? kv.key : Buffer.from(kv.key).toString("base64");
    if (k === target && kv.value.type === 2) return Number(kv.value.uint);
  }
  return undefined;
}

/**
 * The on-chain `founder` address, or null if unreadable / not deployed.
 *
 * The admin panel used to gate on a hard-coded constant, which meant a founder
 * transfer left the NEW founder unable to see the panel and the OLD one still
 * looking at it while their calls failed on chain. Authority lives in the
 * contract; the UI should ask it.
 */
export async function getFounder(
  algod: algosdk.Algodv2, era: GovernanceEra = MVOTE,
): Promise<string | null> {
  if (!era.appId) return null;
  try {
    const app = await algod.getApplicationByID(era.appId).do();
    const target = Buffer.from("founder").toString("base64");
    for (const kv of app.params.globalState ?? []) {
      const k = typeof kv.key === "string" ? kv.key : Buffer.from(kv.key).toString("base64");
      if (k !== target || kv.value.type !== 1) continue;
      const raw = typeof kv.value.bytes === "string"
        ? new Uint8Array(Buffer.from(kv.value.bytes, "base64"))
        : new Uint8Array(kv.value.bytes ?? []);
      if (raw.length !== 32) return null;
      return algosdk.encodeAddress(raw);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * `last_end` — when the most recent proposal's window closes. null if unknown.
 *
 * The contract refuses a new proposal until `latest_timestamp >= last_end`.
 * Reading it lets the UI say so before the founder signs, instead of after.
 */
export async function getLastEnd(
  algod: algosdk.Algodv2, era: GovernanceEra = MVOTE,
): Promise<number | null> {
  if (!era.appId) return null;
  try {
    const app = await algod.getApplicationByID(era.appId).do();
    return globalUint(app, "last_end") ?? null;
  } catch {
    return null;   // unknown: let the contract be the judge rather than block
  }
}

/** Proposals ever created in an era (ids run 1..count). 0 if not deployed. */
export async function getProposalCount(
  algod: algosdk.Algodv2, era: GovernanceEra,
): Promise<number> {
  if (!era.appId) return 0;
  const app = await algod.getApplicationByID(era.appId).do();
  const count = globalUint(app, "proposal_count");
  // A deployed app always has this key — it is written at creation. Absent
  // means we are pointed at something that is not this contract, and
  // defaulting to 0 would make `createProposal` reuse id 1 and reference the
  // wrong box. Refuse rather than guess.
  if (count === undefined) {
    throw new Error(`App ${era.appId} has no proposal_count — is ${era.name} `
      + "pointed at the right application?");
  }
  return count;
}

/** The proposal, or null if that box does not exist. THROWS if the read failed. */
export async function getProposal(
  algod: algosdk.Algodv2, era: GovernanceEra, id: number,
): Promise<Proposal | null> {
  if (!era.appId) return null;
  try {
    const box = await algod.getApplicationBoxByName(era.appId, propBoxName(id)).do();
    return decodeProposal(era, id, box.value);
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
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
 * Every proposal from every era, newest first, plus which eras could not be read.
 *
 * Eras are read in parallel and one failing does not blank the others: a dead
 * read on the retired app must not take a live vote off the page. But a failed
 * era is REPORTED rather than silently flattened to nothing — the caller needs
 * to tell "there are no proposals" from "we could not find out", because those
 * render as very different sentences.
 *
 * Sorted by end time across eras rather than concatenated, so the list reads as
 * one history even though it spans two contracts.
 */
export async function listProposals(
  algod: algosdk.Algodv2,
): Promise<{ proposals: Proposal[]; failed: GovernanceEra[] }> {
  const failed: GovernanceEra[] = [];
  const perEra = await Promise.all(
    GOVERNANCE_ERAS.map((era) =>
      listEraProposals(algod, era).catch(() => { failed.push(era); return [] as Proposal[]; })),
  );
  return {
    proposals: perEra.flat().sort((a, b) => b.endTime - a.endTime),
    failed,
  };
}

/**
 * This voter's record, or null if they never voted (or already claimed).
 * THROWS if the read failed — see `isNotFound`.
 *
 * The distinction is load-bearing on the claim path. Swallowing the error
 * returned null, the card read that as "no vote to reclaim", and someone with
 * locked mUSD was shown no way to get it back.
 */
export async function getVoteRecord(
  algod: algosdk.Algodv2, era: GovernanceEra, proposalId: number, voter: string,
): Promise<VoteRecord | null> {
  if (!era.appId) return null;
  try {
    const box = await algod.getApplicationBoxByName(
      era.appId, voteBoxName(proposalId, voter)).do();
    return decodeVote(era, proposalId, box.value);
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/**
 * Balance (base units) of an era's voting asset. 0 when not opted in, and
 * **null when the read failed** — which is not the same thing and must not be
 * displayed as the same thing.
 *
 * Returning 0 on error told a wallet holding 5,000 mUSD that it needed at
 * least 1 mUSD to vote.
 */
export async function getVotingBalance(
  algod: algosdk.Algodv2, address: string, era: GovernanceEra = MVOTE,
): Promise<number | null> {
  try {
    const acct = await algod.accountInformation(address).do();
    const holding = (acct.assets ?? []).find((a) => Number(a.assetId) === era.asaId);
    return holding ? Number(holding.amount) : 0;
  } catch {
    return null;
  }
}

/**
 * Treasury wallet USDC balance (base units). 0 if not opted in / unreachable.
 *
 * Left returning 0 on failure, unlike the reads above, and the difference is
 * deliberate: this feeds one decorative metric box that already renders a dash
 * for null from its own loading state. Nothing is decided from it.
 */
export async function getTreasuryUsdc(algod: algosdk.Algodv2): Promise<number> {
  try {
    const acct = await algod.accountInformation(TREASURY_ADDRESS).do();
    const holding = (acct.assets ?? []).find((a) => Number(a.assetId) === USDC_ASA_ID);
    return holding ? Number(holding.amount) : 0;
  } catch {
    return 0;
  }
}
