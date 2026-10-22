/**
 * Gates on a liquidity deposit or withdrawal, read before anything is offered.
 *
 * ── Why this exists as its own module ──
 * Most of the gates below are enforced on chain and reported by **no quote**:
 * `quoteV2CvaIdleWithdraw` and `quoteV2CvaMarketWithdraw` return `ok: true`
 * while the chain rejects. Deciding availability before rendering an action is
 * the same discipline `perpsPreflight.ts` applies to opening a position — never
 * offer a button whose transaction the chain will refuse.
 *
 * The one exception is the direct-pool cooldown, which the SDK DOES quote:
 * `quoteV2DirectLpWithdrawCooldown` owns the arithmetic and the 3600 constant,
 * so this module reads `last_deposit_timestamp` off the box and delegates
 * rather than re-implementing it. Verified against the deployed bytecode:
 *
 *     global LatestTimestamp ; <box>[8..16] ; pushint 3600 ; + ; >= ; assert
 *     — markets.teal:2824-2831 (guarded), :3149-3156 (unconditional)
 *
 * An earlier revision of strategy/pools/SIGNING.md called that cooldown
 * "advisory", from a grep for the string `cooldown` that could never match
 * `pushint 3600`. It is consensus-enforced. A Withdraw button offered inside
 * the window does not warn — it fails.
 *
 * Pure decision functions, network reads separated, so every gate is testable
 * against values rather than against a node.
 */

import algosdk from "algosdk";
import { quoteV2DirectLpWithdrawCooldown } from "@pdex/sdk";
import { PEX_APPS, PEX_ASSETS } from "../perps";
import { readLpState, type LpState } from "./reads";

/**
 * C-Vault cooldown, in ROUNDS — a different unit from the direct pools, which
 * is why this is not one shared code path. Confirmed in the vault's own
 * bytecode at `label58`:
 *
 *     global Round ; <user_state>[8..16] ; cva_withdraw_cooldown_rounds ; + ; >= ; assert
 *
 * and skipped entirely when that global is 0. The live value is 1200. It is
 * read from chain on every check; this is only the fallback for a failed read.
 */
export const CVA_COOLDOWN_ROUNDS_FALLBACK = 1200;

/**
 * Only ever used to phrase a round count as a duration, never to decide a gate.
 * Algorand targets ~2.8s, so 1200 rounds is ~56 minutes.
 */
export const SECONDS_PER_ROUND = 2.8;

export type GateCode =
  | "cooldown"
  | "deposit_paused"
  | "withdraw_paused"
  | "allocation_withdraw_only"
  | "per_call_cap"
  | "insufficient_algo"
  | "insufficient_usdc"
  | "no_usdc_optin"
  | "below_minimum"
  | "below_exit_floor"
  | "nothing_to_withdraw";

export type Gate = {
  code: GateCode;
  /** Copy for the user. §6b: a duration always, and never the word "lock". */
  message: string;
  /** Seconds until this clears by itself, when it does. */
  retryAfterSec?: number;
};

// ── cooldowns ─────────────────────────────────────────────────────────────────

/**
 * Direct-pool cooldown.
 *
 * ⚠️ `updated_at` is rewritten to now on EVERY deposit, so a top-up restarts
 * the hour on the WHOLE position, not just the part added. It is not a one-time
 * onboarding cost and the copy must not imply one — hence `depositRestartsCooldown`.
 */
export function directCooldownGate(
  updatedAtSec: number, nowSec: number,
): Gate | null {
  // Zero means this wallet has never deposited. The SDK returns ok for it, and
  // so does the chain: `extract_uint64` yields 0, and 0 + 3600 is long past.
  const q = quoteV2DirectLpWithdrawCooldown({
    lastDepositTimestamp: Math.max(0, Math.floor(updatedAtSec)),
    currentTimestamp: Math.max(0, Math.floor(nowSec)),
  });
  if (!q.blocked) return null;
  const remaining = Number(q.remaining_seconds);
  return {
    code: "cooldown",
    message: `Withdrawals open in ${phrase(remaining)}`,
    retryAfterSec: remaining,
  };
}

/** True when a deposit would restart an existing position's cool-down. */
export function depositRestartsCooldown(st: LpState | null): boolean {
  return !!st && st.shares > 0;
}

/** C-Vault cooldown, measured in ROUNDS off `cva_user_state[8..16]`. */
export function cvaCooldownGate(
  lastDepositRound: number, currentRound: number, cooldownRounds: number,
): Gate | null {
  if (cooldownRounds <= 0) return null; // the contract skips the assert entirely
  if (lastDepositRound <= 0) return null;
  const readyRound = lastDepositRound + cooldownRounds;
  if (currentRound >= readyRound) return null;
  const remaining = Math.ceil((readyRound - currentRound) * SECONDS_PER_ROUND);
  return {
    code: "cooldown",
    message: `Withdrawals open in ${phrase(remaining)}`,
    retryAfterSec: remaining,
  };
}

/**
 * §6b's wording, in one place.
 *
 * Always a duration. "A short cool-down applies" is friendly and useless: a
 * user who acts on it gets a failed signature rather than a disappointment.
 * Never "lock", "locked", "frozen" or "cannot" — a test asserts their absence.
 */
export function phrase(seconds: number): string {
  if (seconds < 90) return "under a minute";
  const mins = Math.ceil(seconds / 60);
  if (mins < 60) return `${mins} minutes`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem === 0 ? `${hrs} hour${hrs > 1 ? "s" : ""}` : `${hrs}h ${rem}m`;
}

// ── minimums, and the C-Vault dust trap ───────────────────────────────────────

/**
 * The C-Vault's exit floor bites an exact-$5 deposit.
 *
 * `min_cva_withdraw_usd` is $5 (live: 5000000) and applies to the withdrawal
 * VALUE. Both spreads are 20 bps, so $5.00 in leaves $4.98003992 withdrawable —
 * permanently under the floor, with no way out but depositing more. The minimum
 * fully-exitable deposit is ≈ $5.0201.
 *
 * $5.25 is the product minimum: it clears the floor with ~4.5% of headroom,
 * which matters because the floor is checked at withdrawal time against a NAV
 * that may have fallen since.
 */
export const CVA_MIN_DEPOSIT_USD = 5.25;

/** Below this, offer full exit only — a partial would strand sub-floor dust. */
export const CVA_FULL_EXIT_BELOW_USD = 10;

/** What a deposit survives as, round-tripped at the live spreads. */
export function cvaWithdrawableAfterRoundTrip(
  depositUsd: number, mintSpreadBps: number, burnSpreadBps: number,
): number {
  const gross = depositUsd * 10_000 / (10_000 + mintSpreadBps);
  return gross * (10_000 - burnSpreadBps) / 10_000;
}

export function cvaDepositGate(input: {
  depositUsd: number;
  minWithdrawUsd: number;
  mintSpreadBps: number;
  burnSpreadBps: number;
}): Gate | null {
  const { depositUsd, minWithdrawUsd, mintSpreadBps, burnSpreadBps } = input;
  if (depositUsd < CVA_MIN_DEPOSIT_USD) {
    return {
      code: "below_minimum",
      message: `Minimum deposit is $${CVA_MIN_DEPOSIT_USD.toFixed(2)}`,
    };
  }
  const out = cvaWithdrawableAfterRoundTrip(depositUsd, mintSpreadBps, burnSpreadBps);
  if (out < minWithdrawUsd) {
    // Belt and braces: CVA_MIN_DEPOSIT_USD already clears the live floor, but
    // both the floor and the spreads are admin-mutable, so this recomputes
    // rather than trusting the constant to stay sufficient.
    return {
      code: "below_exit_floor",
      message:
        `A $${depositUsd.toFixed(2)} deposit would leave $${out.toFixed(2)} withdrawable, `
        + `under this vault's $${minWithdrawUsd.toFixed(2)} withdrawal minimum. `
        + `Deposit a little more to keep a clean exit.`,
    };
  }
  return null;
}

// ── C-Vault state, none of which any quote reports ───────────────────────────

export type CvaVaultState = {
  depositPaused: boolean;
  withdrawPaused: boolean;
  cooldownRounds: number;
  minWithdrawUsd: number;
  mintSpreadBps: number;
  burnSpreadBps: number;
  maxNavAgeRounds: number;
  lastNavUpdateRound: number;
  maxDepositUsdPerCall: number;
  maxWithdrawUsdPerCall: number;
  /** `active_market_0..3`, zeros dropped. Each non-zero one may need a mark leg. */
  activeMarkets: number[];
};

const GLOBAL_KEYS = [
  "deposit_paused", "withdraw_paused", "cva_withdraw_cooldown_rounds",
  "min_cva_withdraw_usd", "cva_mint_spread_bps", "cva_burn_spread_bps",
  "max_nav_age_rounds", "last_nav_update_round",
  "max_cva_deposit_usd_per_call", "max_cva_withdraw_usd_per_call",
  "active_market_0", "active_market_1", "active_market_2", "active_market_3",
] as const;

export async function readCvaVaultState(algod: algosdk.Algodv2): Promise<CvaVaultState> {
  const app = await algod.getApplicationByID(PEX_APPS.cvaVault).do();
  const raw = new Map<string, bigint>();
  for (const kv of app.params.globalState ?? []) {
    const key = Buffer.from(kv.key as unknown as Uint8Array).toString("utf8");
    raw.set(key, BigInt(kv.value?.uint ?? 0));
  }
  const g = (k: string): number => {
    const v = raw.get(k);
    if (v === undefined) {
      // A renamed or removed global means our read of this vault is stale, and
      // every gate built on it would otherwise read as "fine".
      throw new Error(`cva vault: global ${k} is absent — pinned layout is stale`);
    }
    return Number(v);
  };
  for (const k of GLOBAL_KEYS) g(k);
  return {
    depositPaused: g("deposit_paused") !== 0,
    withdrawPaused: g("withdraw_paused") !== 0,
    cooldownRounds: g("cva_withdraw_cooldown_rounds"),
    minWithdrawUsd: g("min_cva_withdraw_usd") / 1e6,
    mintSpreadBps: g("cva_mint_spread_bps"),
    burnSpreadBps: g("cva_burn_spread_bps"),
    maxNavAgeRounds: g("max_nav_age_rounds"),
    lastNavUpdateRound: g("last_nav_update_round"),
    maxDepositUsdPerCall: g("max_cva_deposit_usd_per_call") / 1e6,
    maxWithdrawUsdPerCall: g("max_cva_withdraw_usd_per_call") / 1e6,
    activeMarkets: [0, 1, 2, 3].map((i) => g(`active_market_${i}`)).filter((m) => m !== 0),
  };
}

export function cvaPauseGate(v: CvaVaultState, action: "deposit" | "withdraw"): Gate | null {
  if (action === "deposit" && v.depositPaused) {
    return { code: "deposit_paused", message: "PEX has paused deposits to this vault." };
  }
  if (action === "withdraw" && v.withdrawPaused) {
    return { code: "withdraw_paused", message: "PEX has paused withdrawals from this vault." };
  }
  return null;
}

/** 0 means unlimited, matching the contract's `bz` skip over the assert. */
export function perCallCapGate(
  valueUsd: number, capUsd: number, action: "deposit" | "withdraw",
): Gate | null {
  if (capUsd <= 0 || valueUsd <= capUsd) return null;
  return {
    code: "per_call_cap",
    message:
      `PEX caps a single ${action} at $${capUsd.toLocaleString("en-US")}. `
      + `Split this into smaller ${action}s.`,
  };
}

/** `status` 3 = WITHDRAW_ONLY, so deposits to that allocation are refused. */
export function allocationStatusGate(
  status: number, action: "deposit" | "withdraw",
): Gate | null {
  if (action === "withdraw" || status !== 3) return null;
  return {
    code: "allocation_withdraw_only",
    message: "PEX has set this market to withdraw-only; deposits are not being accepted.",
  };
}

/**
 * How many `mark_market` legs a C-Vault group needs — NOT a user-facing gate.
 *
 * The vault enforces NAV freshness two different ways, and the strict one
 * decides the group's shape:
 *
 *   lenient  `Round <= mark_round + max_nav_age_rounds` (5 rounds, ~14s)
 *            — cva.teal label143, per active market holding shares
 *   strict   `gm2:[40..48] == global Round`, exact equality, AND a verified
 *            `mark_market` (selector 0x7eda6c29) for that market present in
 *            the same group — cva.teal:5160-5205
 *
 * Under the strict path no amount of waiting helps: the mark must land in the
 * same round as the action, which is only possible inside the group. So a stale
 * NAV is never something to tell the user to retry — it is a leg to add.
 */
export function marksRequired(v: CvaVaultState, allocationsWithShares: number[]): number[] {
  return v.activeMarkets.filter((m) => allocationsWithShares.includes(m));
}

// ── balance preflight, mirroring the terminal's open path ────────────────────

export type Balances = {
  /** µALGO the wallet can actually spend: amount − min-balance. */
  algoSpendableMicro: number;
  usdcMicro: number;
  usdcOptedIn: boolean;
};

export async function readBalances(
  algod: algosdk.Algodv2, address: string,
): Promise<Balances> {
  const info = await algod.accountInformation(address).do();
  const usdc = (info.assets ?? []).find((a) => Number(a.assetId) === PEX_ASSETS.usdc);
  return {
    algoSpendableMicro: Math.max(0, Number(info.amount) - Number(info.minBalance)),
    usdcMicro: usdc ? Number(usdc.amount) : 0,
    usdcOptedIn: !!usdc,
  };
}

/**
 * Can this wallet actually pay for the group?
 *
 * The ALGO leg, the group fees and the box MBR all come out of
 * `amount − minBalance`, never the headline balance. Without this a user
 * depositing near their whole balance gets an opaque chain rejection; the
 * terminal checks the same three things before building.
 */
export function balanceGates(input: {
  balances: Balances;
  algoLegMicro: number;
  usdcLegMicro: number;
  groupFeeMicro: number;
  storagePayMicro: number;
  /** Payouts arrive by inner transfer, so the receiver must already be opted in. */
  needsUsdcOptIn: boolean;
}): Gate[] {
  const { balances, algoLegMicro, usdcLegMicro, groupFeeMicro, storagePayMicro } = input;
  const gates: Gate[] = [];
  const algoNeeded = algoLegMicro + groupFeeMicro + storagePayMicro;
  if (balances.algoSpendableMicro < algoNeeded) {
    gates.push({
      code: "insufficient_algo",
      message:
        `Needs ${(algoNeeded / 1e6).toFixed(3)} ALGO including fees and the one-off account `
        + `record; ${(balances.algoSpendableMicro / 1e6).toFixed(3)} is spendable.`,
    });
  }
  if (input.needsUsdcOptIn && !balances.usdcOptedIn) {
    gates.push({
      code: "no_usdc_optin",
      // "cannot receive" is the harsh register the copy standard rules out, and
      // it also misreads as a dead end when it is a one-tap fix.
      message: "Opt this wallet in to USDC first, so the USDC side has somewhere to land.",
    });
  }
  if (usdcLegMicro > 0 && balances.usdcMicro < usdcLegMicro) {
    gates.push({
      code: "insufficient_usdc",
      message:
        `Needs ${(usdcLegMicro / 1e6).toFixed(2)} USDC; this wallet holds `
        + `${(balances.usdcMicro / 1e6).toFixed(2)}.`,
    });
  }
  return gates;
}

// ── market-pool gates ─────────────────────────────────────────────────────────

/**
 * Product minimum on a direct-pool deposit, in USD of the two legs together.
 *
 * Matches the terminal's $5, as asked. Unlike the C-Vault's, this one is OURS:
 * the Markets app enforces no minimum deposit and has no exit floor, so a $1
 * deposit would work and be fully withdrawable. The reason for a floor anyway
 * is cost — a deposit costs 0.055 ALGO in fees and an exit 0.117, so roughly
 * $0.04 of the two round-tripped. On $1 that is 4%, which no APR on this page
 * would recover in a reasonable holding period.
 *
 * Deliberately NOT the $5.25 the C-Vault needs: that extra quarter exists only
 * to clear the vault's $5 withdrawal floor after two 20 bps spreads, and neither
 * applies here. Using one number for both would misstate why it exists.
 */
export const MARKET_MIN_DEPOSIT_USD = 5;

export function marketDepositMinimumGate(depositUsd: number): Gate | null {
  if (depositUsd >= MARKET_MIN_DEPOSIT_USD) return null;
  return {
    code: "below_minimum",
    message:
      `Minimum deposit is $${MARKET_MIN_DEPOSIT_USD.toFixed(2)}. Below that, the `
      + `network fees to get in and out are a large share of the deposit.`,
  };
}

export async function readMarketGateState(
  algod: algosdk.Algodv2, marketId: number, address: string,
): Promise<LpState> {
  return (await readLpState(algod, marketId, address)) ?? { shares: 0, updatedAtSec: 0 };
}

/** Every gate on a market-pool action, in the order a user should see them. */
export function marketGates(input: {
  action: "deposit" | "withdraw";
  state: LpState;
  balances: Balances;
  nowSec: number;
  algoLegMicro: number;
  usdcLegMicro: number;
  groupFeeMicro: number;
  storagePayMicro: number;
  /**
   * Value of the deposit, for the product minimum. Omitted on a withdrawal,
   * and omitted when no price is available — in which case the minimum is not
   * enforced rather than guessed at, because a wrong refusal is worse than a
   * $4 deposit.
   */
  depositUsd?: number;
}): Gate[] {
  const gates: Gate[] = [];
  if (input.action === "deposit" && input.depositUsd !== undefined) {
    const min = marketDepositMinimumGate(input.depositUsd);
    if (min) gates.push(min);
  }
  if (input.action === "withdraw") {
    if (input.state.shares <= 0) {
      gates.push({ code: "nothing_to_withdraw", message: "No position in this pool." });
    } else {
      const cd = directCooldownGate(input.state.updatedAtSec, input.nowSec);
      if (cd) gates.push(cd);
    }
  }
  gates.push(...balanceGates({
    balances: input.balances,
    algoLegMicro: input.action === "deposit" ? input.algoLegMicro : 0,
    usdcLegMicro: input.action === "deposit" ? input.usdcLegMicro : 0,
    groupFeeMicro: input.groupFeeMicro,
    storagePayMicro: input.action === "deposit" ? input.storagePayMicro : 0,
    // A withdrawal pays both sides out by inner transaction.
    needsUsdcOptIn: input.action === "withdraw",
  }));
  return gates;
}

/** The worst gate, for a disabled button's label. */
export const primaryGate = (gates: Gate[]): Gate | null => gates[0] ?? null;
