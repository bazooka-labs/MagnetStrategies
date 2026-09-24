// Perps — the single audited group module.
//
// Every transaction group presented for signature passes through here. Nothing
// else in the app may hand a group to a wallet.
//
// ── What this is, and what it is not ─────────────────────────────────────────
// This is defence-in-depth against construction BUGS and against compromise
// confined to the group-building path. It is NOT a defence against full frontend
// compromise: an attacker who owns the bundle owns this file, the comparison, and
// the confirm screen it compares against. The controls that raise that bar are
// reproducible builds, SRI, a pinned bundle, and wallet-side ARC-aware rendering.
// Saying otherwise would be the most dangerous comment in the codebase.
//
// ── Why asset movements are not enough ───────────────────────────────────────
// `open_or_increase` takes NO collateral argument. Leverage is
// sizeUsdDelta / transfer amount, and sizeUsdDelta is a free frontend integer. So
// a screen reading "5x" can send 20x while the transfer stays exactly $50 of the
// right asset to the right address, and every asset-movement check passes. The
// ABI arguments have to be checked against what was displayed, not merely against
// a permitted range.
//
// ── Selectors and layout are PINNED ──────────────────────────────────────────
// Not read from the manifest. The manifest supplies the encoder; checking the
// encoder's output against the same manifest proves only self-consistency. These
// were captured from a real MainNet group built by the pinned SDK.

import algosdk from "algosdk";
import {
  BUILDER_ADDRESS,
  PEX_APPS,
  POSITION_BUILDER_FEE_BPS,
} from "./perps";

// ── Pinned method selectors ───────────────────────────────────────────────────
export const PEX_SELECTORS = {
  /** PDexV2Trading.open_or_increase — 7 args after the selector. */
  openOrIncrease: "316981bf",
  /** PDexV2Math.noop — the resource/budget carrier. Zero args. */
  mathNoop: "e83a87ab",
} as const;

/** Every app ID a Perps group is allowed to call. */
const ALLOWED_APP_IDS: ReadonlySet<number> = new Set<number>(Object.values(PEX_APPS));

/**
 * Ceiling on total group fee, microALGO. A real open measures 33,000; the cap is
 * loose enough for extra resource carriers as pool state varies and tight enough
 * that a fee-drain is refused.
 */
export const MAX_GROUP_FEE_MICRO_ALGO = 250_000;

export type GroupFinding = { code: string; detail: string };
export type GroupAssertion = { ok: boolean; findings: GroupFinding[]; checked: string[] };

type AnyTxn = {
  type: string;
  sender: unknown;
  fee?: bigint | number;
  rekeyTo?: unknown;
  assetTransfer?: {
    assetIndex: bigint | number;
    amount: bigint | number;
    receiver: unknown;
    closeRemainderTo?: unknown;
    assetSender?: unknown;
  };
  payment?: { amount: bigint | number; receiver: unknown; closeRemainderTo?: unknown };
  applicationCall?: {
    appIndex: bigint | number;
    appArgs: Uint8Array[];
    accounts?: unknown[];
    foreignApps?: (bigint | number)[];
    foreignAssets?: (bigint | number)[];
    boxes?: unknown[];
  };
  txID: () => string;
};

/** What the confirm screen showed. Every field is compared, not sanity-checked. */
export type DisplayedOpen = {
  sender: string;
  marketId: number;
  /** 1 long, 2 short. */
  side: 1 | 2;
  collateralAssetId: number;
  /** Exactly what the user agreed to transfer, in micro-units. */
  collateralAmountMicro: bigint;
  /** Exactly the notional shown, in 1e6 USD. */
  sizeUsdDeltaMicro: bigint;
  acceptablePrice12: bigint;
  /** Index price the card displayed, Price12. */
  indexPrice12: bigint;
  slippageBps: number;
  /** The exact verified payload bytes — not a re-fetch. */
  oracleMessage: Uint8Array;
  oracleSignature: Uint8Array;
};

const big = (v: bigint | number | undefined): bigint => BigInt(v ?? 0);
const hex = (b: Uint8Array): string =>
  Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * ABI dynamic `byte[]` carries a 2-byte big-endian length prefix. Strip it and
 * verify the prefix agrees with the remaining length — a disagreeing prefix means
 * the arg is not what it claims.
 */
function abiBytes(arg: Uint8Array): Uint8Array | null {
  if (arg.length < 2) return null;
  const declared = (arg[0] << 8) | arg[1];
  const body = arg.slice(2);
  return declared === body.length ? body : null;
}

/**
 * Assert a complete open group against what was displayed.
 *
 * Returns every finding rather than throwing on the first, so a failure report
 * shows the whole picture instead of one symptom at a time.
 */
export function assertOpenGroup(txnsIn: unknown[], shown: DisplayedOpen): GroupAssertion {
  const txns = txnsIn.map((t) => ((t as { txn?: AnyTxn }).txn ?? t) as AnyTxn);
  const findings: GroupFinding[] = [];
  const checked: string[] = [];
  const fail = (code: string, detail: string) => findings.push({ code, detail });
  const did = (name: string) => checked.push(name);

  if (txns.length === 0) {
    fail("empty_group", "no transactions");
    return { ok: false, findings, checked };
  }

  // ── Group-wide ──────────────────────────────────────────────────────────────

  // Catches a live upstream bug: two byte-identical Math noop carriers survive
  // `regroup`, which re-assigns group IDs without the de-duplication `grouped()`
  // applies. Builds fine, rejected at submission.
  const ids = new Set(txns.map((t) => t.txID()));
  if (ids.size !== txns.length) {
    fail("duplicate_txids", `${txns.length} transactions but ${ids.size} distinct IDs`);
  }
  did("distinct transaction IDs");

  let totalFee = BigInt(0);
  txns.forEach((t, i) => {
    totalFee += big(t.fee);
    if (String(t.sender) !== shown.sender) {
      fail("foreign_sender", `txn ${i} sender is not the user`);
    }
    // Any of these three silently reassign the account or sweep a balance.
    if (t.rekeyTo) fail("rekey", `txn ${i} sets rekeyTo`);
    if (t.assetTransfer?.closeRemainderTo) fail("asset_close_to", `txn ${i} sets assetCloseTo`);
    if (t.payment?.closeRemainderTo) fail("close_remainder_to", `txn ${i} sets closeRemainderTo`);
    if (t.assetTransfer?.assetSender) fail("clawback", `txn ${i} sets assetSender (clawback)`);
    if (t.applicationCall) {
      const app = Number(t.applicationCall.appIndex);
      if (!ALLOWED_APP_IDS.has(app)) {
        fail("unpinned_app", `txn ${i} calls app ${app}, which is not a pinned PEX app`);
      }
    }
  });
  did("sender is the user on every transaction");
  did("no rekeyTo / assetCloseTo / closeRemainderTo / clawback");
  did("every app call targets a pinned PEX app");

  if (totalFee > BigInt(MAX_GROUP_FEE_MICRO_ALGO)) {
    fail("fee_cap", `total fee ${totalFee} exceeds ${MAX_GROUP_FEE_MICRO_ALGO} microALGO`);
  }
  did("total fee under cap");

  // ── Asset movement ──────────────────────────────────────────────────────────
  const transfers = txns.filter((t) => t.assetTransfer);
  if (transfers.length !== 1) {
    fail("transfer_count", `expected exactly 1 asset transfer, found ${transfers.length}`);
  }
  const tradingAddr = algosdk.getApplicationAddress(PEX_APPS.trading).toString();
  const xfer = transfers[0]?.assetTransfer;
  if (xfer) {
    if (Number(xfer.assetIndex) !== shown.collateralAssetId) {
      fail("transfer_asset", `transfer asset ${xfer.assetIndex}, displayed ${shown.collateralAssetId}`);
    }
    if (big(xfer.amount) !== shown.collateralAmountMicro) {
      fail("transfer_amount", `transfer ${xfer.amount}, displayed ${shown.collateralAmountMicro}`);
    }
    // Against the PINNED trading app address, never one derived from a manifest.
    if (String(xfer.receiver) !== tradingAddr) {
      fail("transfer_receiver", `transfer receiver is not the pinned Trading app address`);
    }
  }
  did("collateral transfer: asset, amount, receiver");

  // ── open_or_increase ────────────────────────────────────────────────────────
  const mainCalls = txns.filter(
    (t) => t.applicationCall && Number(t.applicationCall.appIndex) === PEX_APPS.trading,
  );
  if (mainCalls.length !== 1) {
    fail("main_call_count", `expected exactly 1 Trading app call, found ${mainCalls.length}`);
    return { ok: findings.length === 0, findings, checked };
  }
  const ac = mainCalls[0].applicationCall!;
  const args = ac.appArgs ?? [];

  if (hex(args[0] ?? new Uint8Array()) !== PEX_SELECTORS.openOrIncrease) {
    fail("selector", `selector ${hex(args[0] ?? new Uint8Array())}, expected ${PEX_SELECTORS.openOrIncrease}`);
  }
  if (args.length !== 8) {
    fail("arg_count", `${args.length - 1} args after selector, expected 7`);
    return { ok: false, findings, checked };
  }
  did("open_or_increase selector and arity");

  const u64 = (a: Uint8Array) => algosdk.decodeUint64(a, "bigint");
  const [, aMarket, aSide, aSize, aPrice, aBuilder, aMsg, aSig] = args;

  if (u64(aMarket) !== BigInt(shown.marketId)) fail("market_id", `arg ${u64(aMarket)}, displayed ${shown.marketId}`);
  if (u64(aSide) !== BigInt(shown.side)) fail("side", `arg ${u64(aSide)}, displayed ${shown.side}`);
  if (u64(aSize) !== shown.sizeUsdDeltaMicro) {
    fail("size_usd_delta", `arg ${u64(aSize)}, displayed ${shown.sizeUsdDeltaMicro}`);
  }
  if (u64(aPrice) !== shown.acceptablePrice12) {
    fail("acceptable_price", `arg ${u64(aPrice)}, displayed ${shown.acceptablePrice12}`);
  }
  did("marketId, side, sizeUsdDelta, acceptablePrice");

  // Leverage is the whole point: size is a free integer and the transfer is not.
  if (xfer && shown.collateralAmountMicro > BigInt(0)) {
    const argLev = Number(u64(aSize)) / Number(big(xfer.amount));
    const shownLev = Number(shown.sizeUsdDeltaMicro) / Number(shown.collateralAmountMicro);
    if (Math.abs(argLev - shownLev) > 1e-9) {
      fail("leverage", `group encodes ${argLev.toFixed(6)}x, screen showed ${shownLev.toFixed(6)}x`);
    }
  }
  did("encoded leverage equals displayed leverage");

  // Builder tuple: 32-byte address then uint64 bps. Equality, not a bound —
  // the SDK already throws above the cap, so `<= 10` catches nothing.
  if (aBuilder.length !== 40) {
    fail("builder_tuple", `builder tuple is ${aBuilder.length} bytes, expected 40`);
  } else {
    const addr = algosdk.encodeAddress(aBuilder.slice(0, 32));
    const bps = u64(aBuilder.slice(32, 40));
    if (addr !== BUILDER_ADDRESS) fail("builder_address", "builder fee is not pointed at BUILDER_ADDRESS");
    if (bps !== BigInt(POSITION_BUILDER_FEE_BPS)) {
      fail("builder_bps", `builder fee ${bps} bps, expected exactly ${POSITION_BUILDER_FEE_BPS}`);
    }
  }
  did("builder address and fee bps, by equality");

  // The oracle args must be the exact bytes we verified — not a re-fetch, not a
  // re-encode. Anything else means the price checked is not the price signed.
  const msg = abiBytes(aMsg);
  const sig = abiBytes(aSig);
  if (!msg || !sameBytes(msg, shown.oracleMessage)) {
    fail("oracle_message", "oracle message arg is not the verified payload bytes");
  }
  if (!sig || !sameBytes(sig, shown.oracleSignature)) {
    fail("oracle_signature", "oracle signature arg is not the verified signature bytes");
  }
  did("oracle message and signature are the verified bytes");

  // The SDK checks only that acceptablePrice is a positive Price12 — there is no
  // upper bound on how loose it may be.
  if (shown.indexPrice12 > BigInt(0)) {
    const drift = Math.abs(Number(shown.acceptablePrice12) - Number(shown.indexPrice12)) / Number(shown.indexPrice12);
    if (drift > shown.slippageBps / 10_000 + 1e-9) {
      fail("slippage", `acceptablePrice is ${(drift * 10_000).toFixed(1)} bps from index, tolerance ${shown.slippageBps}`);
    }
  }
  did("acceptablePrice within displayed slippage of index");

  if (BigInt(POSITION_BUILDER_FEE_BPS) > BigInt(0)) {
    const accts = (ac.accounts ?? []).map(String);
    if (!accts.includes(BUILDER_ADDRESS)) {
      fail("builder_account", "builder fee is charged but BUILDER_ADDRESS is not in accounts");
    }
  }
  did("builder address present in accounts");

  return { ok: findings.length === 0, findings, checked };
}

/**
 * Pre-flight simulation.
 *
 * A failure detector, not a security control — a 20x open simulates perfectly,
 * and a compromised frontend controls this call, its comparison and the render.
 * It is here to catch groups that would fail on chain and waste the user's time,
 * and it runs AFTER assertOpenGroup, never instead of it.
 */
export async function simulateGroup(
  algod: algosdk.Algodv2,
  txnsIn: unknown[],
): Promise<{ ok: boolean; failureAt?: number; message?: string }> {
  const txns = txnsIn.map((t) => ((t as { txn?: algosdk.Transaction }).txn ?? t) as algosdk.Transaction);
  // txns wants SignedTransaction objects, not encoded bytes; allowEmptySignatures
  // is what lets the group run without real signatures.
  const req = new algosdk.modelsv2.SimulateRequest({
    txnGroups: [new algosdk.modelsv2.SimulateRequestTransactionGroup({
      txns: txns.map((t) => new algosdk.SignedTransaction({ txn: t })),
    })],
    allowEmptySignatures: true,
  });
  try {
    const res = await algod.simulateTransactions(req).do();
    const grp = res.txnGroups?.[0];
    if (grp?.failureMessage) {
      return { ok: false, failureAt: Number(grp.failedAt?.[0] ?? -1), message: grp.failureMessage };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
