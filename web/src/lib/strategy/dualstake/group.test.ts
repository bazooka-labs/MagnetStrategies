/**
 * The assertion that stands between Myth's SDK and a wallet prompt.
 *
 * Each test builds a group that is wrong in exactly one way and requires the
 * named failure. Together they are the argument that a compromised or simply
 * updated dependency cannot produce a signature that moves funds somewhere we
 * did not pin.
 */

import algosdk from "algosdk";
import { describe, expect, it } from "vitest";
import { assertDualStakeGroup } from "./group";
import {
  DUALSTAKE_APP_ADDRESS, DUALSTAKE_APP_ID, MAGNET_ALGO_ASA_ID,
  MAX_MINT_GROUP_FEE_MICRO_ALGO, MAX_REDEEM_GROUP_FEE_MICRO_ALGO,
  MINT_SELECTOR, REDEEM_SELECTOR, REWARD_ASA_ID, TINYMAN_APP_ID,
} from "./config";

const USER = algosdk.generateAccount().addr.toString();
const ATTACKER = algosdk.generateAccount().addr.toString();
/**
 * `flatFee` matters here.
 *
 * Without it algosdk reads `fee` as a per-BYTE rate and multiplies by the
 * encoded size, so a fixture meant to carry the 1,000 µALGO minimum charged
 * tens of thousands and tripped `fee_cap` on a group that was otherwise
 * perfectly correct. The real groups use flat minimum fees — the measured
 * mint came to 4,000 µALGO across four transactions.
 */
const SP = {
  minFee: BigInt(1000), fee: BigInt(1000), flatFee: true, firstValid: BigInt(1),
  lastValid: BigInt(1001), genesisID: "mainnet-v1.0",
  genesisHash: new Uint8Array(32).fill(7),
};

const pay = (to: string, amount: number, extra = {}) =>
  algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: USER, receiver: to, amount, suggestedParams: { ...SP }, ...extra });
const axfer = (to: string, assetIndex: number, amount: number, extra = {}) =>
  algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: USER, receiver: to, assetIndex, amount, suggestedParams: { ...SP }, ...extra });
const sel = (hex: string) =>
  Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
/**
 * An app call carrying an ARC-4 selector, because the assertion now checks it.
 *
 * The fixtures used to call `DUALSTAKE_APP_ID` with no arguments at all and
 * pass, which is exactly the hole the selector guard closes: a group can have
 * every destination and amount right and still not perform the action.
 */
const call = (appIndex: number, selector = MINT_SELECTOR, extra = {}) =>
  algosdk.makeApplicationNoOpTxnFromObject({
    sender: USER, appIndex, appArgs: [sel(selector)],
    suggestedParams: { ...SP }, ...extra });

/** A well-formed mint of 60 ALGO with a 1,249 base-$U leg. */
const goodMint = () => [
  axfer(USER, MAGNET_ALGO_ASA_ID, 0),            // opt-in
  call(DUALSTAKE_APP_ID),
  pay(DUALSTAKE_APP_ADDRESS, 60_000_000),
  axfer(DUALSTAKE_APP_ADDRESS, REWARD_ASA_ID, 1_249),
];
const mintOpts = {
  sender: USER, kind: "mint" as const,
  expectedAlgoMicro: BigInt(60_000_000), maxRewardBase: BigInt(2_000),
};

const codes = (g: algosdk.Transaction[], o: Parameters<typeof assertDualStakeGroup>[1]) =>
  assertDualStakeGroup(g, o).failures.map((f) => f.code);

describe("a correct mint passes", () => {
  it("accepts the real shape, opt-in included", () => {
    const r = assertDualStakeGroup(goodMint(), mintOpts);
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checked.length).toBeGreaterThan(5);
  });
});

describe("value cannot be redirected", () => {
  it("refuses ALGO paid anywhere but the dualSTAKE app", () => {
    const g = goodMint();
    g[2] = pay(ATTACKER, 60_000_000);
    expect(codes(g, mintOpts)).toContain("value_leaves");
  });

  it("refuses $U sent anywhere but the dualSTAKE app", () => {
    const g = goodMint();
    g[3] = axfer(ATTACKER, REWARD_ASA_ID, 1_249);
    expect(codes(g, mintOpts)).toContain("value_leaves");
  });

  it("allows the zero-amount self opt-in, which is not an outbound transfer", () => {
    expect(codes(goodMint(), mintOpts)).not.toContain("value_leaves");
  });
});

describe("the amounts must match what the user was shown", () => {
  it("refuses a deposit larger than the screen said", () => {
    const g = goodMint();
    g[2] = pay(DUALSTAKE_APP_ADDRESS, 600_000_000);   // 10x
    expect(codes(g, mintOpts)).toContain("amount");
  });

  it("refuses a $U leg above our independently computed bound", () => {
    // The SDK derives this leg; we do not re-derive it, we bound it. An
    // unbounded second-asset transfer is the one a user cannot see coming.
    const g = goodMint();
    g[3] = axfer(DUALSTAKE_APP_ADDRESS, REWARD_ASA_ID, 50_000);
    expect(codes(g, mintOpts)).toContain("reward_leg");
  });

  it("refuses a mint with no amount to check against", () => {
    expect(codes(goodMint(), { sender: USER, kind: "mint" })).toContain("missing_bound");
  });
});

describe("only pinned apps and assets", () => {
  it("refuses a call to an app this flow never uses", () => {
    const g = [...goodMint(), call(99_999_999, MINT_SELECTOR)];
    expect(codes(g, mintOpts)).toContain("app_unpinned");
  });

  it("allows Tinyman, which the SDK routes through for the $U leg", () => {
    const g = [...goodMint(), call(TINYMAN_APP_ID, MINT_SELECTOR)];
    expect(codes(g, mintOpts)).not.toContain("app_unpinned");
  });

  it("refuses an asset this flow never uses", () => {
    const g = goodMint();
    g[3] = axfer(DUALSTAKE_APP_ADDRESS, 31_566_704, 1_000);   // USDC
    expect(codes(g, mintOpts)).toContain("asset_unpinned");
  });
});

describe("no rekey, no close-out, no foreign sender", () => {
  it("refuses a rekey rider", () => {
    const g = goodMint();
    g[2] = pay(DUALSTAKE_APP_ADDRESS, 60_000_000, { rekeyTo: ATTACKER });
    expect(codes(g, mintOpts)).toContain("rekey");
  });

  it("refuses a close-out of the ALGO balance", () => {
    const g = goodMint();
    g[2] = pay(DUALSTAKE_APP_ADDRESS, 60_000_000, { closeRemainderTo: ATTACKER });
    expect(codes(g, mintOpts)).toContain("close_out");
  });

  it("refuses a transaction the user is not the sender of", () => {
    const g = goodMint();
    g[2] = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: ATTACKER, receiver: DUALSTAKE_APP_ADDRESS, amount: 60_000_000,
      suggestedParams: { ...SP } });
    expect(codes(g, mintOpts)).toContain("sender");
  });
});

describe("fees are bounded", () => {
  it("refuses a mint whose fees exceed the mint cap", () => {
    const g = goodMint();
    g[1] = call(DUALSTAKE_APP_ID, MINT_SELECTOR,
      { suggestedParams: { ...SP, flatFee: true,
        fee: BigInt(MAX_MINT_GROUP_FEE_MICRO_ALGO + 1) } });
    expect(codes(g, mintOpts)).toContain("fee_cap");
  });

  /*
    The two caps are deliberately different, and this is the test that pins
    the reason. Blocking a deposit is a safe failure; blocking an EXIT traps a
    holder, and Myth's upgrade path contemplates extra AMM routes, which means
    more inner transactions and a bigger fee on the redeem app call. A redeem
    fee that a mint would refuse must still get through.
  */
  it("lets a redeem carry a fee the mint cap would refuse", () => {
    const g = [
      axfer(DUALSTAKE_APP_ADDRESS, MAGNET_ALGO_ASA_ID, 10_000_000),
      call(DUALSTAKE_APP_ID, REDEEM_SELECTOR,
        { suggestedParams: { ...SP, flatFee: true,
          fee: BigInt(MAX_MINT_GROUP_FEE_MICRO_ALGO + 1_000) } }),
    ];
    expect(MAX_MINT_GROUP_FEE_MICRO_ALGO + 1_000)
      .toBeLessThan(MAX_REDEEM_GROUP_FEE_MICRO_ALGO);
    expect(codes(g, { sender: USER, kind: "redeem",
      expectedLstBase: BigInt(10_000_000) })).not.toContain("fee_cap");
  });
});

describe("redeem is checked in its own direction", () => {
  const goodRedeem = () => [
    axfer(DUALSTAKE_APP_ADDRESS, MAGNET_ALGO_ASA_ID, 10_000_000),
    call(DUALSTAKE_APP_ID, REDEEM_SELECTOR),
  ];
  const opts = { sender: USER, kind: "redeem" as const, expectedLstBase: BigInt(10_000_000) };

  it("accepts a correct redeem", () => {
    expect(assertDualStakeGroup(goodRedeem(), opts).ok).toBe(true);
  });

  it("refuses a redeem for more than the screen said", () => {
    const g = goodRedeem();
    g[0] = axfer(DUALSTAKE_APP_ADDRESS, MAGNET_ALGO_ASA_ID, 99_000_000);
    expect(codes(g, opts)).toContain("amount");
  });

  it("refuses a redeem that also pays ALGO to the app", () => {
    // A redeem takes magnetALGO and gives ALGO. Paying ALGO in is not a
    // redeem, whatever the SDK called it.
    const g = [...goodRedeem(), pay(DUALSTAKE_APP_ADDRESS, 1_000_000)];
    expect(codes(g, opts)).toContain("unexpected_leg");
  });
});

/*
  ── The holes two independent audits found in the first version ─────────────

  Every test below describes a group the assertion ACCEPTED before these
  guards existed. None of them needs a malicious contract: each only needs the
  SDK to build something other than what it builds today, which is the threat
  model `group.ts` opens by claiming to defend against.
*/

describe("the group must actually perform the action", () => {
  /*
    The sharpest one. The assertion summed destinations and amounts and never
    required an app call, so a lone payment to the app address satisfied every
    check: `expectedAlgoMicro` matched, nothing left to an unpinned address,
    the fee was fine. The chain would have accepted it too — it is a valid
    transaction. The user's ALGO becomes a donation and no magnetALGO is
    minted.
  */
  it("refuses a mint that is only a payment, with no mint call", () => {
    const g = [pay(DUALSTAKE_APP_ADDRESS, 60_000_000)];
    expect(codes(g, { ...mintOpts, maxRewardBase: BigInt(2_000) })).toContain("app_call");
  });

  it("refuses a redeem that is only an asset transfer, with no redeem call", () => {
    const g = [axfer(DUALSTAKE_APP_ADDRESS, MAGNET_ALGO_ASA_ID, 10_000_000)];
    expect(codes(g, { sender: USER, kind: "redeem", expectedLstBase: BigInt(10_000_000) }))
      .toContain("app_call");
  });

  it("refuses two dualSTAKE calls in one group", () => {
    const g = [...goodMint(), call(DUALSTAKE_APP_ID, MINT_SELECTOR)];
    expect(codes(g, mintOpts)).toContain("app_call");
  });

  it("refuses a mint whose call carries the redeem selector", () => {
    const g = goodMint();
    g[1] = call(DUALSTAKE_APP_ID, REDEEM_SELECTOR);
    expect(codes(g, mintOpts)).toContain("selector");
  });

  it("refuses a redeem whose call carries the mint selector", () => {
    const g = [
      axfer(DUALSTAKE_APP_ADDRESS, MAGNET_ALGO_ASA_ID, 10_000_000),
      call(DUALSTAKE_APP_ID, MINT_SELECTOR),
    ];
    expect(codes(g, { sender: USER, kind: "redeem", expectedLstBase: BigInt(10_000_000) }))
      .toContain("selector");
  });

  it("refuses a dualSTAKE call with no selector at all", () => {
    const g = goodMint();
    g[1] = algosdk.makeApplicationNoOpTxnFromObject({
      sender: USER, appIndex: DUALSTAKE_APP_ID, suggestedParams: { ...SP } });
    expect(codes(g, mintOpts)).toContain("selector");
  });
});

describe("a redeem never sends $U", () => {
  /*
    `rewardToApp` was computed for both paths and bounded only on the mint, so
    a redeem could carry an asset transfer of the user's whole $U balance to
    the app. It passed `value_leaves` because the app address IS the pinned
    destination — the check that normally stops a redirection was what let this
    through. A redemption pays $U out; the only correct inbound amount is zero.
  */
  it("refuses a redeem that also transfers $U to the app", () => {
    const g = [
      axfer(DUALSTAKE_APP_ADDRESS, MAGNET_ALGO_ASA_ID, 10_000_000),
      call(DUALSTAKE_APP_ID, REDEEM_SELECTOR),
      axfer(DUALSTAKE_APP_ADDRESS, REWARD_ASA_ID, 9_999_999),
    ];
    const got = codes(g, { sender: USER, kind: "redeem", expectedLstBase: BigInt(10_000_000) });
    expect(got).toContain("unexpected_leg");
  });
});

describe("transaction types are whitelisted", () => {
  /*
    Only `payment`, `assetTransfer` and `applicationCall` were ever inspected.
    Every other type fell past all three branches unexamined, so a rider could
    ride along inside a group the user believed was a deposit.

    `nonParticipation` is the worst of them because it is IRREVERSIBLE: it
    permanently marks the account as not participating in consensus, which
    costs a user who stakes their own ALGO.
  */
  it("refuses a non-participation keyreg rider", () => {
    const g = [...goodMint(),
      algosdk.makeKeyRegistrationTxnWithSuggestedParamsFromObject({
        sender: USER, nonParticipation: true, suggestedParams: { ...SP } })];
    expect(codes(g, mintOpts)).toContain("txn_type");
  });

  it("refuses an asset-config rider", () => {
    const g = [...goodMint(),
      algosdk.makeAssetConfigTxnWithSuggestedParamsFromObject({
        sender: USER, assetIndex: MAGNET_ALGO_ASA_ID, manager: ATTACKER,
        strictEmptyAddressChecking: false, suggestedParams: { ...SP } })];
    expect(codes(g, mintOpts)).toContain("txn_type");
  });
});

describe("app calls may only be NoOp", () => {
  /*
    An unchecked `onComplete` let a CloseOut or ClearState ride inside the
    group. Against Tinyman — which the allowlist permits, because the SDK
    references it — a CloseOut destroys the user's local state there. Against
    dualSTAKE, a ClearState abandons their position in the contract.
  */
  it("refuses a Tinyman close-out rider", () => {
    const g = [...goodMint(),
      algosdk.makeApplicationCloseOutTxnFromObject({
        sender: USER, appIndex: TINYMAN_APP_ID, suggestedParams: { ...SP } })];
    expect(codes(g, mintOpts)).toContain("on_complete");
  });

  it("refuses a dualSTAKE clear-state rider", () => {
    const g = [...goodMint(),
      algosdk.makeApplicationClearStateTxnFromObject({
        sender: USER, appIndex: DUALSTAKE_APP_ID, suggestedParams: { ...SP } })];
    expect(codes(g, mintOpts)).toContain("on_complete");
  });
});
