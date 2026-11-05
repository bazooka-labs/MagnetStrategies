/**
 * The two governance contracts, and the one mistake this design exists to stop.
 *
 * UVote ($U, 5 decimals) and mVote (mUSD, 6 decimals) write the SAME bytes at
 * the SAME box offsets and mean different things by them. A tally of
 * `3500000` is 35 $U or 3.5 mUSD depending entirely on which app it came from.
 * The retired app's one proposal is shown on a page about mUSD, so the wrong
 * answer there is not hypothetical — it is a confident wrong number on screen,
 * which is this repo's most-repeated class of defect.
 *
 * The defence is that every proposal carries its own era and every formatter
 * takes one. These tests exercise that rather than reading the source for it.
 */

import algosdk from "algosdk";
import { describe, expect, it, vi } from "vitest";
import {
  MVOTE, UVOTE_RETIRED, decodeProposal, formatWeight, formatWeightWithUnit,
  propBoxName, voteBoxName, totalVotes, leadingChoice,
} from "./governance";
import { castVote } from "./governanceClient";

// Real, checksum-valid addresses. A 58-character placeholder is rejected by
// `decodeAddress` before any logic under test runs, which turns these into
// tests of algosdk's validator.
const ADDR_A = algosdk.generateAccount().addr.toString();
const ADDR_B = algosdk.generateAccount().addr.toString();

/** A proposal box as the contract writes it: 696 bytes, fixed offsets. */
function proposalBox({ votes = [0, 0, 0, 0], numChoices = 2, start = 1000, end = 2000,
                       question = "Q", choices = ["A", "B", "", ""] } = {}) {
  const buf = new Uint8Array(696);
  const dv = new DataView(buf.buffer);
  dv.setBigUint64(0, BigInt(start));
  dv.setBigUint64(8, BigInt(end));
  votes.forEach((v, i) => dv.setBigUint64(16 + 8 * i, BigInt(v)));
  dv.setBigUint64(48, BigInt(numChoices));
  const enc = new TextEncoder();
  buf.set(enc.encode(question), 56);
  [312, 408, 504, 600].forEach((off, i) => buf.set(enc.encode(choices[i] ?? ""), off));
  return buf;
}

describe("a weight is meaningless without its era", () => {
  it("reads the same bytes as different numbers in each era", () => {
    // 3,500,000 base units. The whole point, in one assertion.
    expect(formatWeightWithUnit(UVOTE_RETIRED, 3_500_000)).toBe("35 $U");
    expect(formatWeightWithUnit(MVOTE, 3_500_000)).toBe("4 mUSD");
    expect(formatWeight(MVOTE, 3_500_000)).not.toBe(formatWeight(UVOTE_RETIRED, 3_500_000));
  });

  it("carries the era onto every decoded proposal", () => {
    const legacy = decodeProposal(UVOTE_RETIRED, 1, proposalBox({ votes: [3_500_000, 0, 0, 0] }));
    const live = decodeProposal(MVOTE, 1, proposalBox({ votes: [3_500_000, 0, 0, 0] }));
    expect(legacy.era.unit).toBe("$U");
    expect(live.era.unit).toBe("mUSD");
    // Same stored bytes, so anything rendering these without the era is wrong.
    expect(legacy.votes[0]).toBe(live.votes[0]);
    expect(formatWeightWithUnit(legacy.era, legacy.votes[0]))
      .not.toBe(formatWeightWithUnit(live.era, live.votes[0]));
  });

  it("decodes only the choices actually in use", () => {
    const p = decodeProposal(MVOTE, 7, proposalBox({
      numChoices: 3, votes: [1_000_000, 2_000_000, 500_000, 0],
      choices: ["ALGO", "mUSD", "AKITA", ""],
    }));
    expect(p.choices).toEqual(["ALGO", "mUSD", "AKITA"]);
    expect(p.votes).toEqual([1_000_000, 2_000_000, 500_000]);
    expect(totalVotes(p)).toBe(3_500_000);
    expect(leadingChoice(p)).toBe(1);
  });
});

describe("the retired contract is readable, never writable", () => {
  it("is marked retired, and still deployed so history survives", () => {
    expect(UVOTE_RETIRED.retired).toBe(true);
    expect(UVOTE_RETIRED.accepting).toBe(false);
    expect(UVOTE_RETIRED.appId).toBeGreaterThan(0);   // still readable
  });

  it("tells an undeployed era apart from a retired one", () => {
    // Both refuse, and they are not the same sentence to show a voter.
    const algod = new Proxy({}, { get() { throw new Error("reached network"); } }) as never;
    const undeployed = { ...MVOTE, appId: 0, accepting: false };
    return Promise.all([
      expect(castVote(algod, vi.fn(), ADDR_A, 1, 0, 1_000_000, undeployed))
        .rejects.toThrow(/not deployed yet/i),
      expect(castVote(algod, vi.fn(), ADDR_A, 1, 0, 1_000_000, UVOTE_RETIRED))
        .rejects.toThrow(/retired/i),
    ]);
  });

  it("refuses a vote without touching the network", async () => {
    // The guard has to fire before anything is built or signed, so the double
    // here throws on ANY use. A guard that runs after `getTransactionParams`
    // would still reject, but only after prompting a wallet.
    const algod = new Proxy({}, {
      get() { throw new Error("governanceClient reached the network on a retired era"); },
    }) as never;
    const sign = vi.fn();
    await expect(castVote(algod, sign, ADDR_A, 1, 0, 1_000_000, UVOTE_RETIRED))
      .rejects.toThrow(/retired/i);
    expect(sign).not.toHaveBeenCalled();
  });

  it("refuses a fractional lock before signing", async () => {
    const algod = new Proxy({}, {
      get() { throw new Error("built a group for an amount the contract will reject"); },
    }) as never;
    const sign = vi.fn();
    // 1.5 mUSD against a DEPLOYED era. The contract asserts
    // `amount % 10^6 == 0` and would reject the group on chain; failing here
    // costs the voter nothing.
    //
    // mVote's real appId is 0 until the deploy handshake runs, and an
    // undeployed era refuses first — which is correct, and would have made
    // this test pass on the wrong message. Hence the local override.
    const deployed = { ...MVOTE, appId: 123, accepting: true };
    await expect(castVote(algod, sign, ADDR_A, 1, 0, 1_500_000, deployed))
      .rejects.toThrow(/whole number of mUSD/i);
    expect(sign).not.toHaveBeenCalled();
  });
});

describe("box names match the contract's key layout", () => {
  // The vote-box MBR the contract demands (26,900 µALGO) is derived from these
  // exact lengths: 2500 + 400*(45 + 16). A longer prefix silently changes what
  // the voter must pay and what they get refunded.
  it("builds a 13-byte proposal key and a 45-byte vote key", () => {
    expect(propBoxName(1)).toHaveLength(13);
    expect(voteBoxName(1, ADDR_A)).toHaveLength(45);
  });

  it("prefixes them exactly as the TEAL does", () => {
    const dec = new TextDecoder();
    expect(dec.decode(propBoxName(1).slice(0, 5))).toBe("prop_");
    expect(dec.decode(voteBoxName(1, ADDR_A).slice(0, 5))).toBe("vote_");
  });

  it("keys a vote box by proposal AND voter", () => {
    expect(voteBoxName(1, ADDR_A)).not.toEqual(voteBoxName(2, ADDR_A));
    expect(voteBoxName(1, ADDR_A)).not.toEqual(voteBoxName(1, ADDR_B));
  });
});
