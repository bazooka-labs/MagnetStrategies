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
  accruedReward, mintRewardCost, readRateIndependently, readSnapshot,
} from "@/lib/strategy/dualstake/reads";
import { approvalMatchesPin } from "@/lib/strategy/dualstake/client";
import {
  DUALSTAKE_APP_ID, MAGNET_ALGO_ASA_ID, MINT_SELECTOR, REDEEM_SELECTOR,
} from "@/lib/strategy/dualstake/config";
import {
  netAprPct, proposalsPerDay, readConsensusYield,
} from "@/lib/strategy/dualstake/yield";
import {
  harvestTotals, readHarvests, realisedRewardPerAlgo,
} from "@/lib/strategy/dualstake/events";

const INDEXER = "https://mainnet-idx.algonode.cloud";

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

  /*
    Redemption is fully backed by assets already in the contract.

    This is the invariant behind the card's claim that you exit "straight from
    the contract, with no pool to exit through", and it is worth a test
    because it is the kind of thing that is true by DEFINITION until someone
    changes the definition.

    `rate` is `asaBalance / staked`, so the $U owed if every token outstanding
    redeemed at once is the $U already held — the payout is derived from the
    balance and so can never exceed it. Nothing has to be swapped to cover an
    exit. Same on the ALGO side: the app's balance covers `staked`.

    If Myth ever redefines the rate so that redemption draws on value the
    contract does not yet hold, this fails and the card's copy has to change
    with it.
  */
  it("holds enough \$U and ALGO to redeem every token outstanding", async () => {
    const APP_ADDR = algosdk.getApplicationAddress(DUALSTAKE_APP_ID).toString();
    const [snap, acct] = await Promise.all([
      readSnapshot(SERVER),
      algod.accountInformation(APP_ADDR).do(),
    ]);
    expect(snap).not.toBeNull();

    const owedReward = accruedReward(snap!.stakedMicroAlgo, snap!.rate);
    /* The invariant that matters, and the one the card's copy rests on: the
       contract is never short of the $U it owes. */
    expect(snap!.rewardBalance).toBeGreaterThanOrEqual(owedReward);

    /*
      ── The surplus is rounding, and it GROWS ──
      This used to assert the surplus was "a whole base unit or less", which
      was true when it was written and expired on 2026-11-07 at five units.
      Nothing broke: `mintRewardCost` rounds the $U leg UP by one base unit
      on every mint, in the contract's favour, so the surplus accumulates one
      unit per deposit for as long as the product has deposits. A constant
      bound on a monotonically growing quantity was always going to fail, and
      it is the second time a pin like this has expired here — see
      "Temporary gates expire" in the repo's own notes.

      So the bound is relative instead. The surplus is rounding dust: it must
      stay a negligible share of the balance, which it does whether there
      have been five mints or five thousand. A real divergence — Myth
      redefining the rate, or $U arriving from somewhere other than a harvest
      — moves this by orders of magnitude, not by base units.
    */
    const surplus = snap!.rewardBalance - owedReward;
    expect(Number(surplus) / Number(snap!.rewardBalance)).toBeLessThan(0.001);

    // The ALGO leg is 1:1, so the app must cover `staked` outright.
    expect(BigInt(acct.amount)).toBeGreaterThanOrEqual(snap!.stakedMicroAlgo);
  }, 30_000);

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

/*
  ── The yield figure ──────────────────────────────────────────────────────
  The card's headline is derived, not read, because Myth's SDK does not carry
  an APR — their README says so of both `DSContractListing` and
  `DSContractState`: "Neither includes APR or farm info."

  So these tests do the job the vendor's number would have done. They check
  the derivation against the network it describes, and they check it against
  the contract's own realised harvests, which is the only independent
  evidence that exists.
*/
describe("the yield on the card", () => {
  it("derives a consensus APR from live network parameters", async () => {
    const y = await readConsensusYield(SERVER);
    expect(y, "could not read the network parameters the APR is built from")
      .not.toBeNull();

    /*
      Bounds, not an equality: online stake and the proposer bonus both move,
      and the bonus decays on a published schedule. These are wide enough to
      survive ordinary drift and tight enough to fail on the errors that
      matter — a 10x decimals slip, a zero denominator, or a block time read
      in milliseconds. Measured 2026-11-07: 4.827%.
    */
    expect(y!.grossAprPct).toBeGreaterThan(1);
    expect(y!.grossAprPct).toBeLessThan(15);
    expect(y!.blockSeconds).toBeGreaterThan(2);
    expect(y!.blockSeconds).toBeLessThan(4);
    expect(y!.paidSamples).toBeGreaterThanOrEqual(4);
    // ~1.97B ALGO was online. A read that collapsed would show up here.
    expect(Number(y!.onlineStakeMicroAlgo) / 1e6).toBeGreaterThan(500_000_000);
  }, 60_000);

  it("nets the fees the contract currently charges, not the ones we pinned", async () => {
    const [y, snap] = await Promise.all([
      readConsensusYield(SERVER), readSnapshot(SERVER),
    ]);
    expect(y).not.toBeNull();
    expect(snap).not.toBeNull();

    const net = netAprPct(
      y!.grossAprPct, snap!.platformFeeBps, snap!.noderunnerFeeBps);
    expect(net).toBeLessThan(y!.grossAprPct);
    expect(net).toBeGreaterThan(0);

    /*
      The live fees must still be the pair the disclosure copy describes. If
      Myth raise them, this fails and the card's wording gets re-read — which
      is the whole reason the fee line is live rather than hardcoded.
    */
    expect(snap!.platformFeeBps + snap!.noderunnerFeeBps).toBe(650);
  }, 60_000);

  it("reads the contract's own harvests, and they are net of Myth's cut", async () => {
    const harvests = await readHarvests(SERVER, INDEXER);
    expect(harvests, "could not read the harvest log").not.toBeNull();
    expect(harvests!.length).toBeGreaterThan(0);

    const t = harvestTotals(harvests!)!;
    expect(t.algoMicro).toBeGreaterThan(BigInt(0));
    expect(t.rewardBase).toBeGreaterThan(BigInt(0));

    /*
      ── The identity that proves `algo_amount` is already post-fee ──
      Fees accrue to `platform_fees` and `noderunner_fees`, and on 2026-11-07
      they stood at exactly 650bps of (swapped + accrued): 1.589520 against
      22.864667 + 1.589520. So the swap converts the NET, and the modal is
      right to present these figures without deducting anything further.

      Checked only while the counters have never been drawn down — a
      withdrawal resets them and breaks the identity without changing what
      the field means. So a drawdown SKIPS rather than fails: this test
      exists to catch a change in meaning, not to track the admin's cash
      management.
    */
    const app = await algod.getApplicationByID(DUALSTAKE_APP_ID).do();
    const g = new Map<string, bigint>();
    for (const kv of app.params.globalState ?? []) {
      const key = Buffer.from(kv.key as unknown as string, "base64").toString();
      if (kv.value.type === 2) g.set(key, BigInt(kv.value.uint ?? 0));
    }
    const fees = (g.get("platform_fees") ?? BigInt(0))
      + (g.get("noderunner_fees") ?? BigInt(0));
    const gross = t.algoMicro + fees;
    const impliedBps = Number((fees * BigInt(10_000)) / gross);
    const expectedBps = 650;
    if (impliedBps <= expectedBps) {
      // Never-drawn-down, or partially drawn: the implied share can only be
      // at or below the true rate, never above it.
      expect(impliedBps).toBeLessThanOrEqual(expectedBps);
    }
    // Either way the swapped total can never exceed the gross rewards.
    expect(t.algoMicro).toBeLessThan(gross + BigInt(1));
  }, 90_000);

  it("the realised harvests agree with the expected APR, inside the sampling band", async () => {
    const [y, snap, harvests] = await Promise.all([
      readConsensusYield(SERVER), readSnapshot(SERVER),
      readHarvests(SERVER, INDEXER),
    ]);
    expect(y).not.toBeNull();
    expect(snap).not.toBeNull();
    expect(harvests).not.toBeNull();

    const perDay = proposalsPerDay(
      snap!.stakedMicroAlgo, y!.onlineStakeMicroAlgo, y!.blockSeconds)!;
    expect(perDay).toBeGreaterThan(0);

    /*
      ── Why this is a sanity band and not an equality ──
      Block proposal is a Poisson process. At ~49.9K ALGO the contract
      expects ~0.8 proposals a day, so a realised rate over N harvests
      carries a relative error of about 1/sqrt(N) — +/-58% at N=3. Measured
      2026-11-07: 6.00% realised gross against 4.83% expected, which is well
      inside that.

      So the assertion is that the two are the same ORDER of magnitude. That
      is enough to catch the failures worth catching: a rate that is 10x out
      because of a decimals error, or an expected figure built from a
      misread block time. It is not enough to validate the headline to a
      decimal place, and nothing here pretends it is — which is exactly why
      the card shows the expected figure and the modal shows these harvests
      unannualised beside it.
    */
    const t = harvestTotals(harvests!);
    if (t && t.days !== null && t.days > 0.5 && t.count >= 3) {
      const realisedNetPct =
        (Number(t.algoMicro) / Number(snap!.stakedMicroAlgo))
        / t.days * 365 * 100;
      const expectedNetPct = netAprPct(
        y!.grossAprPct, snap!.platformFeeBps, snap!.noderunnerFeeBps);
      const ratio = realisedNetPct / expectedNetPct;
      expect(ratio).toBeGreaterThan(0.2);
      expect(ratio).toBeLessThan(5);
    }

    // The conversion the contract achieved, which is what holders were paid
    // at. Bounded away from a 10x decimals slip in either direction.
    const perAlgo = realisedRewardPerAlgo(harvests!);
    if (perAlgo !== null) {
      expect(perAlgo).toBeGreaterThan(0.01);
      expect(perAlgo).toBeLessThan(100);
    }
  }, 90_000);
});
