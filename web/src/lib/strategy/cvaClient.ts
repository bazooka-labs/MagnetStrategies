/**
 * The one entry point the UI calls to deposit into or withdraw from the C-Vault.
 *
 * Same order as the pools, for the same reasons (`client.ts`):
 *
 *   1. verify the deployed programs still hash to what we pinned
 *   2. read the gates — pauses, cool-down, caps, balances, floors
 *   3. snapshot, build, assert, simulate   (`cvaGroup`)
 *   4. sign and submit                     (`submit`)
 *
 * ── One difference that matters: when the snapshot is read ──
 * The snapshot carries oracle payloads that live 20 seconds, and the vault
 * prices itself within a single block. So the snapshot is read in step 3, at the
 * moment the action is taken — never when the form opens. The gates in step 2
 * use cheap, long-lived reads instead. A snapshot taken while a user reads the
 * screen is expired by the time they sign.
 */

import algosdk from "algosdk";
import { verifyProgramPins, verifyOracleSignerPin, signerDriftMessage } from "../perpsReads";
import { readCvaSnapshot, readCvaUserShares } from "./cvaSnapshot";
import {
  buildCvaDeposit, buildCvaWithdraw, cvaStoragePaymentFor, CvaRouteError,
  CVA_USER_BOX_MBR_MICRO_ALGO, type CvaRoute,
} from "./cvaGroup";
import {
  readBalances, readCvaVaultState, balanceGates, cvaPauseGate, cvaCooldownGate,
  cvaDepositGate, cvaDepositNotice, perCallCapGate, primaryGate,
  type Gate, type Notice, type CvaVaultState,
} from "./preflight";
import { DEFAULT_LIQUIDITY_SLIPPAGE_BPS } from "./quote";
import { signAndSubmit, type SignFn, type SubmitResult } from "./submit";
import { GatedError, PinDriftError, type LiquidityStage } from "./client";

/** Measured: deposit 74,000 µALGO, withdrawal 178,000. */
const CVA_DEPOSIT_FEE_MICRO = 74_000;
const CVA_WITHDRAW_FEE_MICRO = 178_000;

export type CvaResult = SubmitResult & {
  checks: string[];
  figures: Record<string, bigint>;
  route?: CvaRoute;
};

/**
 * Everything the form needs to decide what to OFFER, from cheap reads.
 *
 * Deliberately excludes the snapshot: see the module note.
 */
export type CvaFormState = {
  vault: CvaVaultState;
  /** Null when this wallet has never deposited. */
  held: { shares: number; lastDepositRound: number } | null;
  currentRound: number;
  algoSpendableMicro: number;
  usdcMicro: number;
  usdcOptedIn: boolean;
  /** NAV per vault share, for the dollars-to-shares conversion. */
  navPerShare: number;
};

export async function readCvaFormState(
  algod: algosdk.Algodv2, address: string | null,
): Promise<CvaFormState> {
  const [vault, status, app] = await Promise.all([
    readCvaVaultState(algod),
    algod.status().do(),
    algod.getApplicationByID(3690309167).do(),
  ]);
  let nav = 0, shares = 0;
  for (const kv of app.params.globalState ?? []) {
    const k = Buffer.from(kv.key as unknown as Uint8Array).toString("utf8");
    if (k === "total_nav_usd") nav = Number(kv.value?.uint ?? 0);
    if (k === "total_cva_shares") shares = Number(kv.value?.uint ?? 0);
  }
  const [held, bal] = address
    ? await Promise.all([readCvaUserShares(algod, address), readBalances(algod, address)])
    : [null, { algoSpendableMicro: 0, usdcMicro: 0, usdcOptedIn: false }];
  return {
    vault, held,
    currentRound: Number(status.lastRound),
    algoSpendableMicro: bal.algoSpendableMicro,
    usdcMicro: bal.usdcMicro,
    usdcOptedIn: bal.usdcOptedIn,
    navPerShare: shares > 0 ? nav / shares : 0,
  };
}

/** Dollars the user typed -> vault shares, at the live NAV. */
export const usdToShares = (usd: number, navPerShare: number): bigint =>
  navPerShare > 0 ? BigInt(Math.floor(usd / navPerShare * 1e6)) : BigInt(0);

export const sharesToUsd = (shareMicro: bigint, navPerShare: number): number =>
  Number(shareMicro) / 1e6 * navPerShare;

/** Gates on a C-Vault deposit, decided before anything is built. */
export function cvaDepositGates(s: CvaFormState, input: {
  algoLegMicro: number; usdcLegMicro: number; depositUsd: number;
}): { gates: Gate[]; notice: Notice | null } {
  const gates: Gate[] = [];
  const paused = cvaPauseGate(s.vault, "deposit");
  if (paused) gates.push(paused);

  if (input.depositUsd > 0) {
    const min = cvaDepositGate({
      depositUsd: input.depositUsd,
      minWithdrawUsd: s.vault.minWithdrawUsd,
      mintSpreadBps: s.vault.mintSpreadBps,
      burnSpreadBps: s.vault.burnSpreadBps,
    });
    if (min) gates.push(min);
    const cap = perCallCapGate(input.depositUsd, s.vault.maxDepositUsdPerCall, "deposit");
    if (cap) gates.push(cap);
  }

  const storage = Number(cvaStoragePaymentFor(s.held !== null));
  gates.push(...balanceGates({
    balances: {
      algoSpendableMicro: s.algoSpendableMicro,
      usdcMicro: s.usdcMicro,
      usdcOptedIn: s.usdcOptedIn,
    },
    algoLegMicro: input.algoLegMicro,
    usdcLegMicro: input.usdcLegMicro,
    groupFeeMicro: CVA_DEPOSIT_FEE_MICRO,
    storagePayMicro: storage,
    needsUsdcOptIn: false,
  }));

  // Not a gate: a $5.00 deposit is allowed, with its exit timing stated.
  const notice = input.depositUsd > 0
    ? cvaDepositNotice({
        depositUsd: input.depositUsd,
        minWithdrawUsd: s.vault.minWithdrawUsd,
        mintSpreadBps: s.vault.mintSpreadBps,
        burnSpreadBps: s.vault.burnSpreadBps,
      })
    : null;
  return { gates, notice };
}

/** Gates on a C-Vault withdrawal. */
export function cvaWithdrawGates(s: CvaFormState, withdrawUsd: number): Gate[] {
  const gates: Gate[] = [];
  const paused = cvaPauseGate(s.vault, "withdraw");
  if (paused) gates.push(paused);

  if (!s.held || s.held.shares <= 0) {
    gates.push({ code: "nothing_to_withdraw", message: "No position in this vault yet." });
    return gates;
  }
  const cd = cvaCooldownGate(s.held.lastDepositRound, s.currentRound, s.vault.cooldownRounds);
  if (cd) gates.push(cd);

  if (withdrawUsd > 0 && withdrawUsd < s.vault.minWithdrawUsd) {
    gates.push({
      code: "below_minimum",
      message:
        `This vault's minimum withdrawal is $${s.vault.minWithdrawUsd.toFixed(2)}. `
        + `Take out at least that much, or all of it.`,
    });
  }
  const cap = perCallCapGate(withdrawUsd, s.vault.maxWithdrawUsdPerCall, "withdraw");
  if (cap) gates.push(cap);

  if (!s.usdcOptedIn) {
    gates.push({
      code: "no_usdc_optin",
      message: "Opt this wallet in to USDC first, so the USDC side has somewhere to land.",
    });
  }
  gates.push(...balanceGates({
    balances: {
      algoSpendableMicro: s.algoSpendableMicro, usdcMicro: s.usdcMicro, usdcOptedIn: s.usdcOptedIn,
    },
    algoLegMicro: 0, usdcLegMicro: 0,
    groupFeeMicro: CVA_WITHDRAW_FEE_MICRO,
    storagePayMicro: 0,
    needsUsdcOptIn: false,
  }));
  return gates;
}

async function assertPins(algod: algosdk.Algodv2, action: "deposit" | "withdraw") {
  const [pins, signer] = await Promise.all([
    verifyProgramPins(algod, "liquidity"),
    verifyOracleSignerPin(algod),
  ]);
  // A stale signer blocks both directions: every payload we could verify is one
  // the chain will reject. See the note in `client.ts`.
  if (!signer.ok) {
    console.warn("cva: oracle signer pin drift", signer);
    throw new PinDriftError([], signerDriftMessage(signer));
  }
  if (pins.ok) return;
  console.warn("cva: program pin drift", pins.drifted);
  // Exits stay open on PROGRAM drift; entries do not. Same rule as the pools.
  if (action === "deposit") throw new PinDriftError(pins.drifted);
}

export async function depositToCvaVault(input: {
  algod: algosdk.Algodv2;
  signTransactions: SignFn;
  sender: string;
  algoMicro: bigint;
  usdcMicro: bigint;
  depositUsd: number;
  slippageBps?: number;
  onStage?: (s: LiquidityStage) => void;
}): Promise<CvaResult> {
  const { algod, sender, onStage = () => {} } = input;
  if (input.algoMicro <= BigInt(0) && input.usdcMicro <= BigInt(0)) {
    throw new Error("Enter an amount to deposit.");
  }

  onStage("verifying");
  await assertPins(algod, "deposit");

  onStage("checking-wallet");
  const form = await readCvaFormState(algod, sender);
  const { gates } = cvaDepositGates(form, {
    algoLegMicro: Number(input.algoMicro),
    usdcLegMicro: Number(input.usdcMicro),
    depositUsd: input.depositUsd,
  });
  const blocked = primaryGate(gates);
  if (blocked) throw new GatedError(blocked);

  // Read LAST: the oracle payloads inside live 20 seconds.
  const snapshot = await readCvaSnapshot(algod);

  const built = await buildCvaDeposit({
    algod, sender, snapshot,
    algoMicro: input.algoMicro,
    usdcMicro: input.usdcMicro,
    storagePaymentMicro: cvaStoragePaymentFor(form.held !== null),
    slippageBps: input.slippageBps ?? DEFAULT_LIQUIDITY_SLIPPAGE_BPS,
    stage: onStage as (x: string) => void,
  });

  const r = await signAndSubmit({
    algod, signTransactions: input.signTransactions, txns: built.txns,
    onStage: (s) => onStage(s),
  });
  return { ...r, checks: built.assertion.checked, figures: built.receipt.fields };
}

export async function withdrawFromCvaVault(input: {
  algod: algosdk.Algodv2;
  signTransactions: SignFn;
  sender: string;
  /** Vault shares to burn, micro. The UI converts from dollars. */
  shareAmount: bigint;
  /** The dollar figure shown, for the gates. */
  withdrawUsd: number;
  slippageBps?: number;
  onStage?: (s: LiquidityStage) => void;
}): Promise<CvaResult> {
  const { algod, sender, onStage = () => {} } = input;
  if (input.shareAmount <= BigInt(0)) throw new Error("Enter an amount to withdraw.");

  onStage("verifying");
  await assertPins(algod, "withdraw");

  onStage("checking-wallet");
  const form = await readCvaFormState(algod, sender);
  if (form.held && input.shareAmount > BigInt(Math.round(form.held.shares * 1e6))) {
    throw new Error("That is more than this wallet holds in the vault.");
  }
  const blocked = primaryGate(cvaWithdrawGates(form, input.withdrawUsd));
  if (blocked) throw new GatedError(blocked);

  const snapshot = await readCvaSnapshot(algod);

  /**
   * Recall caps, generous on purpose.
   *
   * These cap RECEIPT tokens while the payout is in the underlying, and the
   * measured exit pulled 22.11 ALGO + 7.54 USDC for $10 of shares. A cap is a
   * maximum, so erring high is safe in the only direction it can be — and the
   * assertion pins whatever value is used into the signed bytes. The exact
   * payout floors come from the contract's own receipt, not from these.
   */
  const headroom = BigInt(Math.ceil(Math.max(input.withdrawUsd * 20, 100) * 1e6));

  try {
    const built = await buildCvaWithdraw({
      algod, sender, snapshot,
      shareAmount: input.shareAmount,
      maxLongReceipt: headroom,
      maxShortReceipt: headroom,
      slippageBps: input.slippageBps ?? DEFAULT_LIQUIDITY_SLIPPAGE_BPS,
      stage: onStage as (x: string) => void,
    });
    const r = await signAndSubmit({
      algod, signTransactions: input.signTransactions, txns: built.txns,
      onStage: (s) => onStage(s),
    });
    return {
      ...r, checks: built.assertion.checked, figures: built.receipt.fields, route: built.route,
    };
  } catch (e) {
    // A routing refusal is a gate, not a crash: it means no single market can
    // serve this amount right now, which the user can act on by taking less.
    if (e instanceof CvaRouteError) {
      throw new GatedError({ code: "nothing_to_withdraw", message: e.message });
    }
    throw e;
  }
}

export { CVA_USER_BOX_MBR_MICRO_ALGO };
