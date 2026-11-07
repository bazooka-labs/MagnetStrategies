// ── magnetALGO dualSTAKE — read-only chain queries ─────────────────────────
//
// Everything the card shows. Nothing here signs, and nothing here guesses: a
// figure we could not read comes back `null` so the UI can withhold it, which
// is the same rule the perps terminal and the governance page follow.

import algosdk from "algosdk";
import { DualStake, networkConstants } from "@myth-finance/dualstake-ts-sdk";
import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import {
  DUALSTAKE_APP_ID, MAGNET_ALGO_ASA_ID, MAGNET_ALGO_DECIMALS,
  MAX_BALANCE_MICRO_ALGO, RATE_PRECISION, REWARD_ASA_ID, REWARD_DECIMALS,
} from "./config";

/** What the card needs, all of it optional because a read can fail. */
export interface DualStakeSnapshot {
  /** Base-unit $U per base-unit magnetALGO, scaled by RATE_PRECISION. */
  rate: bigint;
  /** Total ALGO staked, microALGO. */
  stakedMicroAlgo: bigint;
  /** $U the contract currently holds, base units (5dp). */
  rewardBalance: bigint;
  /** Room left under the protocol cap, microALGO. Never negative. */
  headroomMicroAlgo: bigint;
  platformFeeBps: number;
  noderunnerFeeBps: number;
  /** The contract is mid-upgrade. Disclosed rather than hidden. */
  upgrading: boolean;
  /** Online and earning consensus rewards — the thing that funds the yield. */
  earning: boolean;
  /** Round the figures were read at, so the card can say how fresh it is. */
  round: bigint;
}

/**
 * A client for READS.
 *
 * `getRate()` and `getState()` go through `simulate`, which gathers signatures
 * and charges a fee against the sender — so with a throwaway address they fail
 * with `overspend` before reading anything. The `*Fallback` methods read
 * global state directly and need neither a signer nor a balance, which is what
 * a card that renders before a wallet connects actually requires.
 */
function readClient(algodServer: string) {
  const algorand = AlgorandClient.fromConfig({
    algodConfig: { server: algodServer, port: "", token: "" },
  });
  return DualStake.getContractAppClient({
    algorand,
    sender: algosdk.getApplicationAddress(DUALSTAKE_APP_ID).toString(),
    signer: algosdk.makeEmptyTransactionSigner(),
    network: "PROD",
    appId: BigInt(DUALSTAKE_APP_ID),
    // Unused on the read path: the registry resolves which contracts exist,
    // and we target one pinned app. Passing 0 keeps us from depending on an
    // id we have not verified.
    dsRegistryAppId: BigInt(0),
    tinymanAppId: networkConstants.PROD.tm2AppId,
    arc59RouterAppId: networkConstants.PROD.arc59AppId,
  });
}

/** The contract's current state, or null if it could not be read. */
export async function readSnapshot(algodServer: string): Promise<DualStakeSnapshot | null> {
  try {
    const s = await readClient(algodServer).getStateFallback();
    const staked = BigInt(s.staked);
    const cap = BigInt(MAX_BALANCE_MICRO_ALGO);
    return {
      rate: BigInt(s.rate),
      stakedMicroAlgo: staked,
      rewardBalance: BigInt(s.asaBalance),
      headroomMicroAlgo: cap > staked ? cap - staked : BigInt(0),
      platformFeeBps: Number(s.platformFeeBps),
      noderunnerFeeBps: Number(s.noderunnerFeeBps),
      upgrading: Boolean(s.upgrading),
      earning: Boolean(s.isOnline) && Boolean(s.incentiveEligible),
      round: BigInt(s.round),
    };
  } catch {
    return null;
  }
}

/** A wallet's magnetALGO, base units. `null` means unread, NOT zero. */
export async function readHolding(
  algod: algosdk.Algodv2, address: string,
): Promise<bigint | null> {
  try {
    const acct = await algod.accountInformation(address).do();
    const held = (acct.assets ?? []).find(
      (a: { assetId?: bigint | number }) => Number(a.assetId) === MAGNET_ALGO_ASA_ID);
    return held ? BigInt(held.amount) : BigInt(0);
  } catch {
    return null;
  }
}

/** A wallet's $U position. Opted-in-with-zero and not-opted-in differ. */
export interface RewardHolding {
  /** $U held, base units (5dp). */
  balance: bigint;
  /** Opted into $U at all. A mint's $U leg fails outright without this. */
  optedIn: boolean;
}

/**
 * A wallet's $U balance and opt-in, or null if unread.
 *
 * Needed because a deposit SPENDS $U — see `mintRewardCost`. Without this the
 * user met the requirement as a raw `asset missing from sender` out of
 * simulate, which is the class of message this card exists not to show.
 */
export async function readRewardHolding(
  algod: algosdk.Algodv2, address: string,
): Promise<RewardHolding | null> {
  try {
    const acct = await algod.accountInformation(address).do();
    const held = (acct.assets ?? []).find(
      (a: { assetId?: bigint | number }) => Number(a.assetId) === REWARD_ASA_ID);
    return held
      ? { balance: BigInt(held.amount), optedIn: true }
      : { balance: BigInt(0), optedIn: false };
  } catch {
    return null;
  }
}

/**
 * The contract's mint rate, computed from raw algod reads only.
 *
 * `readSnapshot` goes through the SDK's `getStateFallback`, which derives the
 * same number — so using it to BOUND the SDK's own $U leg checks the SDK
 * against itself. A bug or a compromise in that derivation would move our
 * ceiling and the amount it is meant to catch together, in step, and the
 * bound would pass.
 *
 * This reads `staked` and `rate_precision` from global state and the app
 * account's $U balance from its account record, and applies the same
 * definition the contract does. Returns null if anything could not be read —
 * never a zero, which would make any bound trivially satisfiable.
 */
export async function readRateIndependently(
  algod: algosdk.Algodv2,
): Promise<bigint | null> {
  try {
    const [app, acct] = await Promise.all([
      algod.getApplicationByID(DUALSTAKE_APP_ID).do(),
      algod.accountInformation(
        algosdk.getApplicationAddress(DUALSTAKE_APP_ID).toString()).do(),
    ]);
    const g = new Map<string, bigint>();
    for (const kv of app.params.globalState ?? []) {
      const key = Buffer.from(kv.key as unknown as string, "base64").toString();
      if (kv.value.type === 2) g.set(key, BigInt(kv.value.uint ?? 0));
    }
    const staked = g.get("staked");
    const precision = g.get("rate_precision");
    if (!staked || !precision || staked <= BigInt(0)) return null;

    const u = (acct.assets ?? []).find(
      (a: { assetId?: bigint | number }) => Number(a.assetId) === REWARD_ASA_ID);
    const uBal = u ? BigInt(u.amount) : BigInt(0);
    return (precision * uBal) / staked;
  } catch {
    return null;
  }
}

/**
 * The $U a mint of `algoMicro` costs the user, in $U base units.
 *
 * This is the SDK's own formula (`dualstake-client.js`: `algo * rate /
 * ratePrecision`, plus one base unit whenever the rate is non-zero) and it is
 * reproduced here ONLY to show the user the figure and to pre-check their
 * balance. The transaction's amount still comes from the SDK; we never
 * substitute this for it.
 *
 * A mint of N microALGO produces N base magnetALGO, so the cost is the accrual
 * that N magnetALGO already carries — a new token has to arrive backed by the
 * same $U per token as every existing one.
 */
export function mintRewardCost(algoMicro: bigint, rate: bigint): bigint {
  const cost = (algoMicro * rate) / BigInt(RATE_PRECISION);
  return rate > BigInt(0) ? cost + BigInt(1) : cost;
}

/**
 * The $U that `lstBase` magnetALGO would redeem for, in $U base units.
 *
 * The only conversion in this module that can silently be 10x wrong, because
 * magnetALGO carries 6 decimals and $U carries 5. `rate` is defined base-unit
 * to base-unit, so it must be applied BEFORE any decimal scaling and never
 * after. Kept in bigint for the same reason.
 */
export const accruedReward = (lstBase: bigint, rate: bigint): bigint =>
  (lstBase * rate) / BigInt(RATE_PRECISION);

/** Display helpers. Separate from the maths above, deliberately. */
export const toAlgo = (micro: bigint): number => Number(micro) / 1e6;
export const toMagnetAlgo = (base: bigint): number =>
  Number(base) / 10 ** MAGNET_ALGO_DECIMALS;
export const toReward = (base: bigint): number =>
  Number(base) / 10 ** REWARD_DECIMALS;
