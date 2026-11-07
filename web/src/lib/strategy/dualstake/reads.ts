// ── magnetALGO dualSTAKE — read-only chain queries ─────────────────────────
//
// Everything the card shows. Nothing here signs, and nothing here guesses: a
// figure we could not read comes back `null` so the UI can withhold it, which
// is the same rule the perps terminal and the governance page follow.

import algosdk from "algosdk";
import { DualStake, networkConstants } from "@myth-finance/dualstake-ts-sdk";
import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import {
  ARC59_APP_ID, DUALSTAKE_APP_ID, MAGNET_ALGO_ASA_ID, MAGNET_ALGO_DECIMALS,
  MAX_BALANCE_MICRO_ALGO, RATE_PRECISION, REWARD_DECIMALS, TINYMAN_APP_ID,
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
