// ── magnetALGO dualSTAKE — pinned configuration ────────────────────────────
//
// Myth Finance's liquid staking contract. Deposit ALGO (plus $U at the current
// mint rate), hold magnetALGO, redeem for 1 ALGO per token PLUS the $U that
// accrued against it. The yield is consensus rewards, swapped into $U.
//
// ── Everything here is pinned, and the reason is the same as pex/config ────
// This is a third-party contract. We check what we are talking to rather than
// trusting an id that arrived from a read, an SDK, or a URL.

import { U_TOKEN } from "@/lib/magnetfi";

/** The dualSTAKE application. Its address IS the magnetALGO creator. */
export const DUALSTAKE_APP_ID = 3760408044;
export const DUALSTAKE_APP_ADDRESS =
  "6DNHMU4W65CPAVL63PJDMX56F6KU3CLBAXGA4RDOEEZDUWWS5GUYT4WIDE";

/** magnetALGO, the liquid staking token. 6 decimals. */
export const MAGNET_ALGO_ASA_ID = 3760411000;
export const MAGNET_ALGO_DECIMALS = 6;

/**
 * The paired reward asset is $U, and it has FIVE decimals.
 *
 * magnetALGO has six. The contract's `rate` is base-unit $U per base-unit
 * magnetALGO, so any conversion that assumes matching decimals is out by 10x.
 * Verified against a real redemption: 353,286,105 base magnetALGO paid 11,020
 * base $U, and `rate/ratePrecision * 353,286,105` predicts 11,020.7 — 0.006%,
 * the rate having moved slightly since. See `rate.test.ts`.
 */
export const REWARD_ASA_ID = U_TOKEN.asaId;      // 3081853135
export const REWARD_DECIMALS = U_TOKEN.decimals; // 5

/** Tinyman v2, which the SDK routes through to source the $U leg of a mint. */
export const TINYMAN_APP_ID = 1002541853;
/** ARC-59 inbox router, referenced by the SDK's network constants. */
export const ARC59_APP_ID = 2449590623;

/** Scale of the contract's `rate`. Matches the SDK's PROD constants. */
export const RATE_PRECISION = 10_000_000_000;

/** Protocol-wide deposit ceiling, in microALGO. */
export const MAX_BALANCE_MICRO_ALGO = 65_000_000_000_000;

/** Fees, for disclosure on the card. Read live too — these are the pins. */
export const PLATFORM_FEE_BPS = 250;
export const NODERUNNER_FEE_BPS = 400;

/**
 * The approval program we reviewed, as of 2026-11-06.
 *
 * ── Why pin a program that is MEANT to change ─────────────────────────────
 * dualSTAKE is upgradeable: a one-week timelock, hashes published in advance,
 * and a protest mechanism, with dissenters free to redeem immediately. That
 * is a real governance process and better than most — but it still means the
 * code behind a user's ALGO can become code we have never read.
 *
 * So the hash is pinned, and a mismatch is treated ASYMMETRICALLY:
 *
 *   - MINT is blocked. Putting new money into a contract whose code changed
 *     under us is the decision that should wait for a human.
 *   - REDEEM is NOT blocked. Refusing to let someone leave because the
 *     contract was upgraded is a self-inflicted trap, and the same reasoning
 *     `exitBlocked` already applies on the perps path: a stale pin is no
 *     reason to stand between a holder and their funds.
 */
export const DUALSTAKE_APPROVAL_HASH =
  "FL5ST2MRMI25Z7TZ5EZDTX7KYZZGGATL6SXBE7QQ44CMOWECOMOHBKRFVA";

/**
 * Minimum deposit, in microALGO.
 *
 * Not a protocol rule — the contract has no minimum. This is ours, because a
 * deposit below roughly this size is eaten by the group's own network fees.
 */
export const MIN_DEPOSIT_MICRO_ALGO = 1_000_000;
