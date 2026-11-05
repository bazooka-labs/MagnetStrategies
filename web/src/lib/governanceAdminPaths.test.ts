/**
 * The deploy and founder-rotation paths, which are the ones that cannot be
 * undone on mainnet.
 *
 * Both of the High findings in the third audit round lived here, and neither
 * had a test:
 *
 *   - the Accept half of a founder transfer was gated on being the founder,
 *     which the nominee is not until they accept — so rotation through the UI
 *     was impossible, and nobody noticed because nothing exercised it.
 *   - a create whose confirmation timed out left a real app on mainnet that
 *     the UI could not name, with an enabled Deploy button one click from a
 *     second one.
 *
 * The fix for the second is to DISCOVER the app rather than remember it, so
 * `findDeployedMVote` is the thing standing between an operator and a
 * duplicate deployment. It gets tested properly.
 */

import { readFileSync } from "node:fs";
import algosdk from "algosdk";
import { describe, expect, it } from "vitest";
import { MVOTE, SubmittedUnconfirmed, isUnconfirmed } from "./governance";
import { findDeployedMVote } from "./governanceAdmin";
import { getPendingFounder, isOptedIn } from "./governanceReads";

/** The exact bytes the deploy button ships, read from the module that ships them. */
const APPROVAL_B64 = (() => {
  const src = readFileSync("src/lib/governanceAdmin.ts", "utf8");
  const m = /const MVOTE_APPROVAL_B64 =\s*\n?\s*"([A-Za-z0-9+/=]+)"/.exec(src);
  if (!m) throw new Error("MVOTE_APPROVAL_B64 not found");
  return m[1];
})();

const ERA_APP = 4242;
const APP_ADDR = algosdk.getApplicationAddress(ERA_APP).toString();
const NOMINEE = algosdk.generateAccount().addr.toString();

function algodWith({ created = [] as unknown[], appAccount = {} as Record<string, unknown> }) {
  return {
    accountInformation: (addr: string) => ({
      do: async () => (addr === APP_ADDR ? appAccount : { createdApps: created }),
    }),
  } as never;
}

describe("finding an already-deployed mVote", () => {
  it("matches on the approval program, not on the app's name or age", async () => {
    // The founder wallet may own unrelated apps. Matching on anything softer
    // than the program bytes would offer "Finish setup" against one of those.
    const algod = algodWith({
      created: [
        { id: 999, params: { approvalProgram: new Uint8Array([1, 2, 3]) } },
        { id: ERA_APP, params: { approvalProgram: Buffer.from(APPROVAL_B64, "base64") } },
      ],
      appAccount: { amount: 400_000, assets: [{ assetId: MVOTE.asaId, amount: 0 }] },
    });
    const found = await findDeployedMVote(algod, "CREATOR");
    expect(found.map((f) => f.appId)).toEqual([ERA_APP]);
  });

  it("reports an app that was created but never set up", async () => {
    // Exactly the state a timed-out create leaves behind: the app exists, and
    // it is neither funded nor opted in, so it cannot take a vote.
    const algod = algodWith({
      created: [{ id: ERA_APP, params: { approvalProgram: Buffer.from(APPROVAL_B64, "base64") } }],
      appAccount: { amount: 0, assets: [] },
    });
    const [found] = await findDeployedMVote(algod, "CREATOR");
    expect(found).toMatchObject({ appId: ERA_APP, optedIn: false, funded: false });
  });

  it("reports a finished one as funded and opted in", async () => {
    const algod = algodWith({
      created: [{ id: ERA_APP, params: { approvalProgram: Buffer.from(APPROVAL_B64, "base64") } }],
      appAccount: { amount: 400_000, assets: [{ assetId: MVOTE.asaId, amount: 0 }] },
    });
    const [found] = await findDeployedMVote(algod, "CREATOR");
    expect(found).toMatchObject({ optedIn: true, funded: true });
  });

  it("finds nothing when the wallet has created nothing", async () => {
    expect(await findDeployedMVote(algodWith({}), "CREATOR")).toEqual([]);
  });
});

describe("the nominated founder", () => {
  const appWith = (globalState: unknown[]) => ({
    getApplicationByID: () => ({ do: async () => ({ params: { globalState } }) }),
  } as never);
  const key = (k: string) => Buffer.from(k).toString("base64");
  const ERA = { ...MVOTE, appId: ERA_APP };

  it("is read from the contract, so the nominee can be shown an Accept button", async () => {
    const algod = appWith([{
      key: key("pending_founder"),
      value: { type: 1, bytes: Buffer.from(algosdk.decodeAddress(NOMINEE).publicKey).toString("base64") },
    }]);
    expect(await getPendingFounder(algod, ERA)).toBe(NOMINEE);
  });

  it("is null when nobody is nominated", async () => {
    // The contract writes an empty byte string, not a zero address, so a
    // length check is what distinguishes "none" from a real nomination.
    const algod = appWith([{ key: key("pending_founder"), value: { type: 1, bytes: "" } }]);
    expect(await getPendingFounder(algod, ERA)).toBeNull();
  });

  it("is null on an undeployed era rather than throwing", async () => {
    expect(await getPendingFounder(appWith([]), { ...MVOTE, appId: 0 })).toBeNull();
  });
});

describe("opt-in, before offering a reclaim that cannot succeed", () => {
  const acct = (assets: unknown[]) =>
    ({ accountInformation: () => ({ do: async () => ({ assets }) }) } as never);

  it("is true for a holder, including a zero balance", async () => {
    // The exact case: locking everything leaves a zero holding, which is still
    // an opt-in, and the claim works.
    expect(await isOptedIn(acct([{ assetId: MVOTE.asaId, amount: 0 }]), "X", MVOTE)).toBe(true);
  });

  it("is false once the holding is removed", async () => {
    expect(await isOptedIn(acct([]), "X", MVOTE)).toBe(false);
  });

  it("is null — not false — when the check itself fails", async () => {
    // Blocking a reclaim on a failed lookup would be worse than attempting it.
    const algod = { accountInformation: () => ({ do: () => Promise.reject(new Error("x")) }) } as never;
    expect(await isOptedIn(algod, "X", MVOTE)).toBeNull();
  });
});

describe("submitted-but-unconfirmed is a type, not a phrase", () => {
  it("carries the txid, which is the only way back to the transaction", () => {
    const e = new SubmittedUnconfirmed("ABC123");
    expect(isUnconfirmed(e)).toBe(true);
    expect(e.txid).toBe("ABC123");
  });

  it("does not match an ordinary failure that merely mentions confirming", () => {
    // The regex this replaced matched any message containing "confirm",
    // "timeout" or "pending" — including failures from BEFORE submission,
    // which it then reported to the user as "submitted".
    expect(isUnconfirmed(new Error("wallet request pending; could not confirm"))).toBe(false);
    expect(isUnconfirmed(new Error("timeout fetching suggested params"))).toBe(false);
  });
});
