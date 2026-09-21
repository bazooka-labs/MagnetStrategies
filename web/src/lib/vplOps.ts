// VPL — browser transaction builders, signed by the connected admin wallet.
//
// Mirrors predict/keeper/deploy.py and run.py, which were rehearsed end-to-end on
// LocalNet. Building here means the admin mnemonic never has to exist in a file or on
// the keeper host — admin is the key that can repoint oracle_pubkey, so keeping it in
// a wallet is the single biggest custody improvement available.
//
// algokit-utils handles ABI encoding. The two SEND_OPTS flags matter more than they
// look: coverAppCallInnerTransactionFees pays for the opup that lock/resolve need
// (ed25519verify_bare costs 1900 opcodes against a 700 budget), and
// populateAppCallResources distributes box and account references across a batch —
// the two things that had to be hand-tuned in the Python tooling.

import algosdk, { type TransactionSigner } from "algosdk";
import { AlgorandClient, microAlgo } from "@algorandfoundation/algokit-utils";
import {
  BOX_MBR, DEFAULT_BAND_BOUNDS, DEFAULT_MIN_STAKE, DEFAULT_RAKE_BPS,
  MUSD_ASA_ID_MAINNET, PAYOUT_FEE, PRICE_FEED_ID,
} from "./vpl";

const SPEC_URL = "/contracts/VPL.arc56.json";
const MAX_FEE = microAlgo(50_000);
const SEND_OPTS = { coverAppCallInnerTransactionFees: true, populateAppCallResources: true };

// base 100k + 2 extra pages 200k + 15 uints x 28.5k + 6 byte slices x 50k + opt-in 100k
export const APP_MIN_BALANCE = 1_127_500;
export const APP_FUND_AMOUNT = 10_000_000; // min balance + two live round boxes + float

let specCache: string | undefined;
async function loadSpec(): Promise<string> {
  if (!specCache) {
    const res = await fetch(SPEC_URL);
    if (!res.ok) throw new Error("Failed to load VPL contract spec");
    specCache = await res.text();
  }
  return specCache;
}

export function makeAlgorand(algod: algosdk.Algodv2, signer: TransactionSigner): AlgorandClient {
  const algorand = AlgorandClient.fromClients({ algod });
  algorand.setDefaultSigner(signer);
  return algorand;
}

async function client(algorand: AlgorandClient, appId: bigint, sender: string) {
  return algorand.client.getAppClientById({ appSpec: await loadSpec(), appId, defaultSender: sender });
}

// ── deploy ──────────────────────────────────────────────────────────────────

/** Step 1. Two extra program pages — the approval program is ~6.1 KB. */
export async function createApp(algorand: AlgorandClient, sender: string, musdAsaId: bigint) {
  const factory = algorand.client.getAppFactory({
    appSpec: await loadSpec(),
    defaultSender: sender,
    // MUSD_ASSET_ID is substituted at DEPLOY time and baked permanently into the
    // deployed program. bootstrap is one-shot and irreversible on a contract that can
    // never be upgraded or deleted, so the asset must not be trusted from an argument.
    deployTimeParams: { MUSD_ASSET_ID: musdAsaId },
  });
  const { result, appClient } = await factory.send.create({
    method: "create_application",
    args: [],
    extraProgramPages: 2,
  });
  return { appId: appClient.appId, appAddress: appClient.appAddress.toString(), txId: result.txIds[0] };
}

/** Step 2. Must precede bootstrap — its inner opt-in fails on an underfunded account. */
export async function fundApp(algorand: AlgorandClient, sender: string, appAddress: string) {
  return algorand.send.payment({
    sender,
    receiver: appAddress,
    amount: microAlgo(APP_FUND_AMOUNT),
  });
}

/**
 * Step 3. ONE-SHOT AND IRREVERSIBLE.
 *
 * Asserts the asset's decimals, unit name, total, and — the two that actually carry
 * the MagnetFi isolation — that clawback and freeze are the zero address. Decimals and
 * a unit name are forgeable by any third party's ASA; those two are not.
 */
export async function bootstrap(
  algorand: AlgorandClient, sender: string, appId: bigint,
  opts: {
    musdAsaId: bigint; treasury: string; oraclePubkey: Uint8Array; keeper: string;
    rakeBps?: number; minStake?: number; bandBounds?: number[];
  },
) {
  const app = await client(algorand, appId, sender);
  return app.send.call({
    method: "bootstrap",
    args: [
      opts.musdAsaId, PRICE_FEED_ID, opts.treasury, opts.oraclePubkey, opts.keeper,
      opts.rakeBps ?? DEFAULT_RAKE_BPS,
      opts.minStake ?? DEFAULT_MIN_STAKE,
      opts.bandBounds ?? DEFAULT_BAND_BOUNDS,
    ],
    assetReferences: [opts.musdAsaId],
    maxFee: MAX_FEE,
    ...SEND_OPTS,
  });
}

// ── rounds ──────────────────────────────────────────────────────────────────

/**
 * Checkpoints must be minute-aligned — the contract asserts it, because an
 * attestation's candle boundary is compared for EQUALITY against them. A misaligned
 * checkpoint makes the round unresolvable by any attestation the keeper can ever sign.
 */
export async function createRound(
  algorand: AlgorandClient, sender: string, appId: bigint,
  openTime: number, lockTime: number, resolveTime: number,
) {
  if (lockTime % 60 || resolveTime % 60) throw new Error("checkpoints must be minute-aligned");
  const app = await client(algorand, appId, sender);
  return app.send.call({
    method: "create_round",
    args: [openTime, lockTime, resolveTime],
    maxFee: MAX_FEE,
    ...SEND_OPTS,
  });
}

/** Relay a published attestation. Permissionless — verifies a signature, not a sender. */
export async function submitCheckpoint(
  algorand: AlgorandClient, sender: string, appId: bigint,
  kind: "lock" | "resolve",
  att: { roundId: number; presentMask: number; prices: bigint[]; timestamps: number[]; signature: Uint8Array },
) {
  const app = await client(algorand, appId, sender);
  return app.send.call({
    method: kind,
    args: [att.roundId, att.presentMask, att.prices, att.timestamps, att.signature],
    maxFee: MAX_FEE, // opup for ed25519verify_bare comes out of this
    ...SEND_OPTS,
  });
}

/** Permissionless. OPEN after the keeper's lock window, LOCKED after the resolve deadline. */
export async function voidRound(algorand: AlgorandClient, sender: string, appId: bigint, roundId: number) {
  const app = await client(algorand, appId, sender);
  return app.send.call({ method: "void_round", args: [roundId], maxFee: MAX_FEE, ...SEND_OPTS });
}

/** Admin recovery lever. OPEN only, full refunds, no rake — nobody is expropriated. */
export async function adminVoidRound(algorand: AlgorandClient, sender: string, appId: bigint, roundId: number) {
  const app = await client(algorand, appId, sender);
  return app.send.call({ method: "admin_void_round", args: [roundId], maxFee: MAX_FEE, ...SEND_OPTS });
}

export async function cleanupRound(algorand: AlgorandClient, sender: string, appId: bigint, roundId: number) {
  const app = await client(algorand, appId, sender);
  return app.send.call({ method: "cleanup_round", args: [roundId], maxFee: MAX_FEE, ...SEND_OPTS });
}

// ── settlement ──────────────────────────────────────────────────────────────

/**
 * expectedPayee is load-bearing, not redundant. settle/refund must read the payee's
 * mUSD holding, and an asset-holding read against an account absent from the resource
 * array is a HARD program failure no skip logic can catch. Without it, an owner
 * redirects their recipient moments before the batch and the whole group reverts.
 */
export async function settleOne(
  algorand: AlgorandClient, sender: string, appId: bigint,
  roundId: number, owner: string, band: number, payee: string,
  kind: "settle" | "close" | "refund", musdAsaId: bigint,
) {
  const app = await client(algorand, appId, sender);
  const method = kind === "settle" ? "settle_position" : kind === "close" ? "close_position" : "refund_position";
  return app.send.call({
    method,
    args: [roundId, owner, band, payee],
    accountReferences: [owner, payee],
    assetReferences: [musdAsaId],
    maxFee: MAX_FEE,
    ...SEND_OPTS,
  });
}

// ── parameters ──────────────────────────────────────────────────────────────

/** Read live, never snapshotted — so it is a real emergency stop on a round already
 *  underway. Every exit path ignores it, so funds are never trapped by pausing. */
export async function setPaused(algorand: AlgorandClient, sender: string, appId: bigint, paused: boolean) {
  const app = await client(algorand, appId, sender);
  return app.send.call({ method: "set_paused", args: [paused ? 1 : 0], maxFee: MAX_FEE, ...SEND_OPTS });
}

export async function setParam(
  algorand: AlgorandClient, sender: string, appId: bigint,
  method: "set_default_rake_bps" | "set_min_stake" | "set_box_mbr" | "set_payout_fee",
  value: number,
) {
  const app = await client(algorand, appId, sender);
  return app.send.call({ method, args: [value], maxFee: MAX_FEE, ...SEND_OPTS });
}

export async function setBandBounds(algorand: AlgorandClient, sender: string, appId: bigint, bounds: number[]) {
  const app = await client(algorand, appId, sender);
  return app.send.call({ method: "set_band_bounds", args: [bounds], maxFee: MAX_FEE, ...SEND_OPTS });
}

export async function setAddress(
  algorand: AlgorandClient, sender: string, appId: bigint,
  method: "set_keeper" | "set_treasury" | "propose_admin",
  address: string,
) {
  const app = await client(algorand, appId, sender);
  return app.send.call({ method, args: [address], maxFee: MAX_FEE, ...SEND_OPTS });
}

export async function setOraclePubkey(algorand: AlgorandClient, sender: string, appId: bigint, pubkey: Uint8Array) {
  const app = await client(algorand, appId, sender);
  return app.send.call({ method: "set_oracle_pubkey", args: [pubkey], maxFee: MAX_FEE, ...SEND_OPTS });
}

// ── treasury ────────────────────────────────────────────────────────────────

/** Permissionless. Separate from resolve so settlement can never depend on treasury state. */
export async function sweepRake(algorand: AlgorandClient, sender: string, appId: bigint, musdAsaId: bigint, treasury: string) {
  const app = await client(algorand, appId, sender);
  return app.send.call({
    method: "sweep_rake", args: [],
    assetReferences: [musdAsaId], accountReferences: [treasury],
    maxFee: MAX_FEE, ...SEND_OPTS,
  });
}

/** Recovers mUSD that reached the app outside an entry group. Bounded by
 *  total_obligations, so it can never touch live escrow. */
export async function sweepExcessMusd(
  algorand: AlgorandClient, sender: string, appId: bigint,
  amount: bigint, musdAsaId: bigint, treasury: string,
) {
  const app = await client(algorand, appId, sender);
  return app.send.call({
    method: "sweep_excess_musd", args: [amount],
    assetReferences: [musdAsaId], accountReferences: [treasury],
    maxFee: MAX_FEE, ...SEND_OPTS,
  });
}

export async function withdrawOperatingAlgo(algorand: AlgorandClient, sender: string, appId: bigint, amount: bigint) {
  const app = await client(algorand, appId, sender);
  return app.send.call({ method: "withdraw_operating_algo", args: [amount], maxFee: MAX_FEE, ...SEND_OPTS });
}

// ── reads ───────────────────────────────────────────────────────────────────

export type RoundView = {
  openTime: number; lockTime: number; resolveTime: number;
  referencePrice: bigint; settlementPrice: bigint;
  refSources: bigint[]; settleSources: bigint[];
  bandStake: bigint[]; totalStake: bigint;
  rakeBps: number; minStake: bigint; payablePot: bigint; remainingPayable: bigint;
  positionCount: number; finalizedAt: number;
  winningBand: number; status: number; voidReason: number;
};

export async function readRound(algorand: AlgorandClient, appId: bigint, sender: string, roundId: number): Promise<RoundView> {
  const app = await client(algorand, appId, sender);
  const r = await app.send.call({ method: "get_round", args: [roundId], ...SEND_OPTS });
  const v = r.return as unknown as Record<string, unknown>;
  return {
    openTime: Number(v.open_time), lockTime: Number(v.lock_time), resolveTime: Number(v.resolve_time),
    referencePrice: BigInt(String(v.reference_price)), settlementPrice: BigInt(String(v.settlement_price)),
    refSources: (v.ref_sources as unknown[]).map((x) => BigInt(String(x))),
    settleSources: (v.settle_sources as unknown[]).map((x) => BigInt(String(x))),
    bandStake: (v.band_stake as unknown[]).map((x) => BigInt(String(x))),
    totalStake: BigInt(String(v.total_stake)), rakeBps: Number(v.rake_bps),
    minStake: BigInt(String(v.min_stake)), payablePot: BigInt(String(v.payable_pot)),
    remainingPayable: BigInt(String(v.remaining_payable)),
    positionCount: Number(v.position_count), finalizedAt: Number(v.finalized_at),
    winningBand: Number(v.winning_band), status: Number(v.status), voidReason: Number(v.void_reason),
  };
}

/** (mUSD balance, total_obligations, rake_owed) — invariant 1, checkable by anyone. */
export async function readSolvency(algorand: AlgorandClient, appId: bigint, sender: string) {
  const app = await client(algorand, appId, sender);
  const r = await app.send.call({ method: "get_solvency", args: [], ...SEND_OPTS });
  const [balance, obligations, rakeOwed] = (r.return as unknown as unknown[]).map((x) => BigInt(String(x)));
  return { balance, obligations, rakeOwed, solvent: balance >= obligations + rakeOwed };
}

export async function readGlobals(algorand: AlgorandClient, appId: bigint, sender: string) {
  const app = await client(algorand, appId, sender);
  const g = await app.getGlobalState();
  const n = (k: string) => Number((g[k] as { value?: bigint | number })?.value ?? 0);
  return {
    roundCount: n("rcount"), openRoundId: n("open_rid"), paused: n("paused") === 1,
    rakeBps: n("rake"), minStake: n("min_stake"), rakeOwed: n("rake_owed"),
    totalObligations: n("oblig"), feeReserve: n("fee_res"), mbrReserve: n("mbr_res"),
    lastSettlementPrice: n("last_px"), musdAssetId: n("musd"),
  };
}

export { MUSD_ASA_ID_MAINNET, BOX_MBR, PAYOUT_FEE };
