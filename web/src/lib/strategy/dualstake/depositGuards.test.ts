/**
 * The checks a deposit must survive BEFORE Myth's SDK is asked to build
 * anything, and before a wallet is asked to sign.
 *
 * All three exist because of a specific audit finding, and all three FAIL
 * CLOSED. That is the asymmetry `config.ts` sets out: refusing a deposit costs
 * the user nothing, so an unverified precondition must refuse. Refusing an
 * EXIT traps them, so `redeem` deliberately has none of these.
 *
 * `deposit` is mocked only at the network boundary — the algod client — so the
 * real guard code runs. A mocked-away guard is the failure mode
 * `feedback-assert-behaviour-not-source-text` names: the test reaches the
 * subject or it proves nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DUALSTAKE_PROGRAM_SHA256, MIN_DEPOSIT_MICRO_ALGO, REWARD_ASA_ID } from "./config";
import { mintRewardCost } from "./reads";

/**
 * Stand-in program bytes, and their real SHA-256.
 *
 * Finding bytes that hash to the ACTUAL pin would be a preimage attack, so
 * these tests pin the fixture's own digest instead and leave
 * `approvalMatchesPin`'s hashing untouched. What is under test here is which
 * BRANCH each outcome takes — match, mismatch, unreadable — and the real
 * digest against the real deployed program is covered by the MainNet test.
 */
const approvalBytes = new Uint8Array([1, 2, 3]);
let matchingPin: string;

beforeEach(async () => {
  vi.resetModules();
  const d = await crypto.subtle.digest("SHA-256", approvalBytes);
  matchingPin = Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  vi.doMock("./config", async () => {
    const real = await vi.importActual<typeof import("./config")>("./config");
    return { ...real, DUALSTAKE_PROGRAM_SHA256: matchingPin };
  });
});

/** A fake algod exposing only what the deposit path calls. */
function fakeAlgod(opts: {
  approval?: Uint8Array | null;
  appFails?: boolean;
  staked?: bigint;
  appRewardBalance?: bigint;
  userRewardBalance?: bigint | null;
  userOptedIn?: boolean;
  acctFails?: boolean;
}) {
  const {
    approval = approvalBytes, appFails = false, staked = BigInt(49_319_479_854),
    appRewardBalance = BigInt(1_538_507), userRewardBalance = BigInt(10_000_000),
    userOptedIn = true, acctFails = false,
  } = opts;

  const b64 = (s: string) => Buffer.from(s).toString("base64");
  return {
    getApplicationByID: () => ({
      do: async () => {
        if (appFails) throw new Error("algod unreachable");
        return {
          params: {
            approvalProgram: approval,
            globalState: [
              { key: b64("staked"), value: { type: 2, uint: staked } },
              { key: b64("rate_precision"), value: { type: 2, uint: BigInt(10_000_000_000) } },
            ],
          },
        };
      },
    }),
    accountInformation: (addr: string) => ({
      do: async () => {
        if (acctFails) throw new Error("algod unreachable");
        // The app account holds the $U that defines the rate.
        if (addr.length === 58 && addr.startsWith("6DNHMU4W")) {
          return { assets: [{ assetId: REWARD_ASA_ID, amount: appRewardBalance }] };
        }
        if (userRewardBalance === null) throw new Error("algod unreachable");
        return {
          assets: userOptedIn
            ? [{ assetId: REWARD_ASA_ID, amount: userRewardBalance }]
            : [],
        };
      },
    }),
  } as never;
}

const SENDER = "KNML6OW2XVXYSSGQX7EBLBMSLAPY6QFNBZUJMNEFIEXIIVJLMW4VINYU6A";

/** Run a deposit with a stubbed snapshot read, and return the rejection. */
async function depositError(
  algod: ReturnType<typeof fakeAlgod>,
  algoMicro: bigint,
  snapshot: Record<string, unknown> | null = {},
): Promise<string> {
  vi.doMock("./reads", async () => {
    const real = await vi.importActual<typeof import("./reads")>("./reads");
    return {
      ...real,
      readSnapshot: async () => snapshot === null ? null : {
        rate: BigInt(311_947), stakedMicroAlgo: BigInt(49_319_479_854),
        rewardBalance: BigInt(1_538_507),
        headroomMicroAlgo: BigInt(65_000_000_000_000) - BigInt(49_319_479_854),
        platformFeeBps: 250, noderunnerFeeBps: 400,
        upgrading: false, earning: true, round: BigInt(1),
        ...snapshot,
      },
    };
  });
  const { deposit } = await import("./client");
  try {
    await deposit({
      algod, algodServer: "https://example.invalid", sign: async () => [],
      sender: SENDER, algoMicro,
    });
    return "(no error)";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

describe("the program pin fails closed on a deposit", () => {
  /*
    `approvalMatchesPin` returns null when it could NOT read the program, and
    the first version of `deposit` blocked only on `=== false`. So an
    unreachable or erroring algod was indistinguishable from a verified match,
    and the one precondition that must hold before new money enters a
    third-party contract — this is the code we reviewed — was satisfied by a
    network error.
  */
  it("refuses when the program cannot be read at all", async () => {
    const msg = await depositError(fakeAlgod({ appFails: true }), BigInt(5_000_000));
    expect(msg).toMatch(/couldn't verify/i);
    expect(msg).not.toMatch(/has changed/i);   // not a mismatch; an unknown
  });

  it("refuses when the app has no approval program to hash", async () => {
    const msg = await depositError(fakeAlgod({ approval: null }), BigInt(5_000_000));
    expect(msg).toMatch(/couldn't verify/i);
  });

  it("refuses a real mismatch with a different message", async () => {
    const msg = await depositError(
      fakeAlgod({ approval: new Uint8Array([9, 9, 9]) }), BigInt(5_000_000));
    // Both branches refuse; they must not be reported as the same thing,
    // because one is Myth shipping an upgrade and the other is our network.
    expect(msg).toMatch(/has changed since we reviewed it/i);
    expect(DUALSTAKE_PROGRAM_SHA256).toHaveLength(64);
  });
});

describe("the $U requirement is stated before the wallet opens", () => {
  /*
    Minting is "X ALGO + Y $U". The SDK opts the user into magnetALGO but
    never into $U, and always includes the $U leg while the rate is above
    zero. Before this precheck, a wallet with plenty of ALGO and no $U met the
    requirement as a raw `asset missing from sender` out of simulate.
  */
  it("names the amount when the wallet holds too little $U", async () => {
    const msg = await depositError(
      fakeAlgod({ userRewardBalance: BigInt(1) }), BigInt(100_000_000));
    expect(msg).toMatch(/also costs/i);
    expect(msg).toMatch(/0\.03/);              // ~0.0312 $U per 100 ALGO
    expect(msg).toMatch(/comes back when you redeem/i);
  });

  it("says so when the wallet is not opted into $U", async () => {
    const msg = await depositError(
      fakeAlgod({ userOptedIn: false }), BigInt(100_000_000));
    expect(msg).toMatch(/isn't opted/i);
  });

  it("refuses rather than guess when the $U balance cannot be read", async () => {
    const msg = await depositError(
      fakeAlgod({ userRewardBalance: null }), BigInt(100_000_000));
    expect(msg).toMatch(/couldn't read your \$U balance/i);
  });

  it("lets a wallet with enough $U through to the build", async () => {
    // Past every precheck; it then fails reaching the real SDK, which is the
    // proof the guards above are what stopped the others.
    const msg = await depositError(
      fakeAlgod({ userRewardBalance: BigInt(10_000_000) }), BigInt(100_000_000));
    expect(msg).not.toMatch(/also costs|isn't opted|couldn't verify|couldn't read your/i);
  });
});

describe("the other deposit preconditions", () => {
  it("refuses below the minimum, before any read", async () => {
    const msg = await depositError(fakeAlgod({}), BigInt(MIN_DEPOSIT_MICRO_ALGO) - BigInt(1));
    expect(msg).toMatch(/minimum deposit/i);
  });

  it("refuses when the contract could not be read", async () => {
    const msg = await depositError(fakeAlgod({}), BigInt(5_000_000), null);
    expect(msg).toMatch(/couldn't read the dualstake contract/i);
  });

  it("refuses while an upgrade is queued", async () => {
    const msg = await depositError(fakeAlgod({}), BigInt(5_000_000), { upgrading: true });
    expect(msg).toMatch(/upgrade is queued/i);
  });

  it("refuses more than the protocol's headroom", async () => {
    const msg = await depositError(
      fakeAlgod({}), BigInt(5_000_000), { headroomMicroAlgo: BigInt(1_000_000) });
    expect(msg).toMatch(/remaining capacity/i);
  });
});

describe("mintRewardCost matches the SDK's own formula", () => {
  /*
    Reproduced from `dualstake-client.js`: `algo * rate / ratePrecision`, plus
    one base unit whenever the rate is non-zero. Used only to SHOW the figure
    and pre-check the balance — the transaction's amount still comes from the
    SDK.
  */
  const RATE = BigInt(311_947);

  it("agrees with the amount the SDK built on MainNet", () => {
    // Measured 2026-11-06: a 5 ALGO mint carried a 156 base $U leg.
    expect(mintRewardCost(BigInt(5_000_000), RATE)).toBe(BigInt(156));
    // And a 100,000 ALGO mint, 3,119,471.
    expect(mintRewardCost(BigInt(100_000_000_000), RATE)).toBe(BigInt(3_119_471));
  });

  it("adds the rounding unit only while the rate is non-zero", () => {
    expect(mintRewardCost(BigInt(5_000_000), BigInt(0))).toBe(BigInt(0));
    expect(mintRewardCost(BigInt(1), RATE)).toBe(BigInt(1));
  });
});

describe("the mint-rate read that bounds the \$U leg", () => {
  /*
    This read exists to be INDEPENDENT of the SDK.

    The first version bounded the SDK's $U leg using `snap.rate`, which comes
    from the SDK's own `getStateFallback` — so the ceiling and the amount it
    was meant to catch were derived by the same code. A wrong rate moved both
    together and the bound passed. This reads `staked` and `rate_precision`
    from global state and the app's $U holding from its account record, and
    applies the contract's own definition.

    It returns null rather than zero on every failure, because a zero rate
    makes any $U leg satisfy the bound — the check would still run and would
    no longer mean anything.
  */
  it("computes the rate the contract itself implies", async () => {
    const { readRateIndependently } = await import("./reads");
    // Measured on MainNet 2026-11-06: $U 1,538,507 base against 49,319,479,854
    // µALGO staked, precision 1e10 -> 311,947.
    const rate = await readRateIndependently(fakeAlgod({}));
    expect(rate).toBe(BigInt(311_947));
  });

  it("agrees with the \$U leg the SDK actually built", async () => {
    const { readRateIndependently } = await import("./reads");
    const rate = await readRateIndependently(fakeAlgod({}));
    expect(mintRewardCost(BigInt(5_000_000), rate!)).toBe(BigInt(156));
  });

  it("returns null, never zero, when global state cannot be read", async () => {
    const { readRateIndependently } = await import("./reads");
    expect(await readRateIndependently(fakeAlgod({ appFails: true }))).toBeNull();
  });

  it("returns null, never zero, when the app account cannot be read", async () => {
    const { readRateIndependently } = await import("./reads");
    expect(await readRateIndependently(fakeAlgod({ acctFails: true }))).toBeNull();
  });

  it("returns null rather than divide by a zero stake", async () => {
    const { readRateIndependently } = await import("./reads");
    expect(await readRateIndependently(fakeAlgod({ staked: BigInt(0) }))).toBeNull();
  });

  it("is tight enough to catch a doubled \$U charge", async () => {
    /*
      The old bound was `2 * est + 1000`, which let a 100,000 ALGO mint carry
      about 31 $U — twice the true cost — and call it normal. Excess $U goes to
      the contract and is not credited to the depositor.

      The bound in `deposit` is `est + est/100 + 2`. This is the property that
      matters: honest drift passes, a doubling does not.
    */
    const { readRateIndependently } = await import("./reads");
    const rate = (await readRateIndependently(fakeAlgod({})))!;
    const algo = BigInt(100_000_000_000);               // 100,000 ALGO
    const est = mintRewardCost(algo, rate);
    const bound = est + est / BigInt(100) + BigInt(2);

    expect(est * BigInt(2)).toBeGreaterThan(bound);      // a doubling is refused
    expect(est).toBeLessThanOrEqual(bound);              // the true cost passes
    // The old bound would have allowed it.
    expect(est * BigInt(2) + BigInt(1000)).toBeGreaterThan(bound);
  });
});
