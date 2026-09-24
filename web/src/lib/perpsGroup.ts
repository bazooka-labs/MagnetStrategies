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

// ── Close path ────────────────────────────────────────────────────────────────

/** `PDexV2Trading.decrease_or_close` — 15 args, captured from the pinned SDK's encoder. */
export const CLOSE_SELECTOR = "82f0edaf" as const;

/**
 * The wildcard `expectedPositionId`. `expectedClosePositionId(undefined)` yields
 * `2^64 - 1`, which closes **whatever position currently occupies the key** —
 * including one opened after the user pressed the button. Never send it.
 */
export const POSITION_ID_WILDCARD = (BigInt(1) << BigInt(64)) - BigInt(1);
/** Valid ids are 48-bit. */
export const POSITION_ID_MAX = BigInt(1) << BigInt(48);

export type DisplayedClose = {
  sender: string;
  marketId: number;
  side: 1 | 2;
  collateralAssetId: number;
  /** Exactly the size shown. For a full close this must equal position_size_usd. */
  sizeUsdDeltaMicro: bigint;
  /** The live position size, so a "close everything" can be proven complete. */
  positionSizeUsdMicro: bigint;
  /** True when the user asked to close the whole position. */
  fullClose: boolean;
  acceptablePrice12: bigint;
  indexPrice12: bigint;
  slippageBps: number;
  /** The real position id. Never a wildcard, never a guess. */
  expectedPositionId: bigint;
  oracleMessage: Uint8Array;
  oracleSignature: Uint8Array;
  /** From prepareV2DecreaseOrCloseInput — asserted, not trusted. */
  yieldRecallMode: bigint;
  maxLongReceiptAmount: bigint;
  maxShortReceiptAmount: bigint;
};

/**
 * Assert a close group.
 *
 * This path has **no collateral transfer**, so the leverage ratio that anchors
 * the open path does not exist here. `sizeUsdDelta` has no binding check unless
 * it is asserted directly — which is why the partial-close attack works: a
 * compromised frontend shows "close my position", sends a small decrease, and the
 * user believes they are out while still fully exposed. Their take-profit then
 * fails with `reduce_size_exceeds_position` until the position grows back.
 */
export function assertCloseGroup(txnsIn: unknown[], shown: DisplayedClose): GroupAssertion {
  const txns = txnsIn.map((t) => ((t as { txn?: AnyTxn }).txn ?? t) as AnyTxn);
  const findings: GroupFinding[] = [];
  const checked: string[] = [];
  const fail = (code: string, detail: string) => findings.push({ code, detail });
  const did = (name: string) => checked.push(name);

  if (txns.length === 0) {
    fail("empty_group", "no transactions");
    return { ok: false, findings, checked };
  }

  const ids = new Set(txns.map((t) => t.txID()));
  if (ids.size !== txns.length) {
    fail("duplicate_txids", `${txns.length} transactions but ${ids.size} distinct IDs`);
  }
  did("distinct transaction IDs");

  let totalFee = BigInt(0);
  txns.forEach((t, i) => {
    totalFee += big(t.fee);
    if (String(t.sender) !== shown.sender) fail("foreign_sender", `txn ${i} sender is not the user`);
    if (t.rekeyTo) fail("rekey", `txn ${i} sets rekeyTo`);
    if (t.assetTransfer?.closeRemainderTo) fail("asset_close_to", `txn ${i} sets assetCloseTo`);
    if (t.payment?.closeRemainderTo) fail("close_remainder_to", `txn ${i} sets closeRemainderTo`);
    if (t.assetTransfer?.assetSender) fail("clawback", `txn ${i} sets assetSender (clawback)`);
    if (t.applicationCall && !ALLOWED_APP_IDS.has(Number(t.applicationCall.appIndex))) {
      fail("unpinned_app", `txn ${i} calls app ${t.applicationCall.appIndex}, not a pinned PEX app`);
    }
  });
  did("sender, rekey/close/clawback, pinned apps");

  if (totalFee > BigInt(MAX_GROUP_FEE_MICRO_ALGO)) {
    fail("fee_cap", `total fee ${totalFee} exceeds ${MAX_GROUP_FEE_MICRO_ALGO}`);
  }
  did("total fee under cap");

  // Nothing leaves the wallet on a close. Any outbound transfer is an exfiltration.
  const transfers = txns.filter((t) => t.assetTransfer || t.payment);
  if (transfers.length > 0) {
    fail("unexpected_transfer", `close path carries ${transfers.length} value transfer(s); expected none`);
  }
  did("no outbound value transfer on the close path");

  const mainCalls = txns.filter(
    (t) => t.applicationCall && Number(t.applicationCall.appIndex) === PEX_APPS.trading,
  );
  if (mainCalls.length !== 1) {
    fail("main_call_count", `expected 1 Trading call, found ${mainCalls.length}`);
    return { ok: false, findings, checked };
  }
  const ac = mainCalls[0].applicationCall!;
  const args = ac.appArgs ?? [];
  if (hex(args[0] ?? new Uint8Array()) !== CLOSE_SELECTOR) {
    fail("selector", `selector ${hex(args[0] ?? new Uint8Array())}, expected ${CLOSE_SELECTOR}`);
  }
  if (args.length !== 16) {
    fail("arg_count", `${args.length - 1} args after selector, expected 15`);
    return { ok: false, findings, checked };
  }
  did("decrease_or_close selector and arity");

  const u64 = (a: Uint8Array) => algosdk.decodeUint64(a, "bigint");
  const [, aMarket, aColl, aSide, aSize, aPrice, aSwap, aMinP, aMinS, aBuilder, aMsg, aSig, aRecall, aMaxL, aMaxS, aPosId] = args;

  if (u64(aMarket) !== BigInt(shown.marketId)) fail("market_id", `${u64(aMarket)} vs ${shown.marketId}`);
  if (u64(aColl) !== BigInt(shown.collateralAssetId)) fail("collateral_asset", `${u64(aColl)} vs ${shown.collateralAssetId}`);
  if (u64(aSide) !== BigInt(shown.side)) fail("side", `${u64(aSide)} vs ${shown.side}`);
  did("marketId, collateralAssetId, side");

  // The partial-close attack lives here.
  if (u64(aSize) !== shown.sizeUsdDeltaMicro) {
    fail("size_usd_delta", `group closes ${u64(aSize)}, screen showed ${shown.sizeUsdDeltaMicro}`);
  }
  if (shown.fullClose && u64(aSize) !== shown.positionSizeUsdMicro) {
    fail("partial_close", `full close requested but group closes ${u64(aSize)} of ${shown.positionSizeUsdMicro}`);
  }
  did("sizeUsdDelta, and full close closes the whole position");

  // The wildcard closes whatever occupies the key, including a position the user
  // opened seconds ago.
  const posId = u64(aPosId);
  if (posId === POSITION_ID_WILDCARD) {
    fail("position_id_wildcard", "expectedPositionId is the wildcard — would close whatever occupies the key");
  } else if (posId >= POSITION_ID_MAX) {
    fail("position_id_range", `expectedPositionId ${posId} is outside the 48-bit range`);
  } else if (posId !== shown.expectedPositionId) {
    fail("position_id", `group binds to position ${posId}, displayed ${shown.expectedPositionId}`);
  }
  did("expectedPositionId is real, in range, and the displayed one");

  if (u64(aSwap) !== BigInt(0)) fail("output_swap_mode", `outputSwapMode ${u64(aSwap)}, expected 0`);
  if (u64(aMinP) !== BigInt(0)) fail("min_primary", `minPrimary ${u64(aMinP)}, expected 0 at swap mode 0`);
  if (u64(aMinS) !== BigInt(0)) fail("min_secondary", `minSecondary ${u64(aMinS)}, expected 0 at swap mode 0`);
  did("outputSwapMode 0 with zero minimums");

  if (aBuilder.length !== 40) {
    fail("builder_tuple", `builder tuple ${aBuilder.length} bytes, expected 40`);
  } else {
    if (algosdk.encodeAddress(aBuilder.slice(0, 32)) !== BUILDER_ADDRESS) {
      fail("builder_address", "close builder fee is not pointed at BUILDER_ADDRESS");
    }
    if (u64(aBuilder.slice(32, 40)) !== BigInt(POSITION_BUILDER_FEE_BPS)) {
      fail("builder_bps", `close builder fee ${u64(aBuilder.slice(32, 40))} bps, expected ${POSITION_BUILDER_FEE_BPS}`);
    }
  }
  did("builder address and fee bps on the close leg");

  const msg = abiBytes(aMsg);
  const sig = abiBytes(aSig);
  if (!msg || !sameBytes(msg, shown.oracleMessage)) fail("oracle_message", "not the verified payload bytes");
  if (!sig || !sameBytes(sig, shown.oracleSignature)) fail("oracle_signature", "not the verified signature bytes");
  did("oracle message and signature are the verified bytes");

  // Recall values decide how much the contract may pull back from the yield
  // provider. They come from preparation and are asserted rather than trusted.
  if (u64(aRecall) !== shown.yieldRecallMode) fail("yield_recall_mode", `${u64(aRecall)} vs prepared ${shown.yieldRecallMode}`);
  if (u64(aMaxL) !== shown.maxLongReceiptAmount) fail("max_long_receipt", `${u64(aMaxL)} vs prepared ${shown.maxLongReceiptAmount}`);
  if (u64(aMaxS) !== shown.maxShortReceiptAmount) fail("max_short_receipt", `${u64(aMaxS)} vs prepared ${shown.maxShortReceiptAmount}`);
  did("yieldRecallMode and receipt caps match preparation");

  if (shown.indexPrice12 > BigInt(0)) {
    const drift = Math.abs(Number(shown.acceptablePrice12) - Number(shown.indexPrice12)) / Number(shown.indexPrice12);
    if (drift > shown.slippageBps / 10_000 + 1e-9) {
      fail("slippage", `acceptablePrice ${(drift * 10_000).toFixed(1)} bps from index, tolerance ${shown.slippageBps}`);
    }
  }
  if (u64(aPrice) !== shown.acceptablePrice12) {
    fail("acceptable_price", `arg ${u64(aPrice)}, displayed ${shown.acceptablePrice12}`);
  }
  did("acceptablePrice matches display and sits within slippage");

  return { ok: findings.length === 0, findings, checked };
}

// ── Take-profit leg ───────────────────────────────────────────────────────────

/** `PDexV2OrderOps.submit_linked_order`. 15 args; the 15th is a packed tuple. */
export const SUBMIT_LINKED_ORDER_SELECTOR = "269845ea" as const;
/** V2_ORDER_KIND.DECREASE_TAKE_PROFIT */
export const ORDER_KIND_TAKE_PROFIT = BigInt(2);
/** V2_ORDER_TARGET.PAIR */
export const ORDER_TARGET_PAIR = BigInt(1);
/** V2_ORDER_LINK_MODE.CHILD_ACTIVE */
export const ORDER_LINK_MODE_CHILD_ACTIVE = BigInt(3);
/** Current order-box MBR. The legacy 96,500 is 3,200 short and the contract rejects it. */
export const ORDER_BOX_MBR_MICRO_ALGO = BigInt(99_700);

export type DisplayedTakeProfit = {
  /** Price the card showed as the take-profit target, Price12. Compared exactly. */
  triggerPrice12: bigint;
  /** The TP's own acceptable price, bounded against the trigger. */
  acceptablePrice12: bigint;
  /** Size the TP closes — the position size after this open. */
  sizeUsdDeltaMicro: bigint;
  /** Keeper fee escrowed, micro-units of the collateral asset. */
  keeperFeeMicro: bigint;
  /** Absolute ceiling on the escrow, independent of what was displayed. */
  maxKeeperFeeMicro: bigint;
  /** Base id this bracket is allocated from. */
  baseOrderId: bigint;
  slippageBps: number;
};

/** Decoded trailing tuple of submit_linked_order. */
type LinkedTail = {
  minSecondary: bigint; timeInForce: bigint; expiryTime: bigint;
  linkMode: bigint; linkBaseOrderId: bigint;
  expectedPositionId: bigint; entryGroupOffset: bigint;
  builderAddress: string; builderFeeBps: bigint;
  oracleMessage: Uint8Array | null; oracleSignature: Uint8Array | null;
};

/**
 * Decode the packed tuple.
 *
 * `encodeAppArgs` packs everything from index 14 onward into one trailing tuple
 * once an ABI method exceeds 15 args, and the packing boundary comes from the
 * manifest's type list — which is what makes the manifest pin load-bearing on
 * this leg specifically. Head is 7 uint64s then the 40-byte builder tuple, then
 * two 2-byte offsets into the tail.
 */
export function decodeLinkedTail(t: Uint8Array): LinkedTail | null {
  if (t.length < 100) return null;
  const u = (o: number) => algosdk.decodeUint64(t.slice(o, o + 8), "bigint");
  const bt = t.slice(56, 96);
  const o1 = (t[96] << 8) | t[97];
  const o2 = (t[98] << 8) | t[99];
  const at = (o: number): Uint8Array | null => {
    if (o + 2 > t.length) return null;
    const n = (t[o] << 8) | t[o + 1];
    return o + 2 + n <= t.length ? t.slice(o + 2, o + 2 + n) : null;
  };
  return {
    minSecondary: u(0), timeInForce: u(8), expiryTime: u(16),
    linkMode: u(24), linkBaseOrderId: u(32),
    expectedPositionId: u(40), entryGroupOffset: u(48),
    builderAddress: algosdk.encodeAddress(bt.slice(0, 32)),
    builderFeeBps: algosdk.decodeUint64(bt.slice(32, 40), "bigint"),
    oracleMessage: at(o1), oracleSignature: at(o2),
  };
}

/**
 * Assert an open group that carries an attached take-profit.
 *
 * Take profit is mandatory, so this leg rides on every single position and every
 * field of it is checked. Two of them carry attacks that no asset-movement check
 * can see:
 *
 * - `triggerPrice` — show $0.12, submit $0.40. The order never fires and the user
 *   believes they are protected.
 * - the child's **own** builder fee. `V2AttachedOrderLegInput` carries its own
 *   `builderFee` and the child input spreads `...parent, ...leg`, so a leg-level
 *   value overrides the parent's. Pointed at an attacker it takes 10 bps of close
 *   notional from inside PEX, with no transfer in our group at all.
 */
export function assertOpenWithTakeProfit(
  txnsIn: unknown[],
  shownOpen: DisplayedOpen,
  shownTp: DisplayedTakeProfit,
): GroupAssertion {
  // Everything the plain open path checks still applies to the open leg.
  const base = assertOpenGroup(txnsIn, shownOpen);
  const txns = txnsIn.map((t) => ((t as { txn?: AnyTxn }).txn ?? t) as AnyTxn);
  const findings = [...base.findings];
  const checked = [...base.checked];
  const fail = (code: string, detail: string) => findings.push({ code, detail });
  const did = (n: string) => checked.push(n);

  // The open path asserts exactly one transfer; with a bracket there are two —
  // collateral and the keeper-fee escrow. Re-evaluate rather than inherit.
  const idx = findings.findIndex((f) => f.code === "transfer_count");
  if (idx >= 0) findings.splice(idx, 1);

  const transfers = txns.filter((t) => t.assetTransfer);
  if (transfers.length !== 2) {
    fail("transfer_count", `expected 2 transfers (collateral + keeper escrow), found ${transfers.length}`);
  }
  const escrow = transfers.find((t) => big(t.assetTransfer!.amount) !== shownOpen.collateralAmountMicro);
  if (!escrow) {
    fail("keeper_escrow_missing", "no keeper-fee escrow transfer found");
  } else {
    const amt = big(escrow.assetTransfer!.amount);
    if (amt !== shownTp.keeperFeeMicro) {
      fail("keeper_escrow_amount", `escrow ${amt}, displayed ${shownTp.keeperFeeMicro}`);
    }
    // The absolute cap is the control. A ratio alone is not: both sides of a
    // ratio come from the frontend, so displaying $400 and escrowing $800 passes.
    if (amt > shownTp.maxKeeperFeeMicro) {
      fail("keeper_escrow_cap", `escrow ${amt} exceeds the absolute cap ${shownTp.maxKeeperFeeMicro}`);
    }
    if (amt === BigInt(0)) fail("keeper_escrow_zero", "keeper fee is zero; the order would never be executed");
  }
  did("keeper-fee escrow: amount, absolute cap, non-zero");

  const mbr = txns.filter((t) => t.payment);
  if (mbr.length !== 1) {
    fail("mbr_count", `expected 1 storage payment, found ${mbr.length}`);
  } else if (big(mbr[0].payment!.amount) !== ORDER_BOX_MBR_MICRO_ALGO) {
    fail("order_box_mbr", `storage payment ${mbr[0].payment!.amount}, expected ${ORDER_BOX_MBR_MICRO_ALGO}`);
  }
  did("order-box MBR against the pinned constant");

  const subs = txns.filter(
    (t) => t.applicationCall && Number(t.applicationCall.appIndex) === PEX_APPS.orderOps,
  );
  if (subs.length !== 1) {
    fail("submit_count", `expected 1 OrderOps call, found ${subs.length}`);
    return { ok: false, findings, checked };
  }
  const A = subs[0].applicationCall!.appArgs ?? [];
  if (hex(A[0] ?? new Uint8Array()) !== SUBMIT_LINKED_ORDER_SELECTOR) {
    fail("tp_selector", `selector ${hex(A[0] ?? new Uint8Array())}, expected ${SUBMIT_LINKED_ORDER_SELECTOR}`);
  }
  if (A.length !== 16) {
    fail("tp_arg_count", `${A.length - 1} args after selector, expected 15`);
    return { ok: false, findings, checked };
  }
  const u64 = (a: Uint8Array) => algosdk.decodeUint64(a, "bigint");

  if (u64(A[1]) !== shownTp.baseOrderId + BigInt(1)) {
    fail("owner_order_id", `ownerOrderId ${u64(A[1])}, expected baseOrderId+1`);
  }
  if (u64(A[2]) !== ORDER_KIND_TAKE_PROFIT) fail("order_kind", `orderKind ${u64(A[2])}, expected take-profit`);
  if (u64(A[3]) !== ORDER_TARGET_PAIR) fail("target_kind", `targetKind ${u64(A[3])}, expected pair`);
  if (u64(A[4]) !== BigInt(shownOpen.marketId)) fail("tp_market_id", `${u64(A[4])} vs ${shownOpen.marketId}`);
  if (u64(A[5]) !== BigInt(shownOpen.side)) fail("tp_side", `${u64(A[5])} vs ${shownOpen.side}`);
  if (u64(A[6]) !== BigInt(shownOpen.collateralAssetId)) fail("tp_collateral_asset", `${u64(A[6])}`);
  if (u64(A[7]) !== shownTp.sizeUsdDeltaMicro) {
    fail("tp_size", `TP closes ${u64(A[7])}, position will be ${shownTp.sizeUsdDeltaMicro}`);
  }
  if (u64(A[8]) !== BigInt(0)) fail("tp_collateral_amount", `collateralAmount ${u64(A[8])}, expected 0`);
  did("TP identity: order id, kind, target, market, side, asset, size");

  // Show $0.12, submit $0.40 — never fires, user believes they are protected.
  if (u64(A[9]) !== shownTp.triggerPrice12) {
    fail("trigger_price", `trigger ${u64(A[9])}, screen showed ${shownTp.triggerPrice12}`);
  }
  did("triggerPrice equals the displayed target exactly");

  // The SDK checks only the side of this, never the distance.
  const tpAccept = u64(A[10]);
  if (shownTp.triggerPrice12 > BigInt(0)) {
    const drift = Math.abs(Number(tpAccept) - Number(shownTp.triggerPrice12)) / Number(shownTp.triggerPrice12);
    if (drift > shownTp.slippageBps / 10_000 + 1e-9) {
      fail("tp_slippage", `TP acceptablePrice ${(drift * 10_000).toFixed(1)} bps from trigger, tolerance ${shownTp.slippageBps}`);
    }
  }
  if (u64(A[11]) !== BigInt(shownOpen.collateralAssetId)) fail("keeper_fee_asset", `keeperFeeAssetId ${u64(A[11])}`);
  if (u64(A[12]) !== shownTp.keeperFeeMicro) fail("keeper_fee_arg", `keeperFeeAmount ${u64(A[12])} vs escrow ${shownTp.keeperFeeMicro}`);
  if (u64(A[13]) !== BigInt(0)) fail("tp_swap_mode", `outputSwapMode ${u64(A[13])}, expected 0`);
  if (u64(A[14]) !== BigInt(0)) fail("tp_min_primary", `minPrimary ${u64(A[14])}, expected 0`);
  did("TP acceptable price, keeper fee asset/amount, swap mode, minimums");

  const tail = decodeLinkedTail(A[15]);
  if (!tail) {
    fail("tp_tail_decode", "could not decode the packed trailing tuple");
    return { ok: false, findings, checked };
  }
  if (tail.minSecondary !== BigInt(0)) fail("tp_min_secondary", `minSecondary ${tail.minSecondary}`);
  // GTC. The SDK default is right; an override is not otherwise caught.
  if (tail.timeInForce !== BigInt(0)) fail("time_in_force", `timeInForce ${tail.timeInForce}, expected GTC (0)`);
  if (tail.expiryTime !== BigInt(0)) fail("expiry_time", `expiryTime ${tail.expiryTime}, expected 0`);
  if (tail.linkMode !== ORDER_LINK_MODE_CHILD_ACTIVE) fail("link_mode", `linkMode ${tail.linkMode}, expected child-active`);
  if (tail.linkBaseOrderId !== shownTp.baseOrderId) {
    fail("link_base_order_id", `linkBaseOrderId ${tail.linkBaseOrderId}, expected ${shownTp.baseOrderId}`);
  }
  did("GTC, no expiry, link mode and base order id");

  // The binding pair. On a same-group open the position does not exist yet, so
  // expectedPositionId is 0 and the offset points back at the entry. Measured on
  // a real group: the offset is the distance between the two transactions.
  const openIdx = txns.findIndex(
    (t) => t.applicationCall && Number(t.applicationCall.appIndex) === PEX_APPS.trading,
  );
  const tpIdx = txns.findIndex((t) => t === subs[0]);
  if (tail.expectedPositionId !== BigInt(0)) {
    fail("tp_expected_position_id", `same-group open requires expectedPositionId 0, got ${tail.expectedPositionId}`);
  }
  const wantOffset = BigInt(tpIdx - openIdx);
  if (tail.entryGroupOffset !== wantOffset) {
    fail("entry_group_offset", `entryGroupOffset ${tail.entryGroupOffset}, expected ${wantOffset} (tp@${tpIdx} − open@${openIdx})`);
  }
  if (tail.entryGroupOffset < BigInt(1) || tail.entryGroupOffset > BigInt(15)) {
    fail("entry_group_offset_range", `entryGroupOffset ${tail.entryGroupOffset} outside 1..15`);
  }
  did("expectedPositionId / entryGroupOffset binding pair");

  // A leg-level builder fee overrides the parent's, invisibly to every transfer check.
  if (tail.builderAddress !== BUILDER_ADDRESS) {
    fail("tp_builder_address", "the CHILD's builder fee is not pointed at BUILDER_ADDRESS");
  }
  if (tail.builderFeeBps !== BigInt(POSITION_BUILDER_FEE_BPS)) {
    fail("tp_builder_bps", `child builder fee ${tail.builderFeeBps} bps, expected ${POSITION_BUILDER_FEE_BPS}`);
  }
  did("child builder address and fee bps");

  if (!tail.oracleMessage || !sameBytes(tail.oracleMessage, shownOpen.oracleMessage)) {
    fail("tp_oracle_message", "TP oracle message is not the verified payload bytes");
  }
  if (!tail.oracleSignature || !sameBytes(tail.oracleSignature, shownOpen.oracleSignature)) {
    fail("tp_oracle_signature", "TP oracle signature is not the verified signature bytes");
  }
  did("TP oracle message and signature are the verified bytes");

  return { ok: findings.length === 0, findings, checked };
}
