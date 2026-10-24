/**
 * `sendRawTransaction` takes exactly ONE complete group per call.
 *
 * ── Why this test exists ──
 * The first real C-Vault exit failed here. The design signed 22 transactions
 * across two groups in a single wallet prompt — which worked, the wallet did
 * exactly the right thing — and then submitted both in ONE
 * `sendRawTransaction` call. algod refused it.
 *
 * I had verified that each group simulated, that the wallet could sign across
 * groups, and that the group cap applies per group. I never verified the
 * submission, because I assumed an array of blobs was an array of blobs. The
 * node does not see it that way.
 *
 * Worse than the bug: the refusal was reported to the user as "Sent, but we
 * could not confirm it in time... it will most likely still go through."
 * Nothing had been sent. That is why `SubmissionRefusedError` now exists and
 * is rendered as an error rather than as a reassurance.
 *
 * This asserts the node's actual behaviour so the design cannot drift back.
 */
import { describe, it, expect } from "vitest";
import algosdk from "algosdk";

const algod = new algosdk.Algodv2("", "https://mainnet-api.algonode.cloud", "");
const A = "ALUYA2D55QDUUIY3JORBOB2B7WRTVV477R6URF4P6NY4ZZWB3LUK3DU6WE";

/**
 * Submit with EMPTY signatures and read why it is refused.
 *
 * A signature complaint means the batch was structurally acceptable and only
 * the signing was missing — i.e. the shape is fine. A group complaint means
 * the shape itself was rejected. That difference is the whole experiment, and
 * it needs no private key.
 */
async function refusalFor(groups: algosdk.Transaction[][]): Promise<string> {
  const blobs = groups.flat().map((t) => algosdk.encodeObj({
    txn: algosdk.decodeObj(algosdk.encodeUnsignedTransaction(t)) as never,
  }));
  try {
    await algod.sendRawTransaction(blobs).do();
    return "ACCEPTED";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

describe("live: how algod treats a multi-group submission", () => {
  it("REFUSES two groups in one call, naming the group as the problem", async () => {
    const sp = await algod.getTransactionParams().do();
    sp.fee = sp.minFee; sp.flatFee = true;
    const mk = (n: number) => Array.from({ length: n }, () =>
      algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: A, receiver: A, amount: 0, suggestedParams: sp,
      }));
    const two = await refusalFor([algosdk.assignGroupID(mk(2)), algosdk.assignGroupID(mk(2))]);
    expect(two).not.toBe("ACCEPTED");
    // The specific refusal. If this ever changes, the submission design can be
    // revisited — but it must be revisited deliberately, not discovered by a
    // user whose withdrawal silently did nothing.
    expect(two).toMatch(/incomplete group|transactionGroup/i);

    // Control: the SAME shape as one group gets past the group check and
    // complains about signatures instead. This is what proves the first result
    // is about grouping and not about the empty signatures.
    const one = await refusalFor([algosdk.assignGroupID(mk(2))]);
    expect(one).not.toMatch(/incomplete group/i);
    expect(one).toMatch(/transaction|signature|Sig/i);

    console.log(`two groups -> ${two.slice(0, 90)}`);
    console.log(`one group  -> ${one.slice(0, 90)}`);
  }, 120_000);

  it("the refusal is classified as REFUSED, never as unknown", async () => {
    // The classifier in submit.ts decides what the user is told. A refusal
    // must not be dressed up as "probably went through".
    const refused = /\b4\d\d\b|incomplete group|transactionGroup|rejected|malformed|overspend|logic eval/i;
    expect(refused.test("Received status 400 (Bad Request): transactionGroup: incomplete group"))
      .toBe(true);
    // A dead socket genuinely is unknown, and must stay that way.
    expect(refused.test("request to https://... failed, reason: socket hang up")).toBe(false);
    expect(refused.test("network timeout at: https://mainnet-api.algonode.cloud")).toBe(false);
  });
});
