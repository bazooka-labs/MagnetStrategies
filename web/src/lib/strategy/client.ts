/**
 * The one entry point the UI calls to add or remove liquidity.
 *
 * Order matters and is not arbitrary:
 *
 *   1. verify the deployed programs still hash to what we pinned
 *   2. read the gates — balances, cool-down, pauses, caps
 *   3. quote, build, assert, simulate   (`liquidityGroup`)
 *   4. sign and submit                  (`submitGroup`)
 *
 * Step 1 is first because it is the only control that observes a PEX upgrade:
 * app ids do not change on one, so pinned ids and pinned ABI specs both survive
 * a program swap untouched. Step 2 is before step 3 because a gate discovered
 * after a wallet prompt is a failed signature, and the whole point of
 * `liquidityPreflight` is that the chain's refusals are predicted rather than
 * caught.
 *
 * ── Why there is no "deposit anyway" path ──
 * Every failure here returns before anything is signed. On drift the right
 * behaviour differs by direction, and it is the same rule the terminal uses:
 * **block entries, keep exits live.** A depositor can wait; someone trying to
 * get their capital out of a protocol that just changed underneath them cannot,
 * and a blanket halt would strand them.
 */

import algosdk from "algosdk";
import { verifyProgramPins, verifyOracleSignerPin, signerDriftMessage } from "../perpsReads";
import {
  buildDeposit, buildWithdraw, storagePaymentFor,
  type BuildResult, type Stage,
} from "./group";
import {
  readQuoteContext, readRecallContext, quoteWithdraw, recallCaps,
  DEFAULT_LIQUIDITY_SLIPPAGE_BPS,
} from "./quote";
import {
  readBalances, readMarketGateState, marketGates, primaryGate,
  type Gate,
} from "./preflight";
import { signAndSubmit, type SignFn, type SubmitResult } from "./submit";

/** Measured group fees: deposit 55,000 µALGO, withdrawal 117,000. */
const DEPOSIT_FEE_MICRO = 55_000;
const WITHDRAW_FEE_MICRO = 117_000;

export type LiquidityStage =
  | "verifying" | "checking-wallet" | "pricing" | "building" | "checking"
  | "simulating" | "signing" | "submitting" | "confirming";

export type LiquidityResult = SubmitResult & {
  /** The assertion's own list, for the "what was checked" disclosure. */
  checks: string[];
  /** The contract's own figures, from the final simulation. */
  figures: Record<string, bigint>;
};

/** A gate stopped this before anything was built. Carries what to tell the user. */
export class GatedError extends Error {
  constructor(readonly gate: Gate) {
    super(gate.message);
    this.name = "GatedError";
  }
}

/**
 * Pin drift.
 *
 * Separate from `GatedError` because it is not about this user or this amount:
 * PEX's deployed code is not the code we verified, and the only honest response
 * is to stop offering deposits until someone looks.
 */
export class PinDriftError extends Error {
  constructor(readonly drifted: string[], message?: string) {
    super(
      message
      ?? "PEX's deployed contracts no longer match the versions this site verified, "
         + "so nothing was sent. Withdrawals remain available.",
    );
    this.name = "PinDriftError";
  }
}

async function assertPins(algod: algosdk.Algodv2, action: "deposit" | "withdraw") {
  const [pins, signer] = await Promise.all([
    verifyProgramPins(algod, "liquidity"),
    verifyOracleSignerPin(algod),
  ]);

  /**
   * The signer pin blocks BOTH directions, unlike program drift.
   *
   * A stale signer is not a risk judgement, it is an impossibility: every
   * payload we can verify locally is one the chain will reject at
   * `ed25519verify_bare`. Keeping exits "open" would mean offering a button
   * that fails after the wallet prompt, which is strictly worse than saying so.
   * PEX rotated the key on 2026-10-22 and a real user hit exactly that.
   */
  if (!signer.ok) {
    console.warn("liquidity: oracle signer pin drift", signer);
    throw new PinDriftError([], signerDriftMessage(signer));
  }

  if (pins.ok) return;
  console.warn("liquidity: program pin drift", pins.drifted);
  // Exits stay open on PROGRAM drift. See the module note.
  if (action === "deposit") throw new PinDriftError(pins.drifted);
}

export async function depositToMarket(input: {
  algod: algosdk.Algodv2;
  signTransactions: SignFn;
  sender: string;
  marketId: number;
  algoMicro: bigint;
  usdcMicro: bigint;
  /** For the $5 product minimum. Omit when no price is available. */
  depositUsd?: number;
  slippageBps?: number;
  onStage?: (s: LiquidityStage) => void;
}): Promise<LiquidityResult> {
  const { algod, sender, marketId, onStage = () => {} } = input;
  if (input.algoMicro <= BigInt(0) && input.usdcMicro <= BigInt(0)) {
    throw new Error("Enter an amount to deposit.");
  }

  onStage("verifying");
  await assertPins(algod, "deposit");

  onStage("checking-wallet");
  const [balances, state] = await Promise.all([
    readBalances(algod, sender),
    readMarketGateState(algod, marketId, sender),
  ]);
  /**
   * A first deposit creates the `ml2:` box and must pay its MBR exactly; a
   * later one must pay exactly zero. The contract asserts equality both ways,
   * so this is read from the box rather than defaulted.
   */
  const storagePaymentMicro = storagePaymentFor(state.shares > 0 || state.updatedAtSec > 0);

  const gates = marketGates({
    action: "deposit", state, balances,
    nowSec: Math.floor(Date.now() / 1000),
    algoLegMicro: Number(input.algoMicro),
    usdcLegMicro: Number(input.usdcMicro),
    groupFeeMicro: DEPOSIT_FEE_MICRO,
    depositUsd: input.depositUsd,
    // Counted toward the ALGO the wallet needs: it comes out of the same
    // spendable balance as the leg and the fees.
    storagePayMicro: Number(storagePaymentMicro),
  });
  const blocked = primaryGate(gates);
  if (blocked) throw new GatedError(blocked);

  const built = await buildDeposit({
    algod, sender, marketId,
    algoMicro: input.algoMicro,
    usdcMicro: input.usdcMicro,
    storagePaymentMicro,
    slippageBps: input.slippageBps ?? DEFAULT_LIQUIDITY_SLIPPAGE_BPS,
    stage: onStage as Stage,
  });

  return finish(input.algod, input.signTransactions, built, onStage);
}

export async function withdrawFromMarket(input: {
  algod: algosdk.Algodv2;
  signTransactions: SignFn;
  sender: string;
  marketId: number;
  /** Pool shares to burn, micro. */
  shareAmount: bigint;
  slippageBps?: number;
  onStage?: (s: LiquidityStage) => void;
}): Promise<LiquidityResult> {
  const { algod, sender, marketId, onStage = () => {} } = input;
  if (input.shareAmount <= BigInt(0)) throw new Error("Enter an amount to withdraw.");

  onStage("verifying");
  await assertPins(algod, "withdraw");

  onStage("checking-wallet");
  const [balances, state] = await Promise.all([
    readBalances(algod, sender),
    readMarketGateState(algod, marketId, sender),
  ]);
  if (input.shareAmount > BigInt(Math.round(state.shares * 1e6))) {
    throw new Error("That is more than this wallet holds in the pool.");
  }
  const gates = marketGates({
    action: "withdraw", state, balances,
    nowSec: Math.floor(Date.now() / 1000),
    algoLegMicro: 0, usdcLegMicro: 0,
    groupFeeMicro: WITHDRAW_FEE_MICRO,
    storagePayMicro: 0,
  });
  const blocked = primaryGate(gates);
  if (blocked) throw new GatedError(blocked);

  onStage("pricing");
  const ctx = await readQuoteContext(algod, marketId);
  // The caps come from the SDK quote, which is the only estimate available
  // before the group exists. They are MAXIMA on receipt tokens, so being ~1.6%
  // low in underlying terms is survivable — the floors, which must be exact,
  // come from the contract's own receipt inside `buildWithdraw`.
  const caps = recallCaps(quoteWithdraw(ctx, input.shareAmount));
  const rc = await readRecallContext(algod, ctx);

  const built = await buildWithdraw({
    algod, sender, marketId,
    shareAmount: input.shareAmount,
    maxLongReceipt: caps.long,
    maxShortReceipt: caps.short,
    registry: rc.registry,
    recall: rc.recall,
    slippageBps: input.slippageBps ?? DEFAULT_LIQUIDITY_SLIPPAGE_BPS,
    stage: onStage as Stage,
  });

  return finish(input.algod, input.signTransactions, built, onStage);
}

async function finish(
  algod: algosdk.Algodv2, signTransactions: SignFn, built: BuildResult,
  onStage: (s: LiquidityStage) => void,
): Promise<LiquidityResult> {
  const r = await signAndSubmit({
    algod, signTransactions, txns: built.txns,
    onStage: (s) => onStage(s),
  });
  return { ...r, checks: built.assertion.checked, figures: built.receipt.fields };
}
