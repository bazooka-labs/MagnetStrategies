// ── magnetALGO dualSTAKE — deposit and redeem ─────────────────────────────
//
// The order is always: Myth's SDK BUILDS, we ASSERT, the chain SIMULATES, the
// user SIGNS. No step is skipped and the order does not change — asserting
// after a signature, or signing without a simulation, is how a frontend turns
// a dependency bug into a loss.

import algosdk from "algosdk";
import { DualStake, networkConstants } from "@myth-finance/dualstake-ts-sdk";
import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import {
  DUALSTAKE_APP_ID, DUALSTAKE_PROGRAM_SHA256, MIN_DEPOSIT_MICRO_ALGO,
} from "./config";
import { assertDualStakeGroup } from "./group";
import {
  mintRewardCost, readRateIndependently, readRewardHolding, readSnapshot,
} from "./reads";
import { formatBaseUnits } from "./amount";
import { REWARD_DECIMALS } from "./config";

type SignFn = (txns: Uint8Array[]) => Promise<(Uint8Array | null)[]>;

/** Submitted but never seen to confirm. NOT a failure — see governance.ts. */
export class DualStakeUnconfirmed extends Error {
  readonly txid: string;
  constructor(txid: string) {
    super("Submitted, but we couldn't confirm it in time. "
      + "Check your wallet before trying again.");
    this.name = "DualStakeUnconfirmed";
    this.txid = txid;
  }
}
export const isDualStakeUnconfirmed = (e: unknown): e is DualStakeUnconfirmed =>
  e instanceof DualStakeUnconfirmed;

/**
 * Is the deployed code still the code we reviewed?
 *
 * Returns null when it could not be read — which is NOT a mismatch, and must
 * not be treated as one. See the asymmetry in `config.ts`: a real mismatch
 * blocks a deposit and never an exit.
 */
export async function approvalMatchesPin(algod: algosdk.Algodv2): Promise<boolean | null> {
  try {
    const app = await algod.getApplicationByID(DUALSTAKE_APP_ID).do();
    const prog = app.params.approvalProgram;
    if (!prog) return null;
    // Same digest the PEX pins use, via `crypto.subtle` — available in the
    // browser and in Node 18+, so the check behaves identically in tests.
    const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(prog as ArrayLike<number>));
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    return hex === DUALSTAKE_PROGRAM_SHA256;
  } catch {
    return null;
  }
}

function sdkClient(algod: algosdk.Algodv2, algodServer: string, sender: string, signer: algosdk.TransactionSigner) {
  const algorand = AlgorandClient.fromConfig({
    algodConfig: { server: algodServer, port: "", token: "" },
  });
  return DualStake.getContractAppClient({
    algorand, sender, signer, network: "PROD",
    appId: BigInt(DUALSTAKE_APP_ID),
    dsRegistryAppId: BigInt(0),
    tinymanAppId: networkConstants.PROD.tm2AppId,
    arc59RouterAppId: networkConstants.PROD.arc59AppId,
  });
}

/** Sign a built group with the wallet and submit it. */
async function signAndSend(
  algod: algosdk.Algodv2, sign: SignFn, txns: algosdk.Transaction[],
): Promise<string> {
  // Already grouped by `simulateOrThrow`, deliberately — see the note there.
  const signed = await sign(txns.map((t) => algosdk.encodeUnsignedTransaction(t)));
  const blobs = signed.filter((s): s is Uint8Array => !!s);
  if (blobs.length !== txns.length) throw new Error("Transaction signing cancelled.");
  const res = await algod.sendRawTransaction(blobs).do();
  try {
    await algosdk.waitForConfirmation(algod, res.txid, 6);
  } catch {
    throw new DualStakeUnconfirmed(res.txid);
  }
  return res.txid;
}

export interface DepositInput {
  algod: algosdk.Algodv2;
  algodServer: string;
  sign: SignFn;
  sender: string;
  /** Exactly what the user typed, in microALGO. */
  algoMicro: bigint;
}

/**
 * Deposit ALGO and receive magnetALGO.
 *
 * The $U leg is derived BY THE SDK from the current mint rate. We do not
 * recompute it — an earlier hand-rolled attempt did, from an unrepresentative
 * sample of chain transactions, and got it wrong. We bound it instead, from
 * our own rate read, which catches a wrong figure without pretending to own
 * the calculation.
 */
export async function deposit(input: DepositInput): Promise<string> {
  const { algod, algodServer, sign, sender, algoMicro } = input;

  if (algoMicro < BigInt(MIN_DEPOSIT_MICRO_ALGO)) {
    throw new Error(`The minimum deposit is ${MIN_DEPOSIT_MICRO_ALGO / 1e6} ALGO — `
      + "below that the network fees take most of it.");
  }

  /*
    The pin check FAILS CLOSED on a deposit.

    `approvalMatchesPin` returns null when it could not read the program, and
    an earlier version here blocked only on `=== false`. That made an
    unreachable or erroring algod indistinguishable from a verified match, so
    the one condition that must hold before new money goes in — this is the
    code we reviewed — was satisfied by a network error.

    Redeem still skips the check entirely, which is the asymmetry `config.ts`
    describes: failing to deposit costs a user nothing, failing to exit traps
    them.
  */
  const pinned = await approvalMatchesPin(algod);
  if (pinned === false) {
    throw new Error(
      "The dualSTAKE contract's code has changed since we reviewed it, so deposits "
      + "are paused here. Redeeming still works. This is expected during one of "
      + "Myth's timelocked upgrades.");
  }
  if (pinned === null) {
    throw new Error("Couldn't verify the dualSTAKE contract's code against the version "
      + "we reviewed, so nothing was sent. Try again in a moment. Redeeming is "
      + "unaffected.");
  }

  const snap = await readSnapshot(algodServer);
  if (!snap) throw new Error("Couldn't read the dualSTAKE contract. Nothing was sent.");
  if (snap.upgrading) {
    throw new Error("A contract upgrade is queued at Myth. Deposits are paused here "
      + "until it lands and we have reviewed it; redeeming is unaffected.");
  }
  if (algoMicro > snap.headroomMicroAlgo) {
    throw new Error("That is more than the protocol's remaining capacity "
      + `(${(Number(snap.headroomMicroAlgo) / 1e6).toLocaleString()} ALGO).`);
  }

  /*
    A deposit SPENDS $U, and the user has to have some.

    Minting is "X ALGO + Y $U", because a new magnetALGO must arrive backed by
    the same accrued $U per token as every existing one. The SDK opts the user
    into magnetALGO but never into $U, and always includes the $U leg while the
    rate is above zero — so a wallet holding plenty of ALGO and no $U cannot
    deposit at all, and found that out from a raw `asset missing from sender`
    inside a simulate failure.

    Checked before the build so the message names the amount.
  */
  const needReward = mintRewardCost(algoMicro, snap.rate);
  if (needReward > BigInt(0)) {
    const uHeld = await readRewardHolding(algod, sender);
    const amount = `${formatBaseUnits(needReward, REWARD_DECIMALS)} $U`;
    if (uHeld === null) {
      throw new Error("Couldn't read your $U balance, so nothing was sent. "
        + `A deposit of this size also costs about ${amount}.`);
    }
    if (!uHeld.optedIn) {
      throw new Error(`Depositing also costs ${amount}, and this wallet isn't opted `
        + "into $U yet. Hold a little $U first — the Trade page can swap some for you.");
    }
    if (uHeld.balance < needReward) {
      throw new Error(`Depositing ${formatBaseUnits(algoMicro, 6)} ALGO also costs `
        + `${amount}, and this wallet holds `
        + `${formatBaseUnits(uHeld.balance, REWARD_DECIMALS)} $U. `
        + "The $U comes back when you redeem.");
    }
  }

  const client = sdkClient(algod, algodServer, sender, algosdk.makeEmptyTransactionSigner());
  const composer = await client.makeMintTransactions({ algoAmount: Number(algoMicro) });
  const built = await (await composer.composer()).build();
  const txns = built.transactions.map((t) => t.txn);

  /*
    The bound on the $U leg — INDEPENDENTLY computed, and tight.

    Two things were wrong with the first version, `2 * est + 1000` off
    `snap.rate`.

    It was not independent. `snap` comes from the SDK's own `getStateFallback`,
    so the ceiling and the amount it bounds were derived by the same code: a
    wrong rate would move both together and the check would pass. The rate
    here is read straight from global state and the app's asset holding.

    And it was loose by design where looseness buys nothing. The honest gap
    between our read and the SDK's is the pending reward swap, which only fires
    above about 1 ALGO of accrual, so 1% plus a base unit of rounding covers it
    with room to spare; 2x permitted a doubled charge on a 100,000 ALGO mint —
    about 31 $U — to pass as normal. Excess $U is not credited to the user.

    Failing closed when the rate cannot be read independently is deliberate.
    A null here is not a zero: treating it as one would make any $U leg
    satisfy the bound.
  */
  const rate = await readRateIndependently(algod);
  if (rate === null) {
    throw new Error("Couldn't independently check the dualSTAKE mint rate, so nothing "
      + "was sent. Try again in a moment.");
  }
  const expectedReward = mintRewardCost(algoMicro, rate);
  const check = assertDualStakeGroup(txns, {
    sender, kind: "mint",
    expectedAlgoMicro: algoMicro,
    maxRewardBase: expectedReward + expectedReward / BigInt(100) + BigInt(2),
  });
  if (!check.ok) {
    console.warn("dualstake: assertion refused the deposit", check.failures);
    throw new Error("A safety check on the transaction did not pass, so nothing was sent: "
      + check.failures.map((f) => f.code).join(", "));
  }

  await simulateOrThrow(algod, txns, sender);
  return signAndSend(algod, sign, txns);
}

export interface RedeemInput {
  algod: algosdk.Algodv2;
  algodServer: string;
  sign: SignFn;
  sender: string;
  /** Exactly what the user typed, in magnetALGO base units. */
  lstBase: bigint;
}

/**
 * Redeem magnetALGO for ALGO plus accrued $U.
 *
 * Deliberately does NOT check the program pin. An exit must not be blocked
 * because the contract was upgraded — that is the trap `exitBlocked` already
 * avoids on the perps path, and the one a stale gate created this week.
 */
export async function redeem(input: RedeemInput): Promise<string> {
  const { algod, algodServer, sign, sender, lstBase } = input;
  if (lstBase <= BigInt(0)) throw new Error("Enter an amount to redeem.");

  const client = sdkClient(algod, algodServer, sender, algosdk.makeEmptyTransactionSigner());
  const composer = await client.makeRedeemTransactions({ dsAmount: Number(lstBase) });
  const built = await (await composer.composer()).build();
  const txns = built.transactions.map((t) => t.txn);

  const check = assertDualStakeGroup(txns, { sender, kind: "redeem", expectedLstBase: lstBase });
  if (!check.ok) {
    console.warn("dualstake: assertion refused the redeem", check.failures);
    throw new Error("A safety check on the transaction did not pass, so nothing was sent: "
      + check.failures.map((f) => f.code).join(", "));
  }

  await simulateOrThrow(algod, txns, sender);
  return signAndSend(algod, sign, txns);
}

/**
 * Simulate the real bytes before asking for a signature.
 *
 * "Simulation is not a signature" cuts both ways: it proves nothing about
 * whether a wallet CAN sign, but it does prove the chain accepts the group —
 * which turns an on-chain failure the user pays for into a message they do
 * not.
 */
async function simulateOrThrow(
  algod: algosdk.Algodv2, txns: algosdk.Transaction[], sender: string,
): Promise<void> {
  // Group ids are assigned ONCE, here, and the same grouped objects go on to
  // be signed. Simulating a copy and signing the originals would mean the
  // bytes the chain approved are not the bytes the wallet is shown.
  if (txns.length > 1) algosdk.assignGroupID(txns);
  const atc = new algosdk.AtomicTransactionComposer();
  const empty = algosdk.makeEmptyTransactionSigner();
  for (const txn of txns) atc.addTransaction({ txn, signer: empty });
  const req = new algosdk.modelsv2.SimulateRequest({
    txnGroups: [],
    allowEmptySignatures: true,
  });
  const res = await atc.simulate(algod, req);
  const failure = res.simulateResponse.txnGroups[0]?.failureMessage;
  if (failure) {
    throw new Error(`The pre-flight check did not pass, so nothing was sent: ${failure}`);
  }
  void sender;
}
