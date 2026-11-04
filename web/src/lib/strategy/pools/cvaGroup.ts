/**
 * Building and asserting a C-Vault group.
 *
 * The same four stages as the direct pools — plan/quote, build, assert,
 * simulate — with two differences that come from the vault itself:
 *
 * **1. A mark preamble.** The vault asserts `gm2:[40..48] == global Round`,
 * exact equality, plus a verified `mark_market` leg for each funded allocation
 * in the SAME group (`cva.teal:5160-5205`). Waiting cannot satisfy that: the
 * mark has to land in the same block as the action. Measured live, the vault's
 * NAV ran 36-257 rounds stale against a 5-round window, so this is the normal
 * case rather than an edge one. The SDK assembles the preamble when it is given
 * `activeMarketIds` + `activeMarketOracles`.
 *
 * **2. A route.** A withdrawal comes out of idle balance or unwinds a market
 * allocation. The vault holds ~$0.004 idle, so in practice every exit is a
 * market unwind. `planV2CvaWithdraw` picks, and the registry it needs is
 * per-market — so the route and the registry must be chosen together.
 *
 * Everything else is the pools' discipline unchanged: the figures and the floors
 * come from the contract's own simulated receipt, never from a quote, and the
 * finished bytes are asserted against what was displayed.
 */

import algosdk from "algosdk";
import {
  planV2CvaWithdraw,
  buildV2CvaDepositTransactions,
  buildV2CvaWithdrawFromMarketTransactions,
  buildV2CvaWithdrawTransactions,
  V2_CVA_USER_BOX_MBR_MICRO_ALGO,
} from "@pdex/sdk";
import { PEX_APPS, PEX_ASSETS, MIN_SIGNING_BUDGET_SEC } from "@/lib/strategy/pex/config";
import {
  checkEveryTransaction, checkMathCarriers, abiBytes, simulateGroup,
  type AnyTxn, type GroupAssertion, type GroupFinding,
} from "@/lib/strategy/pex/group";
import {
  receiptFromLogs, withTolerance, type LiquidityReceipt, type Stage,
} from "./group";
import {
  planStateSnapshot, planResources, planOraclePayload, oracleBudgetSec,
  type CvaSnapshot,
} from "./cvaSnapshot";

// ── Selectors, each verified against the vendored manifest ───────────────────
export const CVA_SELECTORS = {
  /** `deposit(txn,txn,pay,uint64,byte[],byte[])byte[]` */
  deposit: "b2eea014",
  /** `withdraw(uint64,uint64,uint64,byte[],byte[])byte[]` — the idle route. */
  withdraw: "e8e9f32d",
  /** `withdraw_from_market(uint64,uint64,uint64,uint64,byte[],byte[],uint64,uint64,uint64)byte[]` */
  withdrawFromMarket: "92ad0e57",
  /** `mark_market(uint64,byte[],byte[])byte[]` — the NAV preamble leg. */
  markMarket: "7eda6c29",
} as const;

/**
 * The `gu2:` box MBR a first-time C-Vault depositor pays.
 *
 * The same trap the direct pools had, in a different place: the direct pool's
 * `ml2:` box is 26,500 and this one is 32,900. A hardcoded zero there meant no
 * new depositor could deposit while every test passed, because every test used
 * a wallet that already held the box. Taken from the SDK's constant, and the
 * first-time case is tested explicitly rather than discovered.
 */
export const CVA_USER_BOX_MBR_MICRO_ALGO = BigInt(V2_CVA_USER_BOX_MBR_MICRO_ALGO);

export const cvaStoragePaymentFor = (hasPosition: boolean): bigint =>
  hasPosition ? BigInt(0) : CVA_USER_BOX_MBR_MICRO_ALGO;

/**
 * Apps a C-Vault group may call.
 *
 * Its own budget, like the pools'. The vault is called up to three times —
 * one action plus a `mark_market` per funded allocation — and the measured
 * preamble carried 2 marks and 5 Math carriers across 8 app calls.
 */
const CVA_CALL_BUDGET: ReadonlyArray<{ app: number; name: string; min: number; max: number }> = [
  { app: PEX_APPS.cvaVault, name: "C-Vault", min: 1, max: 5 },
  { app: PEX_APPS.markets, name: "Markets", min: 0, max: 2 },
  { app: PEX_APPS.math, name: "Math carrier", min: 0, max: 14 },
];
const CVA_CALLABLE = new Set(CVA_CALL_BUDGET.map((c) => c.app));

/**
 * Fee ceiling, µALGO.
 *
 * The planner reported 70,000 for a market withdrawal's descriptor, before the
 * group's own carriers. 250,000 keeps headroom over that without leaving a
 * skimmable margin; the carriers are separately asserted to be bare noops, so
 * the headroom cannot hide an operation.
 */
export const MAX_CVA_GROUP_FEE_MICRO_ALGO = 250_000;

const hex = (b: Uint8Array): string =>
  Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const u64 = (b: Uint8Array | undefined): bigint =>
  b && b.length === 8 ? new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0) : BigInt(-1);
const big = (v: bigint | number | undefined): bigint => BigInt(v ?? 0);
const normalise = (txnsIn: unknown[]): AnyTxn[] =>
  txnsIn.map((t) => ((t as { txn?: unknown }).txn ?? t) as AnyTxn);

// ── Route selection ──────────────────────────────────────────────────────────

export type CvaRoute = {
  routeType: "idle" | "single_market";
  /** 0 on the idle route. */
  marketId: number;
};

export class CvaRouteError extends Error {
  constructor(readonly code: string, readonly reasons: string[]) {
    super(
      code === "min_cva_withdraw"
        ? "That is below this vault's withdrawal minimum."
        : `PEX could not route this withdrawal (${code}).`,
    );
    this.name = "CvaRouteError";
  }
}

/**
 * Which route serves this withdrawal.
 *
 * Tries each active market with ITS OWN registry. A mismatched registry does
 * not fail cleanly — the planner throws "xALGO strategy is required for action
 * recall" — so a market is only attempted with the registry read for it.
 *
 * Measured on a $1,640 vault: a $757 exit (a holder's entire position) routes
 * through market 1 in one group, while market 2 tops out between $250 and $500.
 * So this picks a market that can serve the amount rather than assuming one can.
 */
export function chooseWithdrawRoute(
  snap: CvaSnapshot, sender: string, shareAmount: bigint,
  caps: { long: bigint; short: bigint },
): { route: CvaRoute; plan: Record<string, unknown> } {
  let lastCode = "no_eligible_cva_withdraw_source";
  let lastReasons: string[] = [];
  for (const marketId of snap.state.activeMarkets) {
    let plan: Record<string, unknown>;
    try {
      plan = planV2CvaWithdraw({
        sender,
        vaultId: PEX_APPS.cvaVault,
        shareAmount,
        stateSnapshot: planStateSnapshot(snap),
        resources: planResources(snap, marketId),
        preferredMarketId: marketId,
        yieldRecallMode: 1,
        maxLongReceiptAmount: caps.long,
        maxShortReceiptAmount: caps.short,
        oraclePayload: planOraclePayload(snap),
      }) as unknown as Record<string, unknown>;
    } catch (e) {
      // A throw here is a shape problem on our side, not a user-facing refusal.
      console.warn(`cva: planner threw for market ${marketId}`, e);
      lastCode = "planner_error";
      continue;
    }
    if (plan.ok) {
      const q = (plan.route as Record<string, unknown> | undefined)?.quote as
        Record<string, unknown> | undefined;
      return {
        route: {
          routeType: String(q?.route_type) === "idle" ? "idle" : "single_market",
          marketId,
        },
        plan,
      };
    }
    lastCode = String(plan.code ?? lastCode);
    const q = (plan.details as Record<string, unknown> | undefined)?.quote as
      Record<string, unknown> | undefined;
    if (Array.isArray(q?.failure_reasons)) lastReasons = q.failure_reasons.map(String);
  }
  throw new CvaRouteError(lastCode, lastReasons);
}

// ── What the UI showed ───────────────────────────────────────────────────────

export type DisplayedCvaDeposit = {
  sender: string;
  algoMicro: bigint;
  usdcMicro: bigint;
  minShares: bigint;
  storagePaymentMicro: bigint;
  /** Markets that must be marked in this group. */
  markMarkets: number[];
};

export type DisplayedCvaWithdraw = {
  sender: string;
  shareAmount: bigint;
  minAlgoMicro: bigint;
  minUsdcMicro: bigint;
  route: CvaRoute;
  maxLongReceipt: bigint;
  maxShortReceipt: bigint;
  markMarkets: number[];
  recall: { accounts: string[]; assets: number[]; apps: number[] };
};

function cvaShapeAndBudget(
  txns: AnyTxn[], expect: { pay: number; axfer: number },
  fail: (code: string, detail: string) => void, did: (n: string) => void,
): void {
  const counts: Record<string, number> = {};
  txns.forEach((t, i) => {
    const type = String(t.type ?? "");
    counts[type] = (counts[type] ?? 0) + 1;
    if (!["pay", "axfer", "appl"].includes(type)) {
      fail("txn_type", `txn ${i} is "${type || "typeless"}"`);
    }
  });
  if ((counts.pay ?? 0) !== expect.pay) {
    fail("pay_count", `expected ${expect.pay} payment(s), found ${counts.pay ?? 0}`);
  }
  if ((counts.axfer ?? 0) !== expect.axfer) {
    fail("axfer_count", `expected ${expect.axfer} transfer(s), found ${counts.axfer ?? 0}`);
  }
  const seen = new Map<number, number>();
  for (const t of txns) {
    if (!t.applicationCall) continue;
    const app = Number(t.applicationCall.appIndex);
    if (!CVA_CALLABLE.has(app)) {
      fail("unpinned_app", `group calls app ${app}, which this flow never uses`);
      continue;
    }
    seen.set(app, (seen.get(app) ?? 0) + 1);
  }
  for (const c of CVA_CALL_BUDGET) {
    const n = seen.get(c.app) ?? 0;
    if (n < c.min || n > c.max) {
      fail("call_budget", `${c.name} called ${n} times, expected ${c.min}..${c.max}`);
    }
  }
  did("every transaction is a type and an app this flow uses, in the expected counts");
}

/**
 * The mark preamble is exactly the markets we said it would be.
 *
 * Each `mark_market` moves no funds, but it writes the NAV the action is then
 * priced against — so an unexpected one, or a missing one, changes the price
 * the user gets. The count and the market ids are both pinned.
 */
function checkMarkPreamble(
  txns: AnyTxn[], expected: number[],
  fail: (code: string, detail: string) => void, did: (n: string) => void,
): void {
  const marks = txns.filter((t) =>
    Number(t.applicationCall?.appIndex) === PEX_APPS.cvaVault
    && hex((t.applicationCall?.appArgs ?? [])[0] ?? new Uint8Array()) === CVA_SELECTORS.markMarket);
  const ids = marks.map((t) => Number(u64((t.applicationCall?.appArgs ?? [])[1])));
  const want = [...expected].sort((a, b) => a - b);
  const got = [...ids].sort((a, b) => a - b);
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fail("mark_preamble", `group marks markets [${got.join(",")}], expected [${want.join(",")}]`);
    return;
  }
  did(`the group refreshes pricing for market${want.length === 1 ? "" : "s"} ${want.join(", ")} and no other`);
}

function oracleArgsMatch(
  msgArg: Uint8Array | undefined, sigArg: Uint8Array | undefined,
  message: Uint8Array, signature: Uint8Array,
  fail: (code: string, detail: string) => void, did: (n: string) => void,
): void {
  const m = msgArg ? abiBytes(msgArg) : null;
  const s = sigArg ? abiBytes(sigArg) : null;
  if (!m || hex(m) !== hex(message)) {
    fail("oracle_message", "the oracle price in the group is not the one that was verified and displayed");
    return;
  }
  if (!s || hex(s) !== hex(signature)) {
    fail("oracle_signature", "the oracle signature in the group is not the one that was verified");
    return;
  }
  did("the group carries exactly the oracle price we verified against the pinned PEX signer");
}

/** Assert a C-Vault DEPOSIT against what was displayed. */
export function assertCvaDepositGroup(
  txnsIn: unknown[], shown: DisplayedCvaDeposit, snap: CvaSnapshot,
): GroupAssertion {
  const txns = normalise(txnsIn);
  const findings: GroupFinding[] = [];
  const checked: string[] = [];
  const fail = (code: string, detail: string) => findings.push({ code, detail });
  const did = (name: string) => checked.push(name);

  // Two payments (the ALGO leg and the storage payment) plus one transfer, as
  // the measured group builds — the SDK emits all three even at zero.
  cvaShapeAndBudget(txns, { pay: 2, axfer: 1 }, fail, did);

  const totalFee = checkEveryTransaction(txns, {
    sender: shown.sender,
    collateralAssetId: PEX_ASSETS.usdc,
    allowApps: new Set<number>([PEX_APPS.cvaVault, PEX_APPS.markets, PEX_APPS.adminControl]),
  }, fail, did);
  if (totalFee > BigInt(MAX_CVA_GROUP_FEE_MICRO_ALGO)) {
    fail("fee_cap", `group fee ${totalFee} µALGO exceeds ${MAX_CVA_GROUP_FEE_MICRO_ALGO}`);
  } else {
    did(`group fee is within ${MAX_CVA_GROUP_FEE_MICRO_ALGO} µALGO`);
  }
  checkMathCarriers(txns, fail, did, { collateralAssetId: PEX_ASSETS.usdc });
  checkMarkPreamble(txns, shown.markMarkets, fail, did);

  const dest = algosdk.getApplicationAddress(PEX_APPS.cvaVault).toString();
  const pays = txns.filter((t) => t.type === "pay");
  const axfers = txns.filter((t) => t.type === "axfer");

  const algoLeg = pays.find((t) => big(t.payment?.amount) === shown.algoMicro);
  const storageLeg = pays.find((t) =>
    t !== algoLeg && big(t.payment?.amount) === shown.storagePaymentMicro);
  if (!algoLeg) {
    fail("algo_leg", `no payment of ${shown.algoMicro} µALGO; found `
      + `${pays.map((t) => big(t.payment?.amount)).join(", ")}`);
  }
  if (!storageLeg) {
    fail("storage_leg", `no payment of ${shown.storagePaymentMicro} µALGO for the account `
      + `record; found ${pays.map((t) => big(t.payment?.amount)).join(", ")}`);
  }
  for (const [name, leg] of [["algo_leg", algoLeg], ["storage_leg", storageLeg]] as const) {
    if (leg && String(leg.payment?.receiver) !== dest) {
      fail(`${name}_receiver`, `${name} pays ${String(leg.payment?.receiver).slice(0, 10)}…, not the vault`);
    }
  }
  if (algoLeg && storageLeg) {
    did(`ALGO leg is ${shown.algoMicro} µALGO and the account record `
      + `${shown.storagePaymentMicro} µALGO, both to the vault`);
  }

  if (axfers.length === 1) {
    const a = axfers[0];
    if (Number(a.assetTransfer?.assetIndex) !== PEX_ASSETS.usdc) {
      fail("usdc_asset", `the transfer leg moves asset ${a.assetTransfer?.assetIndex}, not USDC`);
    }
    if (big(a.assetTransfer?.amount) !== shown.usdcMicro) {
      fail("usdc_amount", `transfer is ${big(a.assetTransfer?.amount)} µUSDC, displayed ${shown.usdcMicro}`);
    }
    if (String(a.assetTransfer?.receiver) !== dest) {
      fail("usdc_receiver", `USDC leg pays ${String(a.assetTransfer?.receiver).slice(0, 10)}…, not the vault`);
    }
    did(`USDC leg is ${shown.usdcMicro} µUSDC to the vault`);
  }

  // The deposit call itself: selector, the share floor, and the oracle bytes.
  const calls = txns.filter((t) =>
    Number(t.applicationCall?.appIndex) === PEX_APPS.cvaVault
    && hex((t.applicationCall?.appArgs ?? [])[0] ?? new Uint8Array()) === CVA_SELECTORS.deposit);
  if (calls.length !== 1) {
    fail("deposit_calls", `expected exactly 1 vault deposit call, found ${calls.length}`);
  } else {
    const args = (calls[0].applicationCall?.appArgs ?? []) as Uint8Array[];
    if (args.length !== 4) {
      fail("deposit_args", `deposit call has ${args.length} args, expected 4`);
    } else {
      if (u64(args[1]) !== shown.minShares) {
        fail("min_shares", `minimum shares in the call is ${u64(args[1])}, displayed ${shown.minShares}`);
      }
      oracleArgsMatch(args[2], args[3], snap.oracle.message, snap.oracle.signature, fail, did);
      did(`the call mints no fewer than ${shown.minShares} vault shares`);
    }
  }
  return { ok: findings.length === 0, findings, checked };
}

/** Assert a C-Vault WITHDRAWAL against what was displayed. */
export function assertCvaWithdrawGroup(
  txnsIn: unknown[], shown: DisplayedCvaWithdraw, snap: CvaSnapshot,
): GroupAssertion {
  const txns = normalise(txnsIn);
  const findings: GroupFinding[] = [];
  const checked: string[] = [];
  const fail = (code: string, detail: string) => findings.push({ code, detail });
  const did = (name: string) => checked.push(name);

  // Nothing leaves the wallet: both sides arrive by inner transfer.
  cvaShapeAndBudget(txns, { pay: 0, axfer: 0 }, fail, did);

  const totalFee = checkEveryTransaction(txns, {
    sender: shown.sender,
    collateralAssetId: PEX_ASSETS.usdc,
    allowAccounts: new Set(shown.recall.accounts),
    allowAssets: new Set(shown.recall.assets),
    allowApps: new Set<number>([
      PEX_APPS.cvaVault, PEX_APPS.markets, PEX_APPS.adminControl, ...shown.recall.apps,
    ]),
  }, fail, did);
  if (totalFee > BigInt(MAX_CVA_GROUP_FEE_MICRO_ALGO)) {
    fail("fee_cap", `group fee ${totalFee} µALGO exceeds ${MAX_CVA_GROUP_FEE_MICRO_ALGO}`);
  } else {
    did(`group fee is within ${MAX_CVA_GROUP_FEE_MICRO_ALGO} µALGO`);
  }
  checkMathCarriers(txns, fail, did, {
    accounts: new Set(shown.recall.accounts),
    assets: new Set(shown.recall.assets),
    collateralAssetId: PEX_ASSETS.usdc,
  });
  did("the recall touches only the accounts, assets and apps our own registry names");
  checkMarkPreamble(txns, shown.markMarkets, fail, did);

  const selector = shown.route.routeType === "idle"
    ? CVA_SELECTORS.withdraw : CVA_SELECTORS.withdrawFromMarket;
  const calls = txns.filter((t) =>
    Number(t.applicationCall?.appIndex) === PEX_APPS.cvaVault
    && hex((t.applicationCall?.appArgs ?? [])[0] ?? new Uint8Array()) === selector);
  if (calls.length !== 1) {
    fail("withdraw_calls", `expected exactly 1 vault ${shown.route.routeType} withdrawal, found ${calls.length}`);
    return { ok: false, findings, checked };
  }
  const args = (calls[0].applicationCall?.appArgs ?? []) as Uint8Array[];

  if (shown.route.routeType === "single_market") {
    // withdraw_from_market(marketId, shareAmount, minLong, minShort, msg, sig,
    //                      recallMode, maxLongReceipt, maxShortReceipt)
    if (args.length !== 10) {
      fail("withdraw_args", `call has ${args.length} args, expected 10`);
      return { ok: false, findings, checked };
    }
    const pairs: Array<[string, bigint, bigint]> = [
      ["market_id", u64(args[1]), BigInt(shown.route.marketId)],
      ["share_amount", u64(args[2]), shown.shareAmount],
      ["min_algo", u64(args[3]), shown.minAlgoMicro],
      ["min_usdc", u64(args[4]), shown.minUsdcMicro],
      ["yield_recall_mode", u64(args[7]), BigInt(1)],
      ["max_long_receipt", u64(args[8]), shown.maxLongReceipt],
      ["max_short_receipt", u64(args[9]), shown.maxShortReceipt],
    ];
    for (const [name, got, want] of pairs) {
      if (got !== want) fail(name, `${name} in the call is ${got}, displayed ${want}`);
    }
    oracleArgsMatch(args[5], args[6], snap.oracle.message, snap.oracle.signature, fail, did);
    did(`the call burns exactly ${shown.shareAmount} vault shares via market ${shown.route.marketId}`);
  } else {
    // withdraw(shareAmount, minLong, minShort, msg, sig)
    if (args.length !== 6) {
      fail("withdraw_args", `call has ${args.length} args, expected 6`);
      return { ok: false, findings, checked };
    }
    const pairs: Array<[string, bigint, bigint]> = [
      ["share_amount", u64(args[1]), shown.shareAmount],
      ["min_algo", u64(args[2]), shown.minAlgoMicro],
      ["min_usdc", u64(args[3]), shown.minUsdcMicro],
    ];
    for (const [name, got, want] of pairs) {
      if (got !== want) fail(name, `${name} in the call is ${got}, displayed ${want}`);
    }
    oracleArgsMatch(args[4], args[5], snap.oracle.message, snap.oracle.signature, fail, did);
    did(`the call burns exactly ${shown.shareAmount} vault shares from idle balance`);
  }
  did(`payout floors are ${shown.minAlgoMicro} µALGO and ${shown.minUsdcMicro} µUSDC`);

  return { ok: findings.length === 0, findings, checked };
}

export type CvaBuildResult = {
  txns: algosdk.Transaction[];
  assertion: GroupAssertion;
  receipt: LiquidityReceipt;
  route?: CvaRoute;
  signingBudgetSec: number;
};

/** Exported for tests: the two market lists must not be conflated. */
export const refs = (snap: CvaSnapshot) => ({
  v2CvaVaultAppId: PEX_APPS.cvaVault,
  v2MarketsAppId: PEX_APPS.markets,
  v2MathAppId: PEX_APPS.math,
  v2AdminControlAppId: PEX_APPS.adminControl,
  longAssetId: PEX_ASSETS.algo,
  shortAssetId: PEX_ASSETS.usdc,
  indexAssetId: PEX_ASSETS.algo,
  /**
   * ── Two different lists, and conflating them broke every deposit ──
   * `activeMarketIds` drives the SDK's MARK CALLS. `activeAllocationMarketIds`
   * drives the BOX REFERENCES. We passed `state.activeMarkets` for both, which
   * is wrong on the mark side the moment a market is active but unfunded.
   *
   * The vault counts marks in `label145`: it reads each `gm2:` box and SKIPS
   * the market when `lp_share_amount` (offset 16) is zero. On 2026-11-03 PEX
   * rebalanced to 100% market 1, leaving market 2 active with 0 LP — so the
   * contract expected ONE mark while the SDK built two:
   *
   *     [0] mark(1)  [1] mark(2)  [2] long  [3] short  [4] storage  [5] deposit
   *     contract: base = GroupIndex - count - 3 = 5 - 1 - 3 = 1
   *     index 1 is mark(2); it asserts that market id == 1  -> pc 8526
   *
   * The box list must stay WIDE regardless: `label145` does `box_get; assert`
   * on every active market's allocation, including the unfunded one, so
   * narrowing both lists together would trade this failure for a missing-box
   * failure.
   */
  activeMarketIds: markMarketsFor(snap),
  activeAllocationMarketIds: snap.state.activeMarkets,
  activeMarketOracles: snap.activeMarketOracles,
  oracleMessage: snap.oracle.message,
  oracleSignature: snap.oracle.signature,
});

/** Markets the group must mark: active AND holding shares. */
/** `gm2:` + the market id, big-endian — the vault's allocation box key. */
export function gm2BoxName(marketId: number): Uint8Array {
  const out = new Uint8Array(12);
  out.set([0x67, 0x6d, 0x32, 0x3a], 0); // "gm2:"
  new DataView(out.buffer).setBigUint64(4, BigInt(marketId), false);
  return out;
}

/**
 * Declare every ACTIVE market's allocation box on a from-market withdrawal.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The SDK includes the allocation boxes on a from-market withdrawal only when
 * there are NO mark calls:
 *
 *     ...(activeMarkCalls.length ? [] : v2CvaActiveAllocationBoxes(...))
 *
 * assuming the marks carry them. Each mark declares only its OWN market's box.
 * `markMarketsFor` narrows marks to the FUNDED markets — which it must, or the
 * contract's mark-count arithmetic fails at pc=8526 — so an active-but-unfunded
 * market ends up referenced nowhere and `withdraw_from_market` dies at pc=7789
 * on `box_len`.
 *
 * `buildV2CvaDepositCall` and the idle `buildV2CvaWithdrawCall` include the
 * boxes unconditionally, so this is needed for the from-market path alone.
 *
 * ── Why the lists genuinely differ ──────────────────────────────────────────
 * Measured against MainNet, same wallet and share amount:
 *
 *     marks=[1]            -> pc 7789, invalid Box reference gm2:2
 *     marks=[1,2]          -> pc 8526, the deposit bug returns
 *     marks=[]             -> pc 8234, the funded mark is required
 *     marks=[1] + gm2:2    -> OK
 *
 * Exactly the funded markets get mark CALLS; every active market gets a box
 * REFERENCE. No single SDK input expresses that for this builder.
 *
 * ── What it is allowed to touch ─────────────────────────────────────────────
 * Only empty box slots, only on the call that already carries a `gm2:`
 * reference, and only with `gm2:` names for markets the snapshot calls active.
 * It throws rather than dropping a reference: a loud failure before signing
 * costs the user nothing, and a silent one puts us back at pc=7789.
 */
export function declareActiveAllocationBoxes(
  txns: algosdk.Transaction[], activeMarkets: readonly number[],
): algosdk.Transaction[] {
  const isGm2 = (n: Uint8Array) =>
    n.length === 12 && n[0] === 0x67 && n[1] === 0x6d && n[2] === 0x32 && n[3] === 0x3a;
  const vaultApp = BigInt(PEX_APPS.cvaVault);
  /**
   * A `gm2:` reference declared BY THE VAULT on itself.
   *
   * Both halves matter. `appIndex 0` means "the app being called", so a
   * `gm2:`-shaped name sitting at a non-zero index belongs to some other app
   * and must not be treated as ours — and we must not then write our own
   * reference at index 0 onto a transaction that is not the vault.
   */
  const ours = (t: algosdk.Transaction, b: algosdk.BoxReference) =>
    isGm2(b.name) && b.appIndex === BigInt(0)
    && t.applicationCall?.appIndex === vaultApp;

  // Located by CONTENT, never by index: the group is 11, 13 or 15 transactions
  // depending on recall carriers, and an absolute index is precisely the bug
  // that produced pc=8526.
  //
  // The call this finds is the `mark_market` call, NOT `withdraw_from_market`.
  // An earlier version of this comment said otherwise and was wrong — review
  // caught it. `mark_market` declares `[gm2:<id>, [marketsApp, mf2:<id>]]`
  // (SDK transactions.js:1543), so it is the first to carry one. That is fine
  // because **box references are pooled across the group**: the vault reads
  // the allocation during `withdraw_from_market` using a reference any
  // transaction in the group declared. Verified by simulation.
  const i = txns.findIndex((t) => (t.applicationCall?.boxes ?? []).some((b) => ours(t, b)));
  if (i < 0) throw new Error("cva: withdrawal group declares no allocation box to extend.");

  const call = txns[i].applicationCall!;
  const boxes = [...(call.boxes ?? [])];
  /**
   * What the WHOLE GROUP already declares, not just this call.
   *
   * Computing it from one call was a latent bug: the moment a second market
   * becomes funded it gets its own mark call carrying its own `gm2:`, and a
   * per-call view would add a duplicate here — burning a padding slot and
   * eventually throwing "no room" for a reference the group already had.
   */
  const present = new Set(
    txns.flatMap((t) => (t.applicationCall?.boxes ?? [])
      .filter((b) => ours(t, b))
      .map((b) => Buffer.from(b.name).toString("hex"))));

  let added = 0;
  for (const marketId of activeMarkets) {
    const name = gm2BoxName(marketId);
    if (present.has(Buffer.from(name).toString("hex"))) continue;
    const slot = boxes.findIndex((b) => b.name.length === 0);
    if (slot < 0) {
      throw new Error(
        `cva: no room to declare the allocation box for market ${marketId}, so nothing was sent.`);
    }
    // appIndex 0 is the called app itself, matching how the SDK declares gm2:
    // for the funded market on this same call.
    boxes[slot] = { appIndex: BigInt(0), name };
    added++;
  }
  if (added === 0) return txns;

  /**
   * `boxes` is `readonly` to the type system and mutable at runtime.
   *
   * Written through a narrow cast rather than by reconstructing the
   * transaction: an appl txn carries a dozen fields and rebuilding it by hand
   * is a far better way to change something by accident than assigning the one
   * array we mean to change. The group is re-grouped, re-asserted and
   * re-simulated immediately after, so a mistake here cannot reach a wallet.
   */
  (call as unknown as { boxes: algosdk.BoxReference[] }).boxes = boxes;
  // The bytes changed, so the group id must be recomputed. `assignGroupID`
  // refuses a transaction that already carries one.
  for (const t of txns) t.group = undefined;
  return algosdk.assignGroupID(txns);
}

export function markMarketsFor(snap: CvaSnapshot): number[] {
  const funded = snap.allocations
    .filter((a) => BigInt(String(a.lp_share_amount ?? 0)) > BigInt(0))
    .map((a) => Number(a.market_id));
  return snap.state.activeMarkets.filter((m) => funded.includes(m));
}

/**
 * Build, assert and simulate a C-Vault deposit.
 *
 * Two passes, as the pools do: simulate with a floor of zero to read the
 * contract's own `v2_cva_deposited` receipt, then set the real floor from that
 * figure. The SDK's `quoteV2CvaDeposit` is not used for the floor for the same
 * reason `quoteV2LpDeposit` is not — a quote that is out by more than the
 * tolerance makes the floor unsatisfiable.
 */
export async function buildCvaDeposit(input: {
  algod: algosdk.Algodv2;
  sender: string;
  snapshot: CvaSnapshot;
  algoMicro: bigint;
  usdcMicro: bigint;
  storagePaymentMicro: bigint;
  slippageBps: number;
  stage?: Stage;
}): Promise<CvaBuildResult> {
  const { algod, sender, snapshot: snap, stage = () => {} } = input;
  const sp = await algod.getTransactionParams().do();
  sp.fee = sp.minFee;
  sp.flatFee = true;

  const markMarkets = markMarketsFor(snap);

  const build = (minShares: bigint) => buildV2CvaDepositTransactions({
    sender,
    longAmount: input.algoMicro,
    shortAmount: input.usdcMicro,
    storagePaymentMicroAlgo: input.storagePaymentMicro,
    minCvaShares: minShares,
    ...refs(snap),
  } as never, sp) as algosdk.Transaction[];

  stage("pricing");
  const probe = await simulateGroup(algod, build(BigInt(0)));
  if (!probe.ok) {
    throw new Error(`The pre-flight check did not pass, so nothing was sent: ${probe.message ?? "unknown"}`);
  }
  const probeReceipt = receiptFromLogs(probe.logs, "v2_cva_deposited");
  if (!probeReceipt) {
    throw new Error("PEX did not report what this deposit would mint, so nothing was sent.");
  }
  const mintedKey = "cva_shares_minted" in probeReceipt.fields ? "cva_shares_minted" : "shares_minted";
  const minShares = withTolerance(probeReceipt.fields[mintedKey] ?? BigInt(0), input.slippageBps);

  stage("building");
  const txns = build(minShares);

  stage("checking");
  const assertion = assertCvaDepositGroup(txns, {
    sender,
    algoMicro: input.algoMicro,
    usdcMicro: input.usdcMicro,
    minShares,
    storagePaymentMicro: input.storagePaymentMicro,
    markMarkets,
  }, snap);
  if (!assertion.ok) {
    console.warn("cva: deposit failed its assertion", assertion.findings);
    throw new Error(
      `The safety check did not pass, so nothing was sent: ${assertion.findings[0]?.detail ?? "unknown"}`);
  }

  stage("simulating");
  const trial = await simulateGroup(algod, txns);
  if (!trial.ok) {
    throw new Error(`The pre-flight check did not pass, so nothing was sent: ${trial.message ?? "unknown"}`);
  }
  const receipt = receiptFromLogs(trial.logs, "v2_cva_deposited");
  if (!receipt) {
    throw new Error("PEX did not report what this deposit would mint, so nothing was sent.");
  }

  const signingBudgetSec = oracleBudgetSec(snap);
  if (signingBudgetSec < MIN_SIGNING_BUDGET_SEC) {
    throw new Error("Preparing this took longer than the price is valid for. Nothing was sent — try again.");
  }
  return { txns, assertion, receipt, signingBudgetSec };
}

/** Build, assert and simulate a C-Vault withdrawal. */
export async function buildCvaWithdraw(input: {
  algod: algosdk.Algodv2;
  sender: string;
  snapshot: CvaSnapshot;
  shareAmount: bigint;
  /** Receipt caps for the recall. Maxima — see the pools' unit note. */
  maxLongReceipt: bigint;
  maxShortReceipt: bigint;
  slippageBps: number;
  stage?: Stage;
}): Promise<CvaBuildResult> {
  const { algod, sender, snapshot: snap, stage = () => {} } = input;
  const sp = await algod.getTransactionParams().do();
  sp.fee = sp.minFee;
  sp.flatFee = true;

  stage("pricing");
  const caps = { long: input.maxLongReceipt, short: input.maxShortReceipt };
  const { route } = chooseWithdrawRoute(snap, sender, input.shareAmount, caps);
  const markMarkets = markMarketsFor(snap);
  const registryRecord = snap.registries[route.marketId];
  const recall = (registryRecord?.recall ?? { accounts: [], assets: [], apps: [] }) as
    { accounts: string[]; assets: number[]; apps: number[] };

  const build = (minAlgo: bigint, minUsdc: bigint) => route.routeType === "idle"
    ? buildV2CvaWithdrawTransactions({
        sender, shareAmount: input.shareAmount,
        minLongAmount: minAlgo, minShortAmount: minUsdc,
        ...refs(snap),
      } as never, sp) as algosdk.Transaction[]
    // The from-market builder is the ONE that drops the allocation boxes when
    // mark calls exist. Patched inside `build` so the probe, our assertion and
    // the final simulation all run against the same bytes the user signs.
    : declareActiveAllocationBoxes(
      buildV2CvaWithdrawFromMarketTransactions({
        sender, marketId: route.marketId, shareAmount: input.shareAmount,
        minLongAmount: minAlgo, minShortAmount: minUsdc,
        yieldRecallMode: 1,
        maxLongReceiptAmount: input.maxLongReceipt,
        maxShortReceiptAmount: input.maxShortReceipt,
        marketYieldRegistry: registryRecord,
        ...refs(snap),
      } as never, sp) as algosdk.Transaction[],
      snap.state.activeMarkets,
    );

  const event = route.routeType === "idle" ? "v2_cva_idle_withdrawn" : "v2_cva_market_withdrawn";

  const probe = await simulateGroup(algod, build(BigInt(0), BigInt(0)));
  if (!probe.ok) {
    throw new Error(`The pre-flight check did not pass, so nothing was sent: ${probe.message ?? "unknown"}`);
  }
  const probeReceipt = receiptFromLogs(probe.logs, event);
  if (!probeReceipt) {
    throw new Error("PEX did not report what this withdrawal would pay out, so nothing was sent.");
  }
  const longKey = "long_out" in probeReceipt.fields ? "long_out" : "long_amount_out";
  const shortKey = "short_out" in probeReceipt.fields ? "short_out" : "short_amount_out";
  const minAlgo = withTolerance(probeReceipt.fields[longKey] ?? BigInt(0), input.slippageBps);
  const minUsdc = withTolerance(probeReceipt.fields[shortKey] ?? BigInt(0), input.slippageBps);

  stage("building");
  const txns = build(minAlgo, minUsdc);

  stage("checking");
  const assertion = assertCvaWithdrawGroup(txns, {
    sender,
    shareAmount: input.shareAmount,
    minAlgoMicro: minAlgo,
    minUsdcMicro: minUsdc,
    route,
    maxLongReceipt: input.maxLongReceipt,
    maxShortReceipt: input.maxShortReceipt,
    markMarkets,
    recall,
  }, snap);
  if (!assertion.ok) {
    console.warn("cva: withdrawal failed its assertion", assertion.findings);
    throw new Error(
      `The safety check did not pass, so nothing was sent: ${assertion.findings[0]?.detail ?? "unknown"}`);
  }

  stage("simulating");
  const trial = await simulateGroup(algod, txns);
  if (!trial.ok) {
    throw new Error(`The pre-flight check did not pass, so nothing was sent: ${trial.message ?? "unknown"}`);
  }
  const receipt = receiptFromLogs(trial.logs, event);
  if (!receipt) {
    throw new Error("PEX did not report what this withdrawal would pay out, so nothing was sent.");
  }

  const signingBudgetSec = oracleBudgetSec(snap);
  if (signingBudgetSec < MIN_SIGNING_BUDGET_SEC) {
    throw new Error("Preparing this took longer than the price is valid for. Nothing was sent — try again.");
  }
  return { txns, assertion, receipt, route, signingBudgetSec };
}
