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
  V2_OPEN_ORDER_EXECUTION_STORAGE_ESCROW_MICRO_ALGO,
  V2_POSITION_BOX_MBR_MICRO_ALGO,
} from "@pdex/sdk";
import {
  ALGORAND_MAINNET_GENESIS_HASH_HEX,
  BUILDER_ADDRESS,
  MAX_KEEPER_FEE_ESCROW_USDC,
  PEX_APPS,
  POSITION_BUILDER_FEE_BPS,
  TAKE_PROFIT_TIME_IN_FORCE,
} from "./perps";

// ── Pinned method selectors ───────────────────────────────────────────────────
export const PEX_SELECTORS = {
  /** PDexV2Trading.open_or_increase — 7 args after the selector. */
  openOrIncrease: "316981bf",
  /** `PDexV2Trading.fund_storage` — leads the group when the escrow is short. */
  fundStorage: "ade7203b",
  /** PDexV2Math.noop — the resource/budget carrier. Zero args. */
  mathNoop: "e83a87ab",
  /**
   * `PDexV2OrderOps.submit_linked_order` — every order leg, parent or child.
   *
   * A limit ENTRY uses this too, as `BRACKET_PARENT`, which is why the limit
   * path reuses `decodeLinkedTail` rather than needing a decoder of its own.
   */
  submitLinkedOrder: "269845ea",
  /** `PDexV2OrderOps.cancel_order` — one uint64 arg, the owner order id. */
  cancelOrder: "847ccf3d",
} as const;

/**
 * Apps a Perps group may call, and how many times.
 *
 * Previously this was every value of PEX_APPS with counts enforced only for
 * Trading and OrderOps — so an extra call to cvaVault, swapOps, adminOps or
 * adminControl passed the assertion untouched. Those apps are pinned, which
 * makes them *ours*, not harmless. An allow-list is only a control if the things
 * it excludes are actually excluded.
 *
 * Math carriers vary with pool state, so they are bounded rather than fixed.
 */
const CALL_BUDGET: ReadonlyArray<{ app: number; name: string; min: number; max: number }> = [
  // Trading's bound is overridden per shape — see `checkCallBudget`.
  { app: PEX_APPS.trading, name: "Trading", min: 1, max: 1 },
  { app: PEX_APPS.orderOps, name: "OrderOps", min: 0, max: 1 },
  // Real groups build exactly 4, on both markets and both sides — see
  // __fixtures__/perpsGroups.json. But the count is NOT ours: the SDK derives
  // it from pool and yield-vault state via `sharedCarrierOrderIds` and
  // `appCall.resourceCarriers`, so it can legitimately grow without any change
  // here. A tight ceiling would surface a benign SDK change to the user as
  // "Safety check failed, nothing was sent", which reads as a security
  // incident. The carriers are individually asserted to be bare noops
  // (`checkMathCarriers`), so an extra one cannot do anything — the count is
  // not the control, their contents are.
  { app: PEX_APPS.math, name: "Math carrier", min: 0, max: 8 },
];
const CALLABLE: ReadonlySet<number> = new Set(CALL_BUDGET.map((c) => c.app));

const td = new TextDecoder();

/**
 * Byte offset of `targetAppId` in a signed oracle message.
 *
 * The layout is `magic "PDX2"(4) | version(1) | genesisHash(32)` then twelve
 * big-endian uint64s, the first of which is the target app — so 4 + 1 + 32 = 37.
 * Mirrors `HEADER_LEN` in perpsOracle, and is the exact field OrderOps reads at
 * `pc=6355` before asserting it against its own application id.
 */
const ORACLE_TARGET_APP_OFFSET = 37;

/** Every pinned PEX app id, for bounding foreign-app references. */
const PINNED_APP_IDS: ReadonlySet<number> = new Set(Object.values(PEX_APPS).map(Number));
/** Their application addresses — real groups name PEX's own accounts. */
const PEX_APP_ADDRESSES: ReadonlySet<string> = new Set(
  Object.values(PEX_APPS).map((id) => algosdk.getApplicationAddress(Number(id)).toString()),
);
/**
 * The only notes a legitimate group carries.
 *
 * `pdex-v2-linked-escrow-<childOrderId>` on the keeper-fee escrow transfer and
 * `pdex-v2-linked-storage-<childOrderId>` on the order-box MBR payment. The
 * exact values are pinned in `assertOpenWithTakeProfit`, where the base order
 * id is known; this is the shape gate for every other path.
 */
/** A transaction's note as text, or "" when it has none. */
const noteText = (t: AnyTxn): string => (t.note && t.note.length > 0 ? td.decode(t.note) : "");

const LINKED_NOTE_RE = /^pdex-v2-linked-(escrow|storage)-\d+$/;

/**
 * Math carriers exist to buy opcode budget; they must do nothing else.
 *
 * They were counted and never inspected — selector, arguments, accounts,
 * foreign apps and assets all unbound. The blast radius is small (the Math app
 * account holds exactly its own minimum balance and no ASAs, so this costs fees
 * rather than funds), but "the target happens to be empty" is not a control.
 */
function checkMathCarriers(
  txns: AnyTxn[], fail: (code: string, detail: string) => void, did: (n: string) => void,
): void {
  /**
   * What an asserted call in this group already makes available.
   *
   * A carrier may not INTRODUCE a resource; it may only re-name one that a
   * non-carrier call in the same group already references. That is the real
   * control, and it is why "names nothing" was the right rule for the
   * market-open flow and the wrong rule in general:
   *
   * The limit flow's `doi:` carrier legitimately names the PEX fee recipient,
   * the sender and USDC — all of which the OrderOps entry call already carries.
   * Demanding bare carriers there fails-closed on every correct limit group,
   * which is the trade-blocking pattern three earlier rounds shipped. Requiring
   * the resource to be pre-existing keeps the property that matters: a carrier
   * cannot widen the group's reach.
   *
   * A `noop` with zero args cannot move value itself. The hazard is making
   * something available to a DIFFERENT call, and every other call here is
   * asserted, so a resource already in their reference set is one the rest of
   * this module has already accounted for.
   */
  const allowedAccounts = new Set<string>();
  const allowedAssets = new Set<number>();
  for (const t of txns) {
    const call = t.applicationCall;
    if (call && Number(call.appIndex) !== PEX_APPS.math) {
      for (const a of call.accounts ?? []) allowedAccounts.add(String(a));
      for (const a of call.foreignAssets ?? []) allowedAssets.add(Number(a));
    }
    // The sender is available to every transaction by definition.
    allowedAccounts.add(String(t.sender));
    if (t.assetTransfer) allowedAssets.add(Number(t.assetTransfer.assetIndex));
  }
  /**
   * The pinned apps' own addresses.
   *
   * Derived from `PEX_APPS`, never written down as a constant — so this cannot
   * drift from the app pins, and an app id that changed would move these with
   * it rather than silently keeping an allow-list entry alive.
   *
   * The limit flow's `doi:` carrier names the **Markets** app address, which is
   * where PEX's own protocol fee is paid (observed: 0.053090 USDC on our first
   * real open). No asserted call in that group references it, so a strict
   * "pre-existing only" rule rejects every correct limit group. These addresses
   * belong to contracts we have already pinned; making one available cannot
   * reach anything the pins do not already cover.
   */
  for (const id of Object.values(PEX_APPS)) {
    allowedAccounts.add(algosdk.getApplicationAddress(id).toString());
  }

  txns.forEach((t, i) => {
    const call = t.applicationCall;
    if (!call || Number(call.appIndex) !== PEX_APPS.math) return;
    const args = (call.appArgs ?? []) as Uint8Array[];
    if (args.length !== 1 || hex(args[0]) !== PEX_SELECTORS.mathNoop) {
      fail("math_carrier_args",
        `txn ${i}: Math call carries ${args.length} arg(s), selector ${hex(args[0] ?? new Uint8Array())}`);
    }
    for (const a of call.accounts ?? []) {
      if (!allowedAccounts.has(String(a))) {
        fail("math_carrier_accounts", `txn ${i}: carrier names account ${String(a)}, which no asserted call references`);
      }
    }
    for (const a of call.foreignAssets ?? []) {
      if (!allowedAssets.has(Number(a))) {
        fail("math_carrier_assets", `txn ${i}: carrier names asset ${Number(a)}, which no asserted call references`);
      }
    }
    // Foreign APPS are deliberately not checked: real carriers reference one or
    // two, which is how they buy the opcode budget they exist for. The app
    // allow-list in `checkCallBudget` is what bounds which apps may be CALLED.
  });
  did("Math carriers are bare noops that introduce no account or asset of their own");
}

/**
 * Ceiling on total group fee, microALGO.
 *
 * Measured: an open is 33,000 and an open with a take-profit is 51,000. The old
 * cap of 250,000 left roughly 0.2 ALGO per trade skimmable inside an otherwise
 * valid group — small, but the one tamper that nothing else would catch. This
 * keeps ~2x headroom for extra resource carriers without leaving that room.
 */
export const MAX_GROUP_FEE_MICRO_ALGO = 120_000;

/**
 * The only two storage-escrow payments a legitimate group makes.
 *
 * `V2_OPEN_ORDER_EXECUTION_STORAGE_ESCROW_MICRO_ALGO` (100,200) on a first
 * trade — 70,900 of position-box MBR plus 29,300 consumed creating the `t2:`
 * box — and `V2_POSITION_BOX_MBR_MICRO_ALGO` (70,900) to top an existing
 * escrow back up. Pinned from the SDK so the assertion has an anchor the
 * caller does not control.
 */
export const STORAGE_ESCROW_MICRO_ALGO = BigInt(V2_OPEN_ORDER_EXECUTION_STORAGE_ESCROW_MICRO_ALGO);
export const POSITION_BOX_MBR_MICRO_ALGO = BigInt(V2_POSITION_BOX_MBR_MICRO_ALGO);

/**
 * The transaction types a Perps flow contains, and how many of each.
 *
 * **This closes a whole class rather than an instance.** Every other check in
 * this module finds its leg by looking for a sub-object — `t.assetTransfer`,
 * `t.applicationCall`, `t.payment`. A transaction that has none of them is
 * therefore invisible to all of them: an injected `acfg`, `keyreg` or `afrz`
 * passed the entire assertion untouched. The `acfg` is the dangerous one — a
 * single extra transaction, sender the user, reassigning `manager`/`clawback`
 * on an ASA that user administers hands an attacker unilateral control of every
 * holder's balance of that asset, and it appears as one more line in a wallet
 * prompt on a screen that has just said the group was verified.
 *
 * The SDK is the group builder, so this is squarely inside the stated threat
 * model: construction bugs and compromise confined to the group-building path.
 *
 * Counts are from real `@pdex/sdk` 0.6.3 output — see
 * `__fixtures__/perpsGroups.json`, which is 9 transactions,
 * `axfer,appl,appl,appl,appl,axfer,pay,appl,appl`, on both markets and sides.
 * `appl` is bounded loosely here because `CALL_BUDGET` bounds it per app, which
 * is the tighter and more meaningful constraint.
 */
export type GroupShape = {
  axfer: number; pay: number; applMin: number; applMax: number;
  /** Trading app calls. Two when the group funds storage: `fund_storage` then the open. */
  trading: number;
  /**
   * OrderOps calls, exact, when this flow pins them.
   *
   * Left undefined on the market-open shapes so they keep `CALL_BUDGET`'s
   * 0..1 exactly as before. The limit flows MUST pin it: a limit entry is
   * itself an OrderOps call, so its bracket makes **two**, and the default
   * ceiling of one would fail-closed on a correct group.
   */
  orderOps?: number;
};

/** Collateral transfer + app calls. No order box, so no MBR payment. */
export const SHAPE_OPEN: GroupShape = { axfer: 1, pay: 0, applMin: 1, applMax: 10, trading: 1 };
/** Adds the keeper-fee escrow transfer and the order-box MBR payment. */
export const SHAPE_OPEN_TP: GroupShape = { axfer: 2, pay: 1, applMin: 2, applMax: 10, trading: 1 };
/**
 * The same, for a trader whose storage escrow needs funding first.
 *
 * Real MainNet output for a first-time trader is eleven transactions:
 * `pay, appl(Trading fund_storage), axfer, appl(Trading open), appl x3 (Math),
 * axfer, pay, appl(OrderOps), appl(Math)` — so a second payment and a **second
 * Trading call**. Without this shape the assertion fail-closes on a correct
 * group, which is how a fix for one thing becomes a block on everything.
 */
export const SHAPE_OPEN_TP_STORAGE: GroupShape = { axfer: 2, pay: 2, applMin: 3, applMax: 11, trading: 2 };
/** Closing moves no value in the group itself. */
export const SHAPE_CLOSE: GroupShape = { axfer: 0, pay: 0, applMin: 1, applMax: 10, trading: 1 };

/**
 * Cancelling one standalone order. **Nothing leaves the wallet.**
 *
 * Measured: a single OrderOps call. The refunds — stake, keeper fee and the
 * order-box MBR — all arrive as INNER transactions, so a correct cancel group
 * contains no transfer and no payment at all. That is the property worth
 * asserting: anything outbound here is not part of cancelling.
 */
export const SHAPE_CANCEL: GroupShape = {
  axfer: 0, pay: 0, applMin: 1, applMax: 1, trading: 0, orderOps: 1,
};
/** Cancelling a bracket: the same call with a second box ref, plus a carrier. */
export const SHAPE_CANCEL_BRACKET: GroupShape = {
  axfer: 0, pay: 0, applMin: 2, applMax: 3, trading: 0, orderOps: 1,
};

/**
 * A limit entry, alone. **Zero Trading calls** — it is entirely OrderOps.
 *
 * Measured on MainNet 2026-09-29: seven transactions,
 * `axfer, pay, appl(OrderOps), appl x4 (Math)`. The single transfer carries
 * collateral AND the keeper fee together, unlike the market-open flow where
 * they are two separate transfers.
 */
export const SHAPE_OPEN_LIMIT: GroupShape = {
  axfer: 1, pay: 1, applMin: 1, applMax: 10, trading: 0, orderOps: 1,
};
/**
 * A limit entry with its attached take-profit. Ten transactions, measured.
 *
 * `axfer, pay, appl(OrderOps), appl x4 (Math), axfer, pay, appl(OrderOps)` —
 * the child brings its own keeper-fee transfer and its own order-box MBR.
 */
export const SHAPE_OPEN_LIMIT_TP: GroupShape = {
  axfer: 2, pay: 2, applMin: 2, applMax: 10, trading: 0, orderOps: 2,
};

const ALLOWED_TXN_TYPES: ReadonlySet<string> = new Set(["axfer", "appl", "pay"]);

function checkTxnShape(
  txns: AnyTxn[], shape: GroupShape,
  fail: (code: string, detail: string) => void,
  did: (name: string) => void,
): void {
  const counts: Record<string, number> = {};
  txns.forEach((t, i) => {
    const type = String(t.type ?? "");
    counts[type] = (counts[type] ?? 0) + 1;
    if (!ALLOWED_TXN_TYPES.has(type)) {
      fail("txn_type", `txn ${i} is "${type || "typeless"}" — this flow contains only axfer, appl and pay`);
    }
  });
  const axfer = counts.axfer ?? 0;
  const pay = counts.pay ?? 0;
  const appl = counts.appl ?? 0;
  if (axfer !== shape.axfer) fail("axfer_count", `expected ${shape.axfer} asset transfer(s), found ${axfer}`);
  if (pay !== shape.pay) fail("pay_count", `expected ${shape.pay} payment(s), found ${pay}`);
  if (appl < shape.applMin || appl > shape.applMax) {
    fail("appl_count", `expected ${shape.applMin}..${shape.applMax} app calls, found ${appl}`);
  }
  did("every transaction is a type this flow contains, in the expected counts");
}

/** Checks every app call against CALL_BUDGET. */
function checkCallBudget(
  txns: { applicationCall?: { appIndex: bigint | number } }[],
  fail: (code: string, detail: string) => void,
  shape: GroupShape,
): void {
  const counts = new Map<number, number>();
  for (const t of txns) {
    if (!t.applicationCall) continue;
    const app = Number(t.applicationCall.appIndex);
    if (!CALLABLE.has(app)) {
      fail("unpinned_app", `group calls app ${app}, which this flow never uses`);
      continue;
    }
    counts.set(app, (counts.get(app) ?? 0) + 1);
  }
  for (const c of CALL_BUDGET) {
    const seen = counts.get(c.app) ?? 0;
    // Trading is exact and comes from the shape: one call normally, two when
    // the group funds storage first.
    const [min, max] = c.app === PEX_APPS.trading
      ? [shape.trading, shape.trading]
      // Pinned exactly when the flow declares it; otherwise the default budget.
      // A limit bracket legitimately makes two OrderOps calls.
      : c.app === PEX_APPS.orderOps && shape.orderOps !== undefined
        ? [shape.orderOps, shape.orderOps]
        : [c.min, c.max];
    if (seen < min || seen > max) {
      fail("call_budget", `${c.name} called ${seen} times, expected ${min}..${max}`);
    }
  }
}

export type GroupFinding = { code: string; detail: string };
export type GroupAssertion = { ok: boolean; findings: GroupFinding[]; checked: string[] };

type AnyTxn = {
  type: string;
  sender: unknown;
  fee?: bigint | number;
  rekeyTo?: unknown;
  /** Free-form bytes the user signs without being shown them. */
  note?: Uint8Array;
  lease?: Uint8Array;
  genesisHash?: Uint8Array;
  firstValid?: bigint | number;
  lastValid?: bigint | number;
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
    /** 0 is NoOp; anything else is a different operation. */
    onComplete?: bigint | number;
    accounts?: unknown[];
    foreignApps?: (bigint | number)[];
    foreignAssets?: (bigint | number)[];
    boxes?: unknown[];
  };
  txID: () => string;
};

/** What the confirm screen showed. Every field is compared, not sanity-checked. */
export type DisplayedOpen = {
  /**
   * MicroALGO this group pays into the trader's storage escrow, or 0n.
   *
   * Non-zero changes the group's shape — a leading payment and a second Trading
   * call — so it is part of what is displayed and asserted, not an incidental
   * detail. See SHAPE_OPEN_TP_STORAGE.
   */
  storagePaymentMicro: bigint;
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
  /**
   * Execution price the quote returned — what acceptablePrice is anchored to.
   *
   * NOT the index. Price impact is charged before the slippage test and is flat
   * in size, so an index anchor fails at every size and closes whole sides. An
   * earlier version of this assertion measured against the index and refused 3
   * of 4 correct groups.
   */
  executionPrice12: bigint;
  /** Index price the card displayed, Price12. Shown to the user, not the anchor. */
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
/**
 * Is `acceptable` a legitimate worst-price for an order at `reference`?
 *
 * Deliberately written out here rather than importing the helper that produced
 * the value: an assertion that calls the same function it is checking proves
 * self-consistency, not correctness.
 *
 * `opening` a long pays UP from the execution price, a short receives DOWN.
 * `closing` inverts — selling a long accepts DOWN from the trigger, buying back
 * a short accepts UP. Both directions are bounded on the far side by the
 * tolerance and on the near side by the reference itself, so a value on the
 * wrong side is caught as well as one that is merely too loose.
 */
function acceptableWithin(
  acceptable: bigint, reference: bigint, side: 1 | 2,
  slippageBps: number, intent: "opening" | "closing",
): { ok: boolean; why: string } {
  if (reference <= BigInt(0)) return { ok: false, why: "reference price is not positive" };
  const bps = BigInt(Math.max(0, Math.round(slippageBps)));
  const tenK = BigInt(10_000);
  const up = (reference * (tenK + bps)) / tenK;
  const down = (reference * (tenK - bps)) / tenK;
  // Which way this order is willing to move.
  const paysUp = intent === "opening" ? side === 1 : side === 2;
  const lo = paysUp ? reference : down;
  const hi = paysUp ? up : reference;
  if (acceptable < lo || acceptable > hi) {
    return {
      ok: false,
      why: `${acceptable} outside [${lo}, ${hi}] for ${intent} side ${side} at ${slippageBps} bps`,
    };
  }
  return { ok: true, why: "" };
}

function abiBytes(arg: Uint8Array): Uint8Array | null {
  if (arg.length < 2) return null;
  const declared = (arg[0] << 8) | arg[1];
  const body = arg.slice(2);
  return declared === body.length ? body : null;
}

/**
 * Every check that applies to every transaction, on every path.
 *
 * **Extracted because duplicating it cost us.** The open and close assertions
 * each had their own copy of this loop, and the Phase 12 hardening — notes,
 * lease, resource references, onComplete, genesis hash — went into the open
 * one only. The close path silently kept the old, weaker set, and the real-bytes
 * close tests found it: a smuggled note, a lease and an attacker address
 * appended to the Trading call's accounts all passed on a close.
 *
 * One function, two callers. Hardening it cannot now miss a path.
 *
 * Returns the group's total fee, which the caller bounds against its own cap.
 */
function checkEveryTransaction(
  txns: AnyTxn[],
  ctx: { sender: string; collateralAssetId: number },
  fail: (code: string, detail: string) => void,
  did: (name: string) => void,
): bigint {
  let totalFee = BigInt(0);
  txns.forEach((t, i) => {
    totalFee += big(t.fee);
    if (String(t.sender) !== ctx.sender) {
      fail("foreign_sender", `txn ${i} sender is not the user`);
    }
    // Any of these three silently reassign the account or sweep a balance.
    if (t.rekeyTo) fail("rekey", `txn ${i} sets rekeyTo`);
    if (t.assetTransfer?.closeRemainderTo) fail("asset_close_to", `txn ${i} sets assetCloseTo`);
    if (t.payment?.closeRemainderTo) fail("close_remainder_to", `txn ${i} sets closeRemainderTo`);
    if (t.assetTransfer?.assetSender) fail("clawback", `txn ${i} sets assetSender (clawback)`);
    // `onComplete` 0 is NoOp. Anything else — OptIn, CloseOut, UpdateApplication,
    // DeleteApplication — is a different operation wearing this group's shape.
    const onComplete = Number(t.applicationCall?.onComplete ?? 0);
    if (onComplete !== 0) {
      fail("on_complete", `txn ${i} app call has onComplete ${onComplete}, expected NoOp`);
    }
    // A note is free-form bytes the user signs without being shown them. The
    // SDK uses two functionally, to mark the linked escrow and storage legs, so
    // banning notes outright would block every open — the real captured groups
    // caught that before it shipped. Bound to those markers instead, with the
    // exact values pinned in the bracket path where the order id is known, and
    // never on an app call or on the collateral leg.
    if (t.note && t.note.length > 0) {
      const text = td.decode(t.note);
      if (t.type === "appl" || !LINKED_NOTE_RE.test(text)) {
        fail("note", `txn ${i} (${t.type}) carries a ${t.note.length}-byte note: "${text.slice(0, 40)}"`);
      }
    }
    // A lease squats the sender+lease pair for the validity window. Nothing
    // here sets one, so anything that does was not put there by us.
    if (t.lease && t.lease.length > 0) fail("lease", `txn ${i} sets a lease`);
    // Resource references. Inert on their own — PEX decides what it touches —
    // but these are unbound fields on the calls that move money, and the Math
    // carriers beside them already bind exactly this. Real groups reference
    // only the sender, the builder, PEX's own app addresses, USDC, and pinned
    // PEX apps: see __fixtures__/perpsGroups.json.
    const call = t.applicationCall;
    if (call) {
      for (const a of (call.accounts ?? [])) {
        const addr = String(a);
        if (addr !== ctx.sender && addr !== BUILDER_ADDRESS && !PEX_APP_ADDRESSES.has(addr)) {
          fail("foreign_account", `txn ${i} names account ${addr.slice(0, 10)}…`);
        }
      }
      for (const x of (call.foreignAssets ?? [])) {
        if (Number(x) !== ctx.collateralAssetId) {
          fail("foreign_asset", `txn ${i} references asset ${x}`);
        }
      }
      for (const x of (call.foreignApps ?? [])) {
        if (!PINNED_APP_IDS.has(Number(x))) fail("foreign_app", `txn ${i} references app ${x}`);
      }
    }
    // One network. algod would refuse a foreign genesis hash, but the assertion
    // is what runs before the wallet prompt, and it pinned the validity window
    // without pinning what chain the window was on.
    if (t.genesisHash && hex(t.genesisHash) !== ALGORAND_MAINNET_GENESIS_HASH_HEX) {
      fail("genesis_hash", `txn ${i} is not for Algorand MainNet`);
    }
  });

  // One validity window across the group. A leg with a longer window than its
  // neighbours can be replayed on its own after the rest has expired.
  const firsts = new Set(txns.map((t) => String(t.firstValid)));
  const lasts = new Set(txns.map((t) => String(t.lastValid)));
  if (firsts.size !== 1 || lasts.size !== 1) {
    fail("validity_window", `group spans ${firsts.size} first-valid and ${lasts.size} last-valid rounds`);
  }

  did("sender is the user on every transaction");
  did("no rekeyTo / assetCloseTo / closeRemainderTo / clawback");
  did("no onComplete change, no unexpected note, no lease");
  did("accounts, foreign apps and foreign assets all bounded");
  did("every leg is for Algorand MainNet, in one validity window");
  return totalFee;
}

/**
 * Assert a complete open group against what was displayed.
 *
 * Returns every finding rather than throwing on the first, so a failure report
 * shows the whole picture instead of one symptom at a time.
 */
export function assertOpenGroup(
  txnsIn: unknown[], shown: DisplayedOpen, shape: GroupShape = SHAPE_OPEN,
): GroupAssertion {
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

  const totalFee = checkEveryTransaction(
    txns, { sender: shown.sender, collateralAssetId: shown.collateralAssetId }, fail, did,
  );
  checkTxnShape(txns, shape, fail, did);
  checkCallBudget(txns, fail, shape);
  checkMathCarriers(txns, fail, did);
  did("sender is the user on every transaction");
  did("no rekeyTo / assetCloseTo / closeRemainderTo / clawback");
  did("app calls within the flow's budget, by app and by count");

  if (totalFee > BigInt(MAX_GROUP_FEE_MICRO_ALGO)) {
    fail("fee_cap", `total fee ${totalFee} exceeds ${MAX_GROUP_FEE_MICRO_ALGO} microALGO`);
  }
  did("total fee under cap");

  // ── Asset movement ──────────────────────────────────────────────────────────
  // Count is asserted by `checkTxnShape` against the flow's shape; this path
  // only needs the collateral leg, which is the first transfer in every real
  // group the SDK builds.
  const transfers = txns.filter((t) => t.assetTransfer);
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
    // The collateral leg carries NO note in any real group. Without this, a
    // well-formed `pdex-v2-linked-*` marker passes here on the strength of
    // being well-formed, even though it belongs on the escrow leg — the shape
    // gate alone cannot tell the two transfers apart.
    if (transfers[0].note && transfers[0].note.length > 0) {
      fail("note", "the collateral transfer carries a note");
    }
  }
  did("collateral transfer: asset, amount, receiver, no note");

  // ── open_or_increase ────────────────────────────────────────────────────────
  //
  // Found by SELECTOR, not by being the only Trading call. A storage-funding
  // group carries two Trading calls — `fund_storage` then the open — and
  // assuming one was a hardcoded assumption about the nine-transaction shape.
  const tradingCallsAll = txns.filter(
    (t) => t.applicationCall && Number(t.applicationCall.appIndex) === PEX_APPS.trading,
  );
  if (tradingCallsAll.length !== shape.trading) {
    fail("main_call_count",
      `expected ${shape.trading} Trading app call(s), found ${tradingCallsAll.length}`);
    return { ok: findings.length === 0, findings, checked };
  }
  const mainCalls = tradingCallsAll.filter(
    (t) => hex((t.applicationCall!.appArgs ?? [])[0] ?? new Uint8Array()) === PEX_SELECTORS.openOrIncrease,
  );
  if (mainCalls.length !== 1) {
    fail("main_call_count",
      `expected exactly 1 open_or_increase call, found ${mainCalls.length}`);
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
  const openBound = acceptableWithin(
    shown.acceptablePrice12, shown.executionPrice12, shown.side, shown.slippageBps, "opening",
  );
  if (!openBound.ok) fail("slippage", openBound.why);
  did("acceptablePrice on the right side of execution, within tolerance");

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
    /**
     * **Required for rekeyed accounts.**
     *
     * With an empty signature, algod resolves the authorizing address to the
     * sender. For a rekeyed account that is wrong — it must be the auth address
     * — so simulation refused a group a real wallet would sign correctly:
     * "should have been authorized by X but was actually authorized by Y".
     * Confirmed on a live rekeyed PEX trader: without this, refused; with it,
     * ok, same group.
     *
     * Rekeying is routine on Algorand (Pera/Defly vaults, multisig, hardware
     * rekeys, contract-controlled accounts), so this blocked that entire
     * audience with an error that named PEX for a defect that was ours.
     * Setting `authAddr` on the SignedTransaction instead does not work.
     */
    fixSigners: true,
  });
  try {
    const res = await algod.simulateTransactions(req).do();
    // Fail CLOSED on an unexpected shape. Previously a 200 with no txnGroups
    // left `grp` undefined, `grp?.failureMessage` undefined, and the function
    // returned ok — silently skipping the pre-flight and going to the prompt.
    const groups = res.txnGroups ?? [];
    if (groups.length !== 1) {
      return { ok: false, message: `simulation returned ${groups.length} groups, expected 1` };
    }
    const grp = groups[0];
    if (grp.failureMessage) {
      return { ok: false, failureAt: Number(grp.failedAt?.[0] ?? -1), message: grp.failureMessage };
    }
    const units = grp.txnResults ?? [];
    if (units.length !== txns.length) {
      return { ok: false, message: `simulation returned ${units.length} results for ${txns.length} transactions` };
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
  /** Execution price the close quote returned — the anchor, not the index. */
  executionPrice12: bigint;
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

  checkTxnShape(txns, SHAPE_CLOSE, fail, did);

  const ids = new Set(txns.map((t) => t.txID()));
  if (ids.size !== txns.length) {
    fail("duplicate_txids", `${txns.length} transactions but ${ids.size} distinct IDs`);
  }
  did("distinct transaction IDs");

  const totalFee = checkEveryTransaction(
    txns, { sender: shown.sender, collateralAssetId: shown.collateralAssetId }, fail, did,
  );
  checkCallBudget(txns, fail, SHAPE_CLOSE);
  checkMathCarriers(txns, fail, did);
  did("app calls within the flow's budget, by app and by count");

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

  // A close is the opposite direction from an open at the same side.
  const closeBound = acceptableWithin(
    shown.acceptablePrice12, shown.executionPrice12, shown.side, shown.slippageBps, "closing",
  );
  if (!closeBound.ok) fail("slippage", closeBound.why);
  if (u64(aPrice) !== shown.acceptablePrice12) {
    fail("acceptable_price", `arg ${u64(aPrice)}, displayed ${shown.acceptablePrice12}`);
  }
  did("acceptablePrice matches display, on the right side of execution, within tolerance");

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
/** V2_ORDER_LINK_MODE.BRACKET_PARENT — what a limit ENTRY is submitted as. */
export const ORDER_LINK_MODE_BRACKET_PARENT = BigInt(1);
/** V2_ORDER_LINK_MODE.CHILD_WAIT_PARENT — a child whose entry has not filled. */
export const ORDER_LINK_MODE_CHILD_WAIT_PARENT = BigInt(2);
/** V2_ORDER_KIND.OPEN_LIMIT */
export const ORDER_KIND_OPEN_LIMIT = BigInt(1);
/**
 * The order-box MBR a **limit entry** pays, which is NOT the child's.
 *
 * Measured: a limit parent pays 100,200 µALGO and an attached child pays
 * 99,700 — the same 99,700 our market-open path pays for its take-profit box,
 * and the same 100,200 that `submit_order` pays. Observed independently on
 * cancel refunds, which return exactly what was taken. Asserting one constant
 * for both would fail-closed on every correct limit group.
 */
export const LIMIT_ORDER_BOX_MBR_MICRO_ALGO = BigInt(100_200);
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
  /** Base id this bracket is allocated from. */
  baseOrderId: bigint;
  slippageBps: number;
  /**
   * The child leg's own oracle payload — targeted at **OrderOps**, not Trading.
   *
   * This is the second half of B6. A pair-market entry needs *two separately
   * targeted* published payloads: the entry call goes to Trading and each
   * attached child goes to OrderOps, and the signed message binds the app it
   * may be presented to. Reusing the Trading payload on the child made OrderOps
   * assert its own app id against Trading's and fail at `pc=6359`.
   */
  oracleMessage: Uint8Array;
  oracleSignature: Uint8Array;
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
  const fundsStorage = shownOpen.storagePaymentMicro > BigInt(0);
  const base = assertOpenGroup(
    txnsIn, shownOpen, fundsStorage ? SHAPE_OPEN_TP_STORAGE : SHAPE_OPEN_TP,
  );
  const txns = txnsIn.map((t) => ((t as { txn?: AnyTxn }).txn ?? t) as AnyTxn);
  const findings = [...base.findings];
  const checked = [...base.checked];
  const fail = (code: string, detail: string) => findings.push({ code, detail });
  const did = (n: string) => checked.push(n);

  // Transfer and payment counts come from SHAPE_OPEN_TP, asserted above by the
  // inherited `assertOpenGroup` call. This used to splice a `transfer_count`
  // finding back out of the inherited list, which meant the correct count was
  // never actually asserted on this path — only the wrong one was deleted.
  const transfers = txns.filter((t) => t.assetTransfer);
  const orderOpsAddr = algosdk.getApplicationAddress(PEX_APPS.orderOps).toString();
  // The take-profit is the first linked child: base + 1. The SDK stamps that id
  // into the escrow and storage notes, so it is checkable rather than assumed.
  const childOrderId = shownTp.baseOrderId + BigInt(1);
  const escrow = transfers.find((t) => big(t.assetTransfer!.amount) !== shownOpen.collateralAmountMicro);
  if (!escrow) {
    fail("keeper_escrow_missing", "no keeper-fee escrow transfer found");
  } else {
    const x = escrow.assetTransfer!;
    const amt = big(x.amount);
    if (amt !== shownTp.keeperFeeMicro) {
      fail("keeper_escrow_amount", `escrow ${amt}, displayed ${shownTp.keeperFeeMicro}`);
    }
    // Receiver and asset were BOTH unbound here while the collateral leg beside
    // them was fully checked. An escrow redirected to an attacker passed, and so
    // did one whose asset had been swapped — 100,000 units of an arbitrary ASA
    // is not $0.10, and for a low-decimal asset it is arbitrary value.
    if (String(x.receiver) !== orderOpsAddr) {
      fail("keeper_escrow_receiver", "keeper-fee escrow does not go to the pinned OrderOps address");
    }
    if (Number(x.assetIndex) !== shownOpen.collateralAssetId) {
      fail("keeper_escrow_asset", `keeper-fee escrow asset ${x.assetIndex}, expected ${shownOpen.collateralAssetId}`);
    }
    // The absolute cap is the control and it is read from config, never accepted
    // from the caller. A ratio alone is not a control: both sides of a ratio come
    // from the frontend, so displaying $400 and escrowing $800 would pass.
    const absoluteCap = BigInt(Math.round(MAX_KEEPER_FEE_ESCROW_USDC * 1e6));
    if (amt > absoluteCap) {
      fail("keeper_escrow_cap", `escrow ${amt} exceeds the absolute cap ${absoluteCap}`);
    }
    if (amt === BigInt(0)) fail("keeper_escrow_zero", "keeper fee is zero; the order would never be executed");
    // Bound to THIS bracket's child order id, not merely to the marker shape.
    // A well-formed note naming a different order is a leg from another bracket.
    if (noteText(escrow) !== `pdex-v2-linked-escrow-${childOrderId}`) {
      fail("escrow_note", `escrow note "${noteText(escrow)}", expected pdex-v2-linked-escrow-${childOrderId}`);
    }
  }
  did("keeper-fee escrow: amount, receiver, asset, absolute cap, non-zero, linked note");

  // ── Payments ─────────────────────────────────────────────────────────────
  //
  // One when the escrow is already funded (the order-box MBR to OrderOps), two
  // when it is not (an escrow payment to Trading, first). They go to different
  // apps for different amounts, so each is found by its receiver rather than by
  // position — a group that reordered them must not slip through.
  const tradingAddr = algosdk.getApplicationAddress(PEX_APPS.trading).toString();
  const payments = txns.filter((t) => t.payment);
  const expectedPayments = fundsStorage ? 2 : 1;
  if (payments.length !== expectedPayments) {
    fail("mbr_count", `expected ${expectedPayments} payment(s), found ${payments.length}`);
  }

  if (fundsStorage) {
    const storagePay = payments.find((t) => String(t.payment!.receiver) === tradingAddr);
    if (!storagePay) {
      fail("storage_payment_missing", "no storage escrow payment to the pinned Trading app address");
    } else if (big(storagePay.payment!.amount) !== shownOpen.storagePaymentMicro) {
      fail("storage_payment_amount",
        `storage payment ${storagePay.payment!.amount}, displayed ${shownOpen.storagePaymentMicro}`);
    }
    // And against the PINNED constants, not only against the caller's number.
    //
    // Equality with `shownOpen.storagePaymentMicro` alone proves the group
    // matches whatever `openPosition` computed — it cannot notice
    // `openPosition` computing the wrong thing, and a tamper that moved both
    // together passed. Every other value-moving leg has an anchor outside the
    // caller: the collateral against a figure the card renders, the keeper
    // escrow against MAX_KEEPER_FEE_ESCROW_USDC, the order-box MBR against
    // ORDER_BOX_MBR_MICRO_ALGO. This one had none.
    const amt = storagePay ? big(storagePay.payment!.amount) : BigInt(0);
    if (amt !== STORAGE_ESCROW_MICRO_ALGO && amt !== POSITION_BOX_MBR_MICRO_ALGO) {
      fail("storage_payment_unpinned",
        `storage payment ${amt} is neither ${STORAGE_ESCROW_MICRO_ALGO} (first trade) nor ${POSITION_BOX_MBR_MICRO_ALGO} (top-up)`);
    }
    // And the call it pays for: `fund_storage` on Trading, the group's first
    // Trading call. Binding the payment without binding what consumes it would
    // leave an unattached payment to a correct address.
    const tradingCalls = txns.filter((t) => Number(t.applicationCall?.appIndex) === PEX_APPS.trading);
    const fundCall = tradingCalls.find(
      (t) => hex((t.applicationCall!.appArgs ?? [])[0] ?? new Uint8Array()) === PEX_SELECTORS.fundStorage,
    );
    if (!fundCall) {
      fail("fund_storage_missing", "storage is paid for but no Trading fund_storage call is present");
    }
  }
  did(fundsStorage ? "storage escrow: payment amount, receiver, and its fund_storage call" : "no storage payment expected");

  const mbr = payments.filter((t) => String(t.payment!.receiver) !== tradingAddr);
  if (mbr.length !== 1) {
    fail("mbr_count", `expected 1 order-box MBR payment, found ${mbr.length}`);
  } else {
    const pay = mbr[0].payment!;
    if (big(pay.amount) !== ORDER_BOX_MBR_MICRO_ALGO) {
      fail("order_box_mbr", `storage payment ${pay.amount}, expected ${ORDER_BOX_MBR_MICRO_ALGO}`);
    }
    // The receiver was unbound: the payment could be redirected while the amount
    // still matched. Small per trade, but it rides inside a group the user has
    // been told was verified.
    if (String(pay.receiver) !== orderOpsAddr) {
      fail("mbr_receiver", "order-box MBR does not go to the pinned OrderOps address");
    }
    if (noteText(mbr[0]) !== `pdex-v2-linked-storage-${childOrderId}`) {
      fail("mbr_note", `storage note "${noteText(mbr[0])}", expected pdex-v2-linked-storage-${childOrderId}`);
    }
  }
  did("order-box MBR: amount, receiver, linked note");

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
  // ...and the displayed TP size must equal the position being opened. Without
  // this the two are only checked against each other, so a take-profit sized at
  // 1% of the position asserts clean — and the card never displays the TP size,
  // so there is no "what was shown" to catch it. Take-profit is the only exit.
  if (shownTp.sizeUsdDeltaMicro !== shownOpen.sizeUsdDeltaMicro) {
    fail("tp_size_mismatch",
      `take-profit covers ${shownTp.sizeUsdDeltaMicro} of a ${shownOpen.sizeUsdDeltaMicro} position`);
  }
  if (u64(A[8]) !== BigInt(0)) fail("tp_collateral_amount", `collateralAmount ${u64(A[8])}, expected 0`);
  did("TP identity: order id, kind, target, market, side, asset, size");

  // Show $0.12, submit $0.40 — never fires, user believes they are protected.
  if (u64(A[9]) !== shownTp.triggerPrice12) {
    fail("trigger_price", `trigger ${u64(A[9])}, screen showed ${shownTp.triggerPrice12}`);
  }
  did("triggerPrice equals the displayed target exactly");

  // The SDK checks only the side of this, never the distance.
  // Direction matters and an absolute distance cannot see it. This check used
  // Math.abs, which meant the assertion module could not catch a take-profit
  // priced on the wrong side of its own trigger — the exact defect that made
  // every group unbuildable. A close inverts relative to an open.
  const tpAccept = u64(A[10]);
  const tpBound = acceptableWithin(
    tpAccept, shownTp.triggerPrice12, shownOpen.side, shownTp.slippageBps, "closing",
  );
  if (!tpBound.ok) fail("tp_slippage", `take-profit ${tpBound.why}`);
  // Equality against the displayed value, not only the directional bound.
  //
  // `DisplayedTakeProfit.acceptablePrice12` was declared and documented and
  // never read, so the TP leg was held only to "somewhere inside the slippage
  // band around the trigger" while the open leg got both this and the bound.
  // The slack is the full band: on a $772 short close that is up to $3.86 of
  // worse fill, inside a group the user was told had been verified.
  if (tpAccept !== shownTp.acceptablePrice12) {
    fail("tp_acceptable_price", `arg ${tpAccept}, displayed ${shownTp.acceptablePrice12}`);
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
  // GTC is 1. This check used to demand 0 and so agreed with B6 rather than
  // catching it — an assertion is only worth what its expected value is worth.
  if (tail.timeInForce !== BigInt(TAKE_PROFIT_TIME_IN_FORCE)) {
    fail("time_in_force", `timeInForce ${tail.timeInForce}, expected GTC (${TAKE_PROFIT_TIME_IN_FORCE})`);
  }
  if (tail.expiryTime !== BigInt(0)) fail("expiry_time", `expiryTime ${tail.expiryTime}, expected 0`);
  if (tail.linkMode !== ORDER_LINK_MODE_CHILD_ACTIVE) fail("link_mode", `linkMode ${tail.linkMode}, expected child-active`);
  if (tail.linkBaseOrderId !== shownTp.baseOrderId) {
    fail("link_base_order_id", `linkBaseOrderId ${tail.linkBaseOrderId}, expected ${shownTp.baseOrderId}`);
  }
  did("GTC, no expiry, link mode and base order id");

  // The binding pair. On a same-group open the position does not exist yet, so
  // expectedPositionId is 0 and the offset points back at the entry. Measured on
  // a real group: the offset is the distance between the two transactions.
  // By selector again: with a storage prefix the first Trading call is
  // `fund_storage`, and measuring the offset from it is off by two.
  const openIdx = txns.findIndex(
    (t) => t.applicationCall && Number(t.applicationCall.appIndex) === PEX_APPS.trading
      && hex((t.applicationCall.appArgs ?? [])[0] ?? new Uint8Array()) === PEX_SELECTORS.openOrIncrease,
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

  // Against the CHILD's payload, not the open leg's. This check used to compare
  // with `shownOpen.oracleMessage`, which meant it actively enforced the second
  // half of B6 — the assertion agreed with the bug, exactly as the timeInForce
  // check did. Two of our own controls were holding the defect in place.
  if (!tail.oracleMessage || !sameBytes(tail.oracleMessage, shownTp.oracleMessage)) {
    fail("tp_oracle_message", "TP oracle message is not the verified child payload bytes");
  }
  if (!tail.oracleSignature || !sameBytes(tail.oracleSignature, shownTp.oracleSignature)) {
    fail("tp_oracle_signature", "TP oracle signature is not the verified child signature bytes");
  }
  // And bind the target directly, from the SIGNED bytes.
  //
  // Byte-equality with what the client fetched only proves the group matches the
  // client; it cannot notice the client fetching the wrong payload, which is the
  // mistake that actually happened. The signed message carries the app it may be
  // presented to at offset 37 — read it and require OrderOps.
  if (tail.oracleMessage && tail.oracleMessage.length >= ORACLE_TARGET_APP_OFFSET + 8) {
    const view = new DataView(
      tail.oracleMessage.buffer, tail.oracleMessage.byteOffset, tail.oracleMessage.byteLength);
    const target = view.getBigUint64(ORACLE_TARGET_APP_OFFSET, false);
    if (target !== BigInt(PEX_APPS.orderOps)) {
      fail("tp_oracle_target",
        `TP oracle payload is bound to app ${target}, expected OrderOps (${PEX_APPS.orderOps})`);
    }
  }
  // The open leg's payload must equally be Trading's, and must NOT be the child's.
  if (shownOpen.oracleMessage.length >= ORACLE_TARGET_APP_OFFSET + 8) {
    const view = new DataView(
      shownOpen.oracleMessage.buffer, shownOpen.oracleMessage.byteOffset, shownOpen.oracleMessage.byteLength);
    const target = view.getBigUint64(ORACLE_TARGET_APP_OFFSET, false);
    if (target !== BigInt(PEX_APPS.trading)) {
      fail("open_oracle_target",
        `entry oracle payload is bound to app ${target}, expected Trading (${PEX_APPS.trading})`);
    }
  }
  did("TP and entry oracle payloads are the verified bytes, each bound to its own app");

  return { ok: findings.length === 0, findings, checked };
}

// ── Limit entries ───────────────────────────────────────────────────────────

/** What the card showed for a limit entry, checked against what was built. */
export type DisplayedLimit = {
  sender: string;
  marketId: number;
  side: 1 | 2;
  collateralAssetId: number;
  /** Stake, micro-units. Escrowed with the keeper fee in ONE transfer. */
  collateralAmountMicro: bigint;
  sizeUsdDeltaMicro: bigint;
  /** The price the order waits for. Shown to the user; compared exactly. */
  triggerPrice12: bigint;
  /** Worst fill the order will accept, bounded against the TRIGGER. */
  acceptablePrice12: bigint;
  keeperFeeMicro: bigint;
  baseOrderId: bigint;
  slippageBps: number;
  /** OrderOps-targeted payload — the whole group presents to OrderOps. */
  oracleMessage: Uint8Array;
  oracleSignature: Uint8Array;
};

/**
 * Assert a limit-entry group, with or without an attached take-profit.
 *
 * ── Why this is not `assertOpenGroup` with a different shape ────────────────
 * A market open presents to **Trading** and moves collateral into a position
 * that exists the moment it confirms. A limit entry presents to **OrderOps**
 * and creates nothing but a box: the money sits in escrow until a keeper acts,
 * which may be never. So the checks differ in kind, not degree —
 * there is no entry price, no liquidation price and no position to bind to.
 *
 * ── What is bounded against what ────────────────────────────────────────────
 * The acceptable price is bounded against the **trigger**, not the index. The
 * index at signing time is irrelevant to an order that fills later; bounding
 * against it would accept a fill arbitrarily far from the price the user chose.
 *
 * ── The leg that carries an attack no transfer check can see ────────────────
 * The builder tuple, exactly as on the take-profit child: the trailing tuple
 * carries its own `builderAddress` and `builderFeeBps`, and a leg-level value
 * overrides the parent's. Pointed at an attacker it takes bps of notional from
 * inside PEX with no transfer in our group at all.
 */
export function assertOpenLimitGroup(
  txnsIn: unknown[],
  shown: DisplayedLimit,
  shownTp?: DisplayedTakeProfit,
): GroupAssertion {
  const txns = txnsIn.map((t) => ((t as { txn?: AnyTxn }).txn ?? t) as AnyTxn);
  const findings: GroupFinding[] = [];
  const checked: string[] = [];
  const fail = (code: string, detail: string) => findings.push({ code, detail });
  const did = (n: string) => checked.push(n);
  const shape = shownTp ? SHAPE_OPEN_LIMIT_TP : SHAPE_OPEN_LIMIT;

  checkTxnShape(txns, shape, fail, did);
  checkCallBudget(txns, fail, shape);
  // The shared hardening: every sender is the user, no rekey/close/clawback,
  // no foreign assets. Identical stakes to the market path, so identical check.
  checkEveryTransaction(txns, { sender: shown.sender, collateralAssetId: shown.collateralAssetId }, fail, did);
  checkMathCarriers(txns, fail, did);

  const orderOpsAddr = algosdk.getApplicationAddress(PEX_APPS.orderOps).toString();

  // ── The escrow transfer ───────────────────────────────────────────────────
  //
  // ONE transfer carrying collateral AND keeper fee. That is a real difference
  // from the market path, where they are two transfers, and it means the amount
  // must be checked as a sum rather than matched against the stake alone.
  const transfers = txns.filter((t) => t.assetTransfer);
  const expectedEscrow = shown.collateralAmountMicro + shown.keeperFeeMicro;
  const entryTransfer = transfers.find((t) => big(t.assetTransfer!.amount) === expectedEscrow);
  if (!entryTransfer) {
    fail("limit_escrow_missing",
      `no transfer of ${expectedEscrow} (stake ${shown.collateralAmountMicro} + keeper ${shown.keeperFeeMicro})`);
  } else {
    const x = entryTransfer.assetTransfer!;
    if (String(x.receiver) !== orderOpsAddr) {
      fail("limit_escrow_receiver", "limit escrow does not go to the pinned OrderOps address");
    }
    if (Number(x.assetIndex) !== shown.collateralAssetId) {
      fail("limit_escrow_asset", `escrow asset ${x.assetIndex}, expected ${shown.collateralAssetId}`);
    }
    const cap = BigInt(Math.round(MAX_KEEPER_FEE_ESCROW_USDC * 1e6));
    if (shown.keeperFeeMicro > cap) {
      fail("limit_keeper_cap", `keeper fee ${shown.keeperFeeMicro} exceeds the cap ${cap}`);
    }
    if (shown.keeperFeeMicro === BigInt(0)) {
      fail("limit_keeper_zero", "keeper fee is zero; the order would never be executed");
    }
  }
  did("limit escrow: stake + keeper fee, receiver, asset, keeper cap, non-zero");

  // ── The order-box MBR ────────────────────────────────────────────────────
  //
  // A limit parent pays 100,200; an attached child pays 99,700. Different
  // constants, asserted separately — one constant for both fails a correct group.
  const payments = txns.filter((t) => t.payment);
  const parentMbr = payments.find((t) => big(t.payment!.amount) === LIMIT_ORDER_BOX_MBR_MICRO_ALGO);
  if (!parentMbr) {
    fail("limit_mbr_missing", `no payment of ${LIMIT_ORDER_BOX_MBR_MICRO_ALGO} for the entry order box`);
  } else if (String(parentMbr.payment!.receiver) !== orderOpsAddr) {
    fail("limit_mbr_receiver", "entry order-box MBR does not go to the pinned OrderOps address");
  }
  if (shownTp) {
    const childMbr = payments.find((t) => big(t.payment!.amount) === ORDER_BOX_MBR_MICRO_ALGO);
    if (!childMbr) {
      fail("child_mbr_missing", `no payment of ${ORDER_BOX_MBR_MICRO_ALGO} for the child order box`);
    } else if (String(childMbr.payment!.receiver) !== orderOpsAddr) {
      fail("child_mbr_receiver", "child order-box MBR does not go to the pinned OrderOps address");
    }
  }
  did("order-box MBR: exact amount per leg, to OrderOps");

  // ── The entry order's own arguments ──────────────────────────────────────
  const submits = txns.filter((t) => t.applicationCall
    && Number(t.applicationCall.appIndex) === PEX_APPS.orderOps
    && hex((t.applicationCall.appArgs ?? [])[0] ?? new Uint8Array()) === PEX_SELECTORS.submitLinkedOrder);
  if (submits.length !== (shownTp ? 2 : 1)) {
    fail("limit_submit_count", `expected ${shownTp ? 2 : 1} submit_linked_order call(s), found ${submits.length}`);
    return { ok: findings.length === 0, findings, checked };
  }

  // The ENTRY is the one declaring OPEN_LIMIT. Found by its kind rather than by
  // position, so a reordered group cannot make the child be read as the entry.
  const u64 = (b?: Uint8Array) => (b ? algosdk.decodeUint64(b, "bigint") : BigInt(-1));
  const entry = submits.find((t) => u64((t.applicationCall!.appArgs ?? [])[1]) === ORDER_KIND_OPEN_LIMIT);
  if (!entry) {
    fail("limit_entry_missing", "no submit_linked_order declares orderKind OPEN_LIMIT");
    return { ok: false, findings, checked };
  }
  const A = entry.applicationCall!.appArgs ?? [];

  if (u64(A[3]) !== BigInt(shown.marketId)) fail("limit_market", `marketId ${u64(A[3])}, displayed ${shown.marketId}`);
  if (u64(A[4]) !== shown.baseOrderId) fail("limit_order_id", `ownerOrderId ${u64(A[4])}, allocated ${shown.baseOrderId}`);
  if (u64(A[5]) !== BigInt(shown.side)) fail("limit_side", `side ${u64(A[5])}, displayed ${shown.side}`);
  if (u64(A[6]) !== BigInt(shown.collateralAssetId)) fail("limit_collateral_asset", `collateralAssetId ${u64(A[6])}`);
  if (u64(A[7]) !== shown.sizeUsdDeltaMicro) fail("limit_size", `sizeUsdDelta ${u64(A[7])}, displayed ${shown.sizeUsdDeltaMicro}`);
  if (u64(A[8]) !== shown.collateralAmountMicro) fail("limit_collateral", `collateralAmount ${u64(A[8])}, displayed ${shown.collateralAmountMicro}`);
  // The price the user actually chose. Shown, so compared exactly.
  if (u64(A[9]) !== shown.triggerPrice12) fail("limit_trigger", `triggerPrice ${u64(A[9])}, displayed ${shown.triggerPrice12}`);
  const accept = u64(A[10]);
  if (accept !== shown.acceptablePrice12) {
    fail("limit_acceptable_price", `acceptablePrice ${accept}, displayed ${shown.acceptablePrice12}`);
  }
  // Bounded against the TRIGGER, not the index — see the header.
  const bound = acceptableWithin(accept, shown.triggerPrice12, shown.side, shown.slippageBps, "opening");
  if (!bound.ok) fail("limit_slippage", `limit entry ${bound.why}`);
  if (u64(A[11]) !== BigInt(shown.collateralAssetId)) fail("limit_keeper_asset", `keeperFeeAssetId ${u64(A[11])}`);
  if (u64(A[12]) !== shown.keeperFeeMicro) fail("limit_keeper_arg", `keeperFeeAmount ${u64(A[12])}, displayed ${shown.keeperFeeMicro}`);
  if (u64(A[13]) !== BigInt(0)) fail("limit_swap_mode", `outputSwapMode ${u64(A[13])}, expected 0`);
  if (u64(A[14]) !== BigInt(0)) fail("limit_min_primary", `minPrimary ${u64(A[14])}, expected 0`);
  did("entry order: market, id, side, asset, size, stake, trigger, acceptable, keeper fee, swap mode");

  const tail = decodeLinkedTail(A[15]);
  if (!tail) {
    fail("limit_tail_decode", "could not decode the entry's packed trailing tuple");
    return { ok: false, findings, checked };
  }
  if (tail.minSecondary !== BigInt(0)) fail("limit_min_secondary", `minSecondary ${tail.minSecondary}`);
  if (tail.timeInForce !== BigInt(TAKE_PROFIT_TIME_IN_FORCE)) {
    fail("limit_time_in_force", `timeInForce ${tail.timeInForce}, expected GTC (${TAKE_PROFIT_TIME_IN_FORCE})`);
  }
  // Zero means good-till-cancelled. Every order observed on chain carries 0, and
  // a non-zero expiry the user was never shown is an order that quietly dies.
  if (tail.expiryTime !== BigInt(0)) fail("limit_expiry", `expiryTime ${tail.expiryTime}, expected 0`);
  if (tail.linkMode !== ORDER_LINK_MODE_BRACKET_PARENT) {
    fail("limit_link_mode", `linkMode ${tail.linkMode}, expected bracket-parent (${ORDER_LINK_MODE_BRACKET_PARENT})`);
  }
  if (tail.linkBaseOrderId !== shown.baseOrderId) {
    fail("limit_link_base", `linkBaseOrderId ${tail.linkBaseOrderId}, expected ${shown.baseOrderId}`);
  }
  // No position exists yet and none may be claimed.
  if (tail.expectedPositionId !== BigInt(0)) {
    fail("limit_expected_position", `expectedPositionId ${tail.expectedPositionId}, expected 0`);
  }
  // The attack no transfer check can see.
  if (tail.builderAddress !== BUILDER_ADDRESS) {
    fail("limit_builder_address", `builder ${tail.builderAddress}, expected ${BUILDER_ADDRESS}`);
  }
  if (tail.builderFeeBps !== BigInt(POSITION_BUILDER_FEE_BPS)) {
    fail("limit_builder_fee", `builderFeeBps ${tail.builderFeeBps}, expected ${POSITION_BUILDER_FEE_BPS}`);
  }
  if (!tail.oracleMessage || !sameBytes(tail.oracleMessage, shown.oracleMessage)) {
    fail("limit_oracle_message", "entry carries a different oracle message than the one displayed");
  }
  if (!tail.oracleSignature || !sameBytes(tail.oracleSignature, shown.oracleSignature)) {
    fail("limit_oracle_signature", "entry carries a different oracle signature than the one displayed");
  }
  did("entry tail: GTC, no expiry, bracket-parent, base id, no claimed position, builder tuple, oracle payload");

  // ── The attached child, when there is one ────────────────────────────────
  if (shownTp) {
    const child = submits.find((t) => t !== entry);
    const C = child!.applicationCall!.appArgs ?? [];
    if (u64(C[9]) !== shownTp.triggerPrice12) {
      fail("tp_trigger", `take-profit trigger ${u64(C[9])}, displayed ${shownTp.triggerPrice12}`);
    }
    if (u64(C[10]) !== shownTp.acceptablePrice12) {
      fail("tp_acceptable_price", `take-profit acceptable ${u64(C[10])}, displayed ${shownTp.acceptablePrice12}`);
    }
    if (u64(C[7]) !== shownTp.sizeUsdDeltaMicro) {
      fail("tp_size", `take-profit size ${u64(C[7])}, displayed ${shownTp.sizeUsdDeltaMicro}`);
    }
    const ctail = decodeLinkedTail(C[15]);
    if (!ctail) {
      fail("tp_tail_decode", "could not decode the child's packed trailing tuple");
    } else {
      // **CHILD_WAIT_PARENT, not CHILD_ACTIVE.** The entry has not filled, so
      // there is no position to arm against — the child activates only when the
      // keeper executes the parent. Demanding CHILD_ACTIVE here would fail every
      // correct un-crossed limit bracket, which is the shape of B6 in reverse.
      if (ctail.linkMode !== ORDER_LINK_MODE_CHILD_WAIT_PARENT
        && ctail.linkMode !== ORDER_LINK_MODE_CHILD_ACTIVE) {
        fail("tp_link_mode", `child linkMode ${ctail.linkMode}, expected wait-parent or child-active`);
      }
      if (ctail.linkBaseOrderId !== shown.baseOrderId) {
        fail("tp_link_base", `child linkBaseOrderId ${ctail.linkBaseOrderId}, expected ${shown.baseOrderId}`);
      }
      if (ctail.builderAddress !== BUILDER_ADDRESS) {
        fail("tp_builder_address", `child builder ${ctail.builderAddress}, expected ${BUILDER_ADDRESS}`);
      }
      if (ctail.builderFeeBps !== BigInt(POSITION_BUILDER_FEE_BPS)) {
        fail("tp_builder_fee", `child builderFeeBps ${ctail.builderFeeBps}`);
      }
    }
    did("attached take-profit: trigger, acceptable, size, link mode, base id, builder tuple");
  }

  return { ok: findings.length === 0, findings, checked };
}

/** What the user was told they were cancelling. */
export type DisplayedCancel = {
  sender: string;
  /** The order the UI named. Compared exactly against the arg. */
  ownerOrderId: bigint;
  /** Attached child ids, when cancelling a bracket. */
  attachedOrderIds: bigint[];
  collateralAssetId: number;
};

/**
 * Assert a cancel group.
 *
 * ── What can actually go wrong here ─────────────────────────────────────────
 * Cancelling moves nothing out of the wallet — every refund is an inner
 * transaction — so the usual asset-movement checks have nothing to compare.
 * The two real hazards are different:
 *
 * 1. **Cancelling the wrong order.** `cancel_order` takes one uint64 and the
 *    contract derives the box from the SENDER, so a group that names a
 *    different id cancels a different order of the user's own — plausibly the
 *    take-profit protecting a live position rather than the resting entry they
 *    clicked on. Nothing on chain distinguishes those; only this check does.
 * 2. **Something outbound smuggled into a group the user approves as "cancel".**
 *    A cancel prompt is the most benign-looking signature this product asks
 *    for, which makes it the best place to hide a transfer. The shape forbids
 *    every axfer and every pay, so there is nothing to hide behind.
 */
export function assertCancelGroup(
  txnsIn: unknown[], shown: DisplayedCancel,
): GroupAssertion {
  const txns = txnsIn.map((t) => ((t as { txn?: AnyTxn }).txn ?? t) as AnyTxn);
  const findings: GroupFinding[] = [];
  const checked: string[] = [];
  const fail = (code: string, detail: string) => findings.push({ code, detail });
  const did = (n: string) => checked.push(n);
  const shape = shown.attachedOrderIds.length > 0 ? SHAPE_CANCEL_BRACKET : SHAPE_CANCEL;

  checkTxnShape(txns, shape, fail, did);
  checkCallBudget(txns, fail, shape);
  checkEveryTransaction(txns, { sender: shown.sender, collateralAssetId: shown.collateralAssetId }, fail, did);
  checkMathCarriers(txns, fail, did);

  const calls = txns.filter((t) => t.applicationCall
    && Number(t.applicationCall.appIndex) === PEX_APPS.orderOps);
  if (calls.length !== 1) {
    fail("cancel_call_count", `expected 1 OrderOps call, found ${calls.length}`);
    return { ok: false, findings, checked };
  }
  const A = calls[0].applicationCall!.appArgs ?? [];
  if (hex(A[0] ?? new Uint8Array()) !== PEX_SELECTORS.cancelOrder) {
    fail("cancel_selector", `OrderOps call is not cancel_order (${hex(A[0] ?? new Uint8Array())})`);
  }
  if (A.length !== 2) {
    fail("cancel_arg_count", `cancel_order carries ${A.length} arg(s), expected 2`);
  }
  const id = A[1] ? algosdk.decodeUint64(A[1], "bigint") : BigInt(-1);
  if (id !== shown.ownerOrderId) {
    fail("cancel_order_id", `group cancels order ${id}, the screen said ${shown.ownerOrderId}`);
  }
  did("cancel_order selector and the exact order id the screen named");

  // Every box this touches must be an `o2:` box belonging to the USER, and must
  // be one of the ids they were shown. A box for someone else's order would be
  // refused on chain, but a box for a DIFFERENT order of their own would not.
  const expected = new Set([shown.ownerOrderId, ...shown.attachedOrderIds].map(String));
  const pk = algosdk.decodeAddress(shown.sender).publicKey;
  for (const t of txns) {
    for (const b of (t.applicationCall?.boxes ?? []) as { name?: Uint8Array }[]) {
      const name = b.name as Uint8Array;
      if (!name || name.length === 0) continue;
      if (name.length !== 43) {
        fail("cancel_box_shape", `box reference is ${name.length} bytes, expected a 43-byte o2: key`);
        continue;
      }
      if (String.fromCharCode(...Array.from(name.slice(0, 3))) !== "o2:") {
        fail("cancel_box_prefix", "cancel names a box that is not an order box");
        continue;
      }
      if (!sameBytes(name.slice(3, 35), pk)) {
        fail("cancel_box_owner", "cancel names an order box belonging to another account");
        continue;
      }
      const boxId = algosdk.decodeUint64(name.slice(35, 43), "bigint");
      if (!expected.has(String(boxId))) {
        fail("cancel_box_id", `cancel names order ${boxId}, which the screen did not mention`);
      }
    }
  }
  did("every order box named is the user's own, and one the screen named");

  return { ok: findings.length === 0, findings, checked };
}
