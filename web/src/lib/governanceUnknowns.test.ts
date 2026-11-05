/**
 * "We don't know" must never render as a fact.
 *
 * Every read in `governanceReads.ts` used to catch its own errors and return
 * null or 0, which collapsed two different answers into one. An audit found
 * what that produced:
 *
 *   - a rate-limited node turned a live proposal into "Nothing to vote on"
 *   - a failed box read turned a cast vote into "you have not voted", which
 *     after the window closes HID THE RECLAIM BUTTON from someone with locked
 *     funds
 *   - a failed account read told a wallet holding 5,000 mUSD that it needed at
 *     least 1 mUSD to vote
 *
 * None of those involve a bug in the happy path, which is why they survived
 * the first round of tests. These exercise the failure paths directly.
 */

import algosdk from "algosdk";
import { describe, expect, it } from "vitest";
import { MVOTE, UVOTE_RETIRED } from "./governance";
import { getProposal, getVoteRecord, getVotingBalance, listProposals } from "./governanceReads";

/** Algod double whose box/account reads fail however we tell them to. */
function algodThatFails(err: unknown) {
  return {
    getApplicationBoxByName: () => ({ do: () => Promise.reject(err) }),
    accountInformation: () => ({ do: () => Promise.reject(err) }),
    getApplicationByID: () => ({ do: () => Promise.reject(err) }),
  } as never;
}

const notFound = Object.assign(new Error("box not found"), { status: 404 });
const rateLimited = Object.assign(new Error("Too Many Requests"), { status: 429 });

/**
 * A DEPLOYED era, because the reads short-circuit to null on `appId === 0`.
 *
 * `MVOTE.appId` is 0 until the deploy handshake runs, so using it here made
 * the failure tests pass without the request ever being made — they proved the
 * undeployed guard, not the error handling they named.
 */
const DEPLOYED = { ...MVOTE, appId: 123, accepting: true };

/**
 * A real address, because `voteBoxName` decodes it.
 *
 * A placeholder like "x" throws "address seems to be malformed" before the
 * read under test is even attempted — which still satisfies `.rejects`, so the
 * rate-limit test below passed for entirely the wrong reason until this
 * existed.
 */
const VOTER = algosdk.generateAccount().addr.toString();

describe("a 404 and a failure are different answers", () => {
  it("reads a missing proposal box as null", async () => {
    await expect(getProposal(algodThatFails(notFound), DEPLOYED, 1)).resolves.toBeNull();
  });

  it("THROWS when the proposal read fails, rather than reporting no proposal", async () => {
    await expect(getProposal(algodThatFails(rateLimited), DEPLOYED, 1)).rejects.toThrow();
  });

  it("reads a missing vote box as null — they simply have not voted", async () => {
    await expect(getVoteRecord(algodThatFails(notFound), DEPLOYED, 1, VOTER)).resolves.toBeNull();
  });

  it("THROWS when the vote read fails, so the card can offer a reclaim anyway", async () => {
    // The dangerous one. Swallowed, this said "no vote on record" and the
    // Reclaim button is gated on having a record.
    await expect(getVoteRecord(algodThatFails(rateLimited), DEPLOYED, 1, VOTER)).rejects.toThrow();
  });

  it("treats a 404 in the message as not-found even without a status", async () => {
    // Not every SDK path attaches `status`.
    await expect(getProposal(algodThatFails(new Error("404 not found")), DEPLOYED, 1))
      .resolves.toBeNull();
  });
});

describe("balance: zero and unknown are not the same number", () => {
  it("returns null when the account read fails", async () => {
    await expect(getVotingBalance(algodThatFails(rateLimited), VOTER, MVOTE)).resolves.toBeNull();
  });

  it("returns 0 — not null — for a wallet that is simply not opted in", async () => {
    const algod = { accountInformation: () => ({ do: async () => ({ assets: [] }) }) } as never;
    await expect(getVotingBalance(algod, VOTER, MVOTE)).resolves.toBe(0);
  });

  it("reads the balance of the era's own asset", async () => {
    const algod = {
      accountInformation: () => ({ do: async () => ({ assets: [
        { assetId: MVOTE.asaId, amount: 5_000_000 },
        { assetId: UVOTE_RETIRED.asaId, amount: 77 },
      ] }) }),
    } as never;
    await expect(getVotingBalance(algod, VOTER, MVOTE)).resolves.toBe(5_000_000);
    await expect(getVotingBalance(algod, VOTER, UVOTE_RETIRED)).resolves.toBe(77);
  });
});

describe("a partial list says it is partial", () => {
  it("names the eras it could not read", async () => {
    // Every era fails here, so nothing is returned — and `failed` is what
    // stops the page calling that an empty governance history.
    const { proposals, failed } = await listProposals(algodThatFails(rateLimited));
    expect(proposals).toEqual([]);
    expect(failed.length).toBeGreaterThan(0);
  });

  it("reports no failures when there is genuinely nothing to read", async () => {
    // proposal_count 0 everywhere: a real empty state, not a broken one.
    const algod = {
      getApplicationByID: () => ({ do: async () => ({ params: { globalState: [] } }) }),
    } as never;
    const { proposals, failed } = await listProposals(algod);
    expect(proposals).toEqual([]);
    expect(failed).toEqual([]);
  });
});
