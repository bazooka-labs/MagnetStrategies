/**
 * The exact transactions the wallet is asked to sign.
 *
 * An audit pointed out that NO test built the `cast_vote` group, so reverting
 * it to the pre-reorder order — [AppCall, AssetTransfer, Payment] — passed the
 * entire suite while making every vote on mainnet fail. The only tests
 * touching `castVote` were guards that throw before a group is ever built.
 *
 * So this builds the real group through the real client and asserts the shape
 * against the contract's asserts, one for one. `contracts/mvote/mvote/mvote.py`
 * is the thing being mirrored; if that file changes, this is what should go
 * red first.
 */

import algosdk from "algosdk";
import { describe, expect, it } from "vitest";
import { MVOTE, VOTE_BOX_MBR } from "./governance";
import { castVote, claimTokens } from "./governanceClient";

const ERA = { ...MVOTE, appId: 7777, accepting: true };
const APP_ADDR = algosdk.getApplicationAddress(ERA.appId).toString();
const VOTER = algosdk.generateAccount().addr.toString();

const SUGGESTED = {
  minFee: BigInt(1000),
  fee: BigInt(1000),
  firstValid: BigInt(1),
  lastValid: BigInt(1001),
  genesisID: "mainnet-v1.0",
  genesisHash: new Uint8Array(32).fill(7),
};

/**
 * Runs a client call and returns the decoded group it tried to sign.
 *
 * The signer throws, deliberately: it captures the transactions and then stops
 * the call before anything is submitted, so nothing downstream of signing has
 * to be stubbed and no test can accidentally depend on a fake confirmation.
 */
async function capture(
  run: (algod: algosdk.Algodv2, sign: (t: Uint8Array[]) => Promise<(Uint8Array | null)[]>) => Promise<unknown>,
): Promise<algosdk.Transaction[]> {
  const algod = {
    getTransactionParams: () => ({ do: async () => ({ ...SUGGESTED }) }),
  } as unknown as algosdk.Algodv2;

  let captured: algosdk.Transaction[] = [];
  const sign = async (txns: Uint8Array[]) => {
    captured = txns.map((t) => algosdk.decodeUnsignedTransaction(t));
    throw new Error("CAPTURED");
  };
  await expect(run(algod, sign)).rejects.toThrow("CAPTURED");
  return captured;
}

describe("the cast_vote group matches what the contract asserts", () => {
  const build = () => capture((algod, sign) =>
    castVote(algod, sign, VOTER, 3, 1, 25 * 10 ** 6, ERA));

  it("is exactly three transactions, in the contract's order", async () => {
    const g = await build();
    // The contract asserts group_size == 3 and group_index == 2 on the app
    // call. Any other arrangement is rejected on chain.
    expect(g).toHaveLength(3);
    expect(g[0].type).toBe("pay");
    expect(g[1].type).toBe("axfer");
    expect(g[2].type).toBe("appl");
  });

  it("puts the box-MBR payment FIRST, which is what removes the funding buffer", async () => {
    // Algorand checks min balance at the end of each transaction, so this
    // payment has to land before the app call creates the box. Moving it back
    // to last reintroduces the bug UVote could never fix.
    const [pay] = await build();
    expect(pay.payment?.receiver.toString()).toBe(APP_ADDR);
    expect(pay.payment?.amount).toBe(BigInt(VOTE_BOX_MBR));
    expect(pay.payment?.closeRemainderTo).toBeFalsy();
    expect(pay.rekeyTo).toBeFalsy();
    expect(pay.sender.toString()).toBe(VOTER);
  });

  it("locks whole mUSD from the voter's own wallet", async () => {
    const [, axfer] = await build();
    expect(axfer.assetTransfer?.assetIndex).toBe(BigInt(ERA.asaId));
    expect(axfer.assetTransfer?.receiver.toString()).toBe(APP_ADDR);
    expect(axfer.assetTransfer?.amount).toBe(BigInt(25 * 10 ** 6));
    // The contract pins all three: a clawback move, a close-out, and a rekey.
    expect(axfer.assetTransfer?.assetSender).toBeFalsy();
    expect(axfer.assetTransfer?.closeRemainderTo).toBeFalsy();
    expect(axfer.rekeyTo).toBeFalsy();
    expect(axfer.sender.toString()).toBe(VOTER);
  });

  it("calls cast_vote with 8-byte args and both box references", async () => {
    const [, , call] = await build();
    const args = call.applicationCall?.appArgs ?? [];
    expect(new TextDecoder().decode(args[0])).toBe("cast_vote");
    expect(args[1]).toHaveLength(8);
    expect(args[2]).toHaveLength(8);
    expect(algosdk.decodeUint64(args[1], "safe")).toBe(3);
    expect(algosdk.decodeUint64(args[2], "safe")).toBe(1);
    // The contract reads both boxes; omitting either is a reference error.
    expect(call.applicationCall?.boxes).toHaveLength(2);
    expect(call.applicationCall?.foreignAssets?.map(Number)).toContain(ERA.asaId);
    expect(call.rekeyTo).toBeFalsy();
  });

  it("groups all three together under one id", async () => {
    const g = await build();
    const ids = g.map((t) => t.group && Buffer.from(t.group).toString("base64"));
    expect(ids[0]).toBeTruthy();
    expect(new Set(ids).size).toBe(1);
  });
});

describe("the claim_tokens call matches what the contract asserts", () => {
  const build = () => capture((algod, sign) =>
    claimTokens(algod, sign, VOTER, 3, ERA));

  it("is sent ALONE — the contract asserts group_size == 1", async () => {
    expect(await build()).toHaveLength(1);
  });

  it("carries a flat 3000 fee for its two inner transactions", async () => {
    // Inner txns are fee 0 and pool from the outer one. group_size == 1 means
    // no other transaction can sponsor it, so this number is load-bearing: at
    // 1000 or 2000 the claim is rejected.
    const [call] = await build();
    expect(call.fee).toBe(BigInt(3000));
  });

  it("references both boxes and the asset it must send back", async () => {
    const [call] = await build();
    expect(new TextDecoder().decode(call.applicationCall?.appArgs?.[0] ?? new Uint8Array()))
      .toBe("claim_tokens");
    expect(call.applicationCall?.boxes).toHaveLength(2);
    expect(call.applicationCall?.foreignAssets?.map(Number)).toContain(ERA.asaId);
    expect(call.rekeyTo).toBeFalsy();
  });
});
