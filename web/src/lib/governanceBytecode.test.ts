/**
 * The bytecode the deploy button actually sends.
 *
 * `governanceAdmin.ts` embeds mVote's compiled program as base64 and documents
 * its hash in a comment beside it. Those are two independent claims about the
 * same bytes, written by hand, and the whole security argument for this app —
 * audited logic, immutable, no sweep path — is an argument about the SOURCE.
 * It transfers to the deployed app only if these bytes are that source.
 *
 * This checks the two claims agree with each other, hermetically. It cannot
 * check they match `contracts/mvote/mvote/mvote.py`, which needs PyTeal —
 * `contracts/mvote/verify_embedded.py` does that, and should be run before any
 * deploy.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import algosdk from "algosdk";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/lib/governanceAdmin.ts", "utf8");

/** Algorand's program hash: base32 address of sha512_256("Program" || bytes). */
function programHash(b64: string): string {
  const prog = Buffer.from(b64, "base64");
  const digest = createHash("sha512-256")
    .update(Buffer.concat([Buffer.from("Program"), prog]))
    .digest();
  return algosdk.encodeAddress(new Uint8Array(digest));
}

function constant(name: string): string {
  const m = new RegExp(`const ${name} =\\s*\\n?\\s*"([A-Za-z0-9+/=]+)"`).exec(src);
  if (!m) throw new Error(`${name} not found — did the constant get renamed?`);
  return m[1];
}

function documentedHash(label: string): string {
  const m = new RegExp(`${label} hash:\\s*([A-Z2-7]{58})`).exec(src);
  if (!m) throw new Error(`no documented ${label} hash in governanceAdmin.ts`);
  return m[1];
}

describe("the embedded mVote program", () => {
  it("hashes to the approval hash documented beside it", () => {
    // If these disagree, one of the two was edited alone — which is exactly how
    // a stale program ships under a current comment.
    expect(programHash(constant("MVOTE_APPROVAL_B64"))).toBe(documentedHash("Approval"));
  });

  it("hashes to the documented clear hash", () => {
    expect(programHash(constant("MVOTE_CLEAR_B64"))).toBe(documentedHash("Clear"));
  });

  it("is not UVote's program", () => {
    // The two differ by 22 TEAL lines. Copying the old constant across while
    // porting would leave an app that locks $U behind a UI that says mUSD, and
    // every test above this one would still pass.
    const UVOTE_APPROVAL_HASH = "VQXFHFXPBUWFAH6QLIA5VZNEETAHQM3HVCRIKIO7HAB2HR5HZNHX64W55E";
    expect(programHash(constant("MVOTE_APPROVAL_B64"))).not.toBe(UVOTE_APPROVAL_HASH);
  });

  it("declares the mUSD asset at creation, where it can never be changed", () => {
    // `musd_asa_id` has no setter. The deploy call is the only chance to get it
    // right, so the handshake must pass MVOTE.asaId and nothing else.
    expect(src).toContain("appArgs: [algosdk.encodeUint64(MVOTE.asaId)]");
  });

  it("creates the app with the schema the contract's global state needs", () => {
    // uints: musd_asa_id, proposal_count, last_end. bytes: founder,
    // pending_founder. An undersized schema bricks the app at its first write.
    expect(src).toContain("numGlobalInts: 3");
    expect(src).toContain("numGlobalByteSlices: 2");
  });
});
