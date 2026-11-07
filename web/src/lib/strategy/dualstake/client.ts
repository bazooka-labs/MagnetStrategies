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
import { accruedReward, readSnapshot } from "./reads";

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

  const pinned = await approvalMatchesPin(algod);
  if (pinned === false) {
    throw new Error(
      "The dualSTAKE contract's code has changed since we reviewed it, so deposits "
      + "are paused here. Redeeming still works. This is expected during one of "
      + "Myth's timelocked upgrades.");
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

  const client = sdkClient(algod, algodServer, sender, algosdk.makeEmptyTransactionSigner());
  const composer = await client.makeMintTransactions({ algoAmount: Number(algoMicro) });
  const built = await (await composer.composer()).build();
  const txns = built.transactions.map((t) => t.txn);

  /*
    The bound on the $U leg.

    `rate` is base-unit $U per base-unit magnetALGO and a mint of N microALGO
    produces N base magnetALGO, so the $U required is `accruedReward(N, rate)`.
    Doubling it leaves room for the rate moving between our read and the
    build without leaving room for a wrong order of magnitude — which is the
    failure this is actually guarding against.
  */
  const expectedReward = accruedReward(algoMicro, snap.rate);
  const check = assertDualStakeGroup(txns, {
    sender, kind: "mint",
    expectedAlgoMicro: algoMicro,
    maxRewardBase: expectedReward * BigInt(2) + BigInt(1000),
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
