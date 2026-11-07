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
import { accruedReward, readSnapshot } from "@/lib/strategy/dualstake/reads";
import { approvalMatchesPin } from "@/lib/strategy/dualstake/client";
import { DUALSTAKE_APP_ID, MAGNET_ALGO_ASA_ID } from "@/lib/strategy/dualstake/config";

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
    const snap = await readSnapshot(SERVER);
    const algoMicro = BigInt(5_000_000);   // 5 ALGO
    const composer = await client(HOLDER).makeMintTransactions({
      algoAmount: Number(algoMicro),
    });
    const built = await (await composer.composer()).build();
    const txns = built.transactions.map((t) => t.txn);
    expect(txns.length).toBeGreaterThan(0);

    const res = assertDualStakeGroup(txns, {
      sender: HOLDER, kind: "mint",
      expectedAlgoMicro: algoMicro,
      maxRewardBase: accruedReward(algoMicro, snap!.rate) * BigInt(2) + BigInt(1000),
    });
    if (!res.ok) console.error("assertion failures:", res.failures);
    expect(res.failures).toEqual([]);
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
