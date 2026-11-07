/**
 * dualSTAKE mint and redeem, built by Myth's SDK and checked by us, against
 * MainNet. Nothing is signed.
 *
 * Three things this proves that no hermetic test can:
 *   - the SDK still builds a group the current contract accepts
 *   - our assertion passes that group rather than refusing it, which is the
 *     failure mode an over-tight allowlist produces and which a mocked group
 *     would never reveal
 *   - the pinned program hash still matches the deployed code
 *
 * If Myth ships a timelocked upgrade, the pin test here is what tells us
 * first.
 */
import { describe, expect, it } from "vitest";
import algosdk from "algosdk";
import { DualStake, networkConstants } from "@myth-finance/dualstake-ts-sdk";
import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { assertDualStakeGroup } from "@/lib/strategy/dualstake/group";
import {
  mintRewardCost, readRateIndependently, readSnapshot,
} from "@/lib/strategy/dualstake/reads";
import { approvalMatchesPin } from "@/lib/strategy/dualstake/client";
import {
  DUALSTAKE_APP_ID, MAGNET_ALGO_ASA_ID, MINT_SELECTOR, REDEEM_SELECTOR,
} from "@/lib/strategy/dualstake/config";

const SERVER = "https://mainnet-api.algonode.cloud";
const algod = new algosdk.Algodv2("", SERVER, "");

/** A real holder of magnetALGO, so the redeem path is built against a real balance. */
const HOLDER = "KNML6OW2XVXYSSGQX7EBLBMSLAPY6QFNBZUJMNEFIEXIIVJLMW4VINYU6A";

function client(sender: string) {
  const algorand = AlgorandClient.fromConfig({
    algodConfig: { server: SERVER, port: "", token: "" },
  });
  return DualStake.getContractAppClient({
    algorand, sender,
    signer: algosdk.makeEmptyTransactionSigner(),
    network: "PROD",
    appId: BigInt(DUALSTAKE_APP_ID),
    dsRegistryAppId: BigInt(0),
    tinymanAppId: networkConstants.PROD.tm2AppId,
    arc59RouterAppId: networkConstants.PROD.arc59AppId,
  });
}

describe("dualSTAKE against MainNet", () => {
  it("the deployed program still matches the pin we reviewed", async () => {
    // Fails the day Myth lands an upgrade. That is the point: it is the
    // signal to read the new code, not a bug.
    expect(await approvalMatchesPin(algod)).toBe(true);
  }, 30_000);

  it("reads the contract without a funded account or a signer", async () => {
    const snap = await readSnapshot(SERVER);
    expect(snap).not.toBeNull();
    expect(snap!.rate).toBeGreaterThan(BigInt(0));
    expect(snap!.stakedMicroAlgo).toBeGreaterThan(BigInt(0));
    expect(snap!.headroomMicroAlgo).toBeGreaterThan(BigInt(0));
    // The yield only exists while the contract is actually earning.
    expect(snap!.earning).toBe(true);
  }, 30_000);

  it("builds a mint the SDK produces and our assertion accepts", async () => {
    const algoMicro = BigInt(5_000_000);   // 5 ALGO
    const composer = await client(HOLDER).makeMintTransactions({
      algoAmount: Number(algoMicro),
    });
    const built = await (await composer.composer()).build();
    const txns = built.transactions.map((t) => t.txn);
    expect(txns.length).toBeGreaterThan(0);

    /*
      The bound is the TIGHT one the client actually uses — `est + 1% + 2`
      off an independently read rate, not the old `2 * est + 1000` off the
      SDK's own. A loose bound here would make this test pass while the
      shipped code refused, which is the opposite of what it is for.
    */
    const rate = await readRateIndependently(algod);
    expect(rate).not.toBeNull();
    const est = mintRewardCost(algoMicro, rate!);
    const res = assertDualStakeGroup(txns, {
      sender: HOLDER, kind: "mint",
      expectedAlgoMicro: algoMicro,
      maxRewardBase: est + est / BigInt(100) + BigInt(2),
    });
    if (!res.ok) console.error("assertion failures:", res.failures);
    expect(res.failures).toEqual([]);
  }, 60_000);

  /*
    The rate we bound with must track the rate the SDK charges with.

    These are two separate derivations on purpose — ours from raw global state
    and the app's asset holding, the SDK's through its own fallback — so this
    is the test that tells us if they ever diverge enough for the 1% bound to
    start refusing honest mints.
  */
  it("our independent rate matches the \$U leg the SDK actually builds", async () => {
    const algoMicro = BigInt(5_000_000);
    const composer = await client(HOLDER).makeMintTransactions({
      algoAmount: Number(algoMicro),
    });
    const built = await (await composer.composer()).build();
    const legs = built.transactions
      .map((t) => t.txn)
      .filter((t) => t.assetTransfer && Number(t.assetTransfer.assetIndex) !== MAGNET_ALGO_ASA_ID);
    expect(legs).toHaveLength(1);
    const sdkAmount = BigInt(legs[0].assetTransfer!.amount);

    const rate = await readRateIndependently(algod);
    const ours = mintRewardCost(algoMicro, rate!);
    expect(ours).toBe(sdkAmount);
  }, 60_000);

  /*
    The selectors are pinned, so a method rename at Myth must fail HERE —
    loudly, in a test — rather than in front of a user as a refusal nobody
    can explain.
  */
  it("the SDK still calls the selectors we pinned", async () => {
    const mint = await (await (await client(HOLDER)
      .makeMintTransactions({ algoAmount: 5_000_000 })).composer()).build();
    const mintCall = mint.transactions.map((t) => t.txn)
      .find((t) => t.applicationCall
        && Number(t.applicationCall.appIndex) === DUALSTAKE_APP_ID);
    expect(mintCall).toBeDefined();
    const hex = (b: Uint8Array) =>
      Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
    expect(hex(mintCall!.applicationCall!.appArgs![0])).toBe(MINT_SELECTOR);
    expect(Number(mintCall!.applicationCall!.onComplete ?? 0)).toBe(0);
    expect(REDEEM_SELECTOR).toHaveLength(8);
  }, 60_000);

  it("builds a redeem the SDK produces and our assertion accepts", async () => {
    /*
      Finds a live holder rather than naming one.

      The first version used our own admin wallet, which holds no magnetALGO,
      so it skipped — an exit path proven by nothing. Hard-coding somebody
      else's address only moves the problem: they can redeem and the test
      starts skipping again, silently.

      The app's own enormous balance and the Tinyman pool are excluded: they
      are not users, and building a redeem against the pool would exercise a
      shape no person ever signs.
    */
    const APP_ADDR = algosdk.getApplicationAddress(DUALSTAKE_APP_ID).toString();
    const idxRes = await fetch(
      "https://mainnet-idx.algonode.cloud/v2/assets/"
      + `${MAGNET_ALGO_ASA_ID}/balances?currency-greater-than=1000000&limit=20`);
    const { balances } = await idxRes.json() as {
      balances: { address: string; amount: number }[] };
    /*
      Filtered on whether the account can be SIMULATED against, not on how
      much it holds.

      The first filter took the largest non-app holder and got the Tinyman
      U/uALGO pool, which sits at its exact minimum balance — and
      `makeRedeemTransactions` calls `init()` internally, which simulates, so
      the build died on "balance 941000 below min 942000" before any
      assertion ran. Size was the wrong question; spendable headroom is the
      right one, and it also excludes pools and app accounts without naming
      any of them.
    */
    let holder: { address: string; amount: number } | undefined;
    for (const b of balances) {
      if (b.address === APP_ADDR || b.amount <= 1_000_000) continue;
      const info = await algod.accountInformation(b.address).do();
      const spendable = Number(info.amount) - Number(info.minBalance);
      if (spendable > 50_000) { holder = b; break; }
    }
    expect(holder, "no magnetALGO holder with enough ALGO to simulate a redeem")
      .toBeDefined();

    const lstBase = BigInt(holder!.amount) / BigInt(10);   // a tenth of the balance
    const HOLDER = holder!.address;
    const composer = await client(HOLDER).makeRedeemTransactions({
      dsAmount: Number(lstBase),
    });
    const built = await (await composer.composer()).build();
    const txns = built.transactions.map((t) => t.txn);

    const res = assertDualStakeGroup(txns, {
      sender: HOLDER, kind: "redeem", expectedLstBase: lstBase,
    });
    if (!res.ok) console.error("assertion failures:", res.failures);
    expect(res.failures).toEqual([]);
  }, 60_000);
});
