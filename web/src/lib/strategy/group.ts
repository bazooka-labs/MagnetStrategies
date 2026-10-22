/**
 * Building and asserting a liquidity group, for signing in our own UI.
 *
 * The user asked for deposits and withdrawals signed here rather than on PEX's
 * page, which means this app now assembles groups that move a user's funds into
 * a third-party protocol. The safety model is the terminal's, unchanged:
 *
 *   1. the SDK builds the group against a manifest we vendored and pinned
 *   2. we assert the finished bytes against what the UI displayed
 *   3. we simulate
 *   4. only then does a wallet see it
 *
 * Step 2 is the one that matters and the one that is easy to fake. It decodes
 * the actual ABI arguments out of the actual transactions and compares each to
 * the number on screen. It does not re-derive the expected value through the
 * same SDK that produced the group — that round trip passes whatever the SDK
 * says, which is exactly what it is supposed to be checking.
 *
 * ── The group shapes, measured not assumed ──
 * Built against the live manifest for market 1 and dumped:
 *
 *   direct deposit   6 txns   pay(ALGO) axfer(USDC) pay(storage)
 *                             AdminOps.deposit_liquidity  + 2 Math carriers
 *                             55,000 µALGO
 *   direct withdraw  3 txns   AdminOps.withdraw_liquidity + 2 Math carriers
 *                             52,000 µALGO
 *   C-Vault deposit  4 txns   pay axfer pay  CvaVault.deposit
 *                             26,000 µALGO
 *
 * Note where the oracle goes: **AdminOps**, not Markets or Trading. That
 * matches the signed bundle's own key, `app-3690309162/market-N`, so the
 * payload's target binding is what proves we asked for the right one.
 */

import algosdk from "algosdk";
import {
  buildV2DepositLiquidityTransactions,
  buildV2WithdrawLiquidityTransactions,
  decodeReceipt,
  V2_LP_BOX_MBR_MICRO_ALGO,
} from "@pdex/sdk";
import {
  PEX_APPS, PEX_ASSETS, ORACLE_MAX_AGE_SEC, MIN_SIGNING_BUDGET_SEC,
} from "../perps";
import {
  checkEveryTransaction, checkMathCarriers, abiBytes,
  simulateGroup, type AnyTxn, type GroupAssertion, type GroupFinding,
} from "../perpsGroup";
import { getOraclePayload } from "../perpsOracle";
import { installProtocolManifest } from "../perpsManifest";

// ── Pinned selectors, each verified against the vendored manifest ────────────
export const LIQUIDITY_SELECTORS = {
  /** `PDexV2AdminOps.deposit_liquidity(uint64,txn,txn,pay,uint64,byte[],byte[])byte[]` */
  depositLiquidity: "115498d8",
  /** `PDexV2AdminOps.withdraw_liquidity(uint64,uint64,uint64,uint64,byte[],byte[],uint64,uint64,uint64)byte[]` */
  withdrawLiquidity: "cc72508e",
  /** `PDexV2CvaVault.deposit(txn,txn,pay,uint64,byte[],byte[])byte[]` */
  cvaDeposit: "b2eea014",
  /** `PDexV2CvaVault.mark_market(uint64,byte[],byte[])byte[]` — the NAV preamble. */
  cvaMarkMarket: "7eda6c29",
  /** `PDexV2Math.noop()void` — the resource carrier. */
  mathNoop: "e83a87ab",
} as const;

/**
 * Apps a liquidity group may call, and how many times.
 *
 * Separate from the trading budget on purpose. That one excludes AdminOps and
 * the C-Vault deliberately — audit 8 found that including them let an extra
 * call ride along inside a trade — and widening it so a deposit could pass
 * would hand that back on every trade. A deposit calls AdminOps and no Trading
 * app at all, so the two flows have genuinely different allow-lists.
 */
const LIQUIDITY_CALL_BUDGET: ReadonlyArray<{ app: number; name: string; min: number; max: number }> = [
  { app: PEX_APPS.adminOps, name: "AdminOps", min: 0, max: 1 },
  { app: PEX_APPS.cvaVault, name: "C-Vault", min: 0, max: 3 },
  // Measured at 2 on both paths. Bounded rather than fixed for the reason the
  // trading budget gives: the SDK derives carrier counts from pool and yield
  // state, so a benign change can add one, and each carrier is separately
  // asserted to be a bare noop that introduces no resource of its own. The
  // count is not the control; their contents are.
  // Measured at 9 on a real two-leg withdrawal recall, 2 on a deposit.
  { app: PEX_APPS.math, name: "Math carrier", min: 0, max: 12 },
];
const LIQUIDITY_CALLABLE = new Set(LIQUIDITY_CALL_BUDGET.map((c) => c.app));

/**
 * Fee ceiling, µALGO.
 *
 * ── Raised on evidence, not until it passed ──
 * The first value here was 120,000, from a deposit measured at 55,000 and a
 * withdrawal at 52,000. Both of those were built WITHOUT the yield registry,
 * which turned out to be mandatory — a real withdrawal recalls both legs and
 * comes to **117,000 µALGO across ten transactions**, sitting on the lip of
 * that cap. A cap set at the observed value refuses the next correct group that
 * carries one more resource carrier, and the SDK derives carrier counts from
 * pool and yield state, so that can happen without any change here.
 *
 * 200,000 keeps ~1.7x headroom over the measured worst case. The carriers are
 * individually asserted to be bare noops, so the headroom cannot hide an extra
 * operation — only extra fee, which is what this bounds.
 */
export const MAX_LIQUIDITY_GROUP_FEE_MICRO_ALGO = 200_000;

/**
 * The `ml2:` box MBR a FIRST-TIME depositor must pay, µALGO.
 *
 * ── Found the hard way, on the only path that matters ──
 * Every live test of this flow used a wallet that already held a position, and
 * they all passed with a storage payment of zero. A wallet with no `ml2:` box
 * is a different group: AdminOps asserts the payment equals this exact value —
 *
 *     assert failed pc=1203   opcodes=intc 17 // 26500 ; == ; assert
 *
 * — so hardcoding zero meant **no new depositor could ever deposit**, while
 * every test stayed green. That is the same gap the perps path carried for
 * eight audits as `SHAPE_OPEN_STORAGE`: the first-time shape is its own shape.
 *
 * Taken from the SDK's own constant rather than written as 26500, so a PEX
 * change to the box layout moves this with the vendored version instead of
 * silently disagreeing with the contract. `storagePaymentFor` is the rule, and
 * `assertDepositGroup` pins whichever value was used into the signed bytes.
 */
export const LP_BOX_MBR_MICRO_ALGO = BigInt(V2_LP_BOX_MBR_MICRO_ALGO);

/**
 * What this wallet must pay for box storage on this deposit.
 *
 * Exactly the MBR on a first deposit, exactly zero afterwards — the contract
 * asserts equality in both directions, so neither value is a safe default for
 * the other. `hasPosition` comes from an `ml2:` read, never from a guess.
 */
export const storagePaymentFor = (hasPosition: boolean): bigint =>
  hasPosition ? BigInt(0) : LP_BOX_MBR_MICRO_ALGO;

const big = (v: bigint | number | undefined): bigint => BigInt(v ?? 0);
const hex = (b: Uint8Array): string =>
  Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const u64 = (b: Uint8Array | undefined): bigint =>
  b && b.length === 8 ? new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0) : BigInt(-1);

const normalise = (txnsIn: unknown[]): AnyTxn[] =>
  txnsIn.map((t) => ((t as { txn?: unknown }).txn ?? t) as AnyTxn);

// ── What the UI showed ───────────────────────────────────────────────────────

/** Every field is compared against the bytes, not sanity-checked. */
export type DisplayedDeposit = {
  sender: string;
  marketId: number;
  /** µALGO on the long leg, exactly as quoted. */
  algoMicro: bigint;
  /** µUSDC on the short leg, exactly as quoted. */
  usdcMicro: bigint;
  /** The slippage floor the user accepted, in pool shares (micro). */
  minShares: bigint;
  storagePaymentMicro: bigint;
  oracleMessage: Uint8Array;
  oracleSignature: Uint8Array;
};

export type DisplayedWithdraw = {
  sender: string;
  marketId: number;
  shareAmount: bigint;
  minAlgoMicro: bigint;
  minUsdcMicro: bigint;
  yieldRecallMode: bigint;
  maxLongReceipt: bigint;
  maxShortReceipt: bigint;
  oracleMessage: Uint8Array;
  oracleSignature: Uint8Array;
  /**
   * Every account, asset and app the yield recall may legitimately reference,
   * from `readYieldRegistry().recall`.
   *
   * ── A closed set, not a loosened rule ──
   * A real withdrawal's recall names the Folks pool and its manager, the xALGO
   * consensus app, the proposer set, and the fUSDC and xALGO assets. Without
   * this the assertion refuses every correct withdrawal — measured: fifteen
   * findings on the first live group, all of them legitimate recall resources.
   *
   * The temptation is to relax `checkEveryTransaction` instead. This is the
   * opposite: we derive the registry from chain ourselves, so we know exactly
   * which resources a legitimate recall may touch, and anything outside that
   * set still fails. It leaves the check TIGHTER than a blanket "PEX apps are
   * fine" rule would.
   */
  recall: { accounts: string[]; assets: number[]; apps: number[] };
};

function shapeAndBudget(
  txns: AnyTxn[],
  expect: { pay: number; axfer: number; applMin: number; applMax: number },
  fail: (code: string, detail: string) => void,
  did: (n: string) => void,
): void {
  const counts: Record<string, number> = {};
  txns.forEach((t, i) => {
    const type = String(t.type ?? "");
    counts[type] = (counts[type] ?? 0) + 1;
    if (!["pay", "axfer", "appl"].includes(type)) {
      fail("txn_type", `txn ${i} is "${type || "typeless"}" — this flow contains only pay, axfer and appl`);
    }
  });
  if ((counts.pay ?? 0) !== expect.pay) fail("pay_count", `expected ${expect.pay} payment(s), found ${counts.pay ?? 0}`);
  if ((counts.axfer ?? 0) !== expect.axfer) fail("axfer_count", `expected ${expect.axfer} transfer(s), found ${counts.axfer ?? 0}`);
  const appl = counts.appl ?? 0;
  if (appl < expect.applMin || appl > expect.applMax) {
    fail("appl_count", `expected ${expect.applMin}..${expect.applMax} app calls, found ${appl}`);
  }
  const seen = new Map<number, number>();
  for (const t of txns) {
    if (!t.applicationCall) continue;
    const app = Number(t.applicationCall.appIndex);
    if (!LIQUIDITY_CALLABLE.has(app)) {
      fail("unpinned_app", `group calls app ${app}, which this flow never uses`);
      continue;
    }
    seen.set(app, (seen.get(app) ?? 0) + 1);
  }
  for (const c of LIQUIDITY_CALL_BUDGET) {
    const n = seen.get(c.app) ?? 0;
    if (n < c.min || n > c.max) fail("call_budget", `${c.name} called ${n} times, expected ${c.min}..${c.max}`);
  }
  did("every transaction is a type and an app this flow uses, in the expected counts");
}

/** The destination every funding leg must name: the Markets app's own address. */
const marketsAddress = () => algosdk.getApplicationAddress(PEX_APPS.markets).toString();

/**
 * Assert a direct-pool DEPOSIT against what was displayed.
 *
 * Returns every finding rather than throwing on the first, so a failure shows
 * the whole picture rather than one symptom.
 */
export function assertDepositGroup(txnsIn: unknown[], shown: DisplayedDeposit): GroupAssertion {
  const txns = normalise(txnsIn);
  const findings: GroupFinding[] = [];
  const checked: string[] = [];
  const fail = (code: string, detail: string) => findings.push({ code, detail });
  const did = (name: string) => checked.push(name);

  // A zero-ALGO or zero-USDC side is legitimate (a one-sided deposit), so the
  // shape counts both legs regardless of amount — the SDK always builds all
  // three funding transactions, as the dumped group shows.
  shapeAndBudget(txns, { pay: 2, axfer: 1, applMin: 1, applMax: 13 }, fail, did);

  const totalFee = checkEveryTransaction(txns, {
    sender: shown.sender,
    collateralAssetId: PEX_ASSETS.usdc,
    allowApps: new Set<number>([PEX_APPS.adminOps, PEX_APPS.cvaVault]),
  }, fail, did);
  if (totalFee > BigInt(MAX_LIQUIDITY_GROUP_FEE_MICRO_ALGO)) {
    fail("fee_cap", `group fee ${totalFee} µALGO exceeds ${MAX_LIQUIDITY_GROUP_FEE_MICRO_ALGO}`);
  } else {
    did(`group fee is within ${MAX_LIQUIDITY_GROUP_FEE_MICRO_ALGO} µALGO`);
  }
  checkMathCarriers(txns, fail, did);

  // ── the funding legs ──
  const dest = marketsAddress();
  const pays = txns.filter((t) => t.type === "pay");
  const axfers = txns.filter((t) => t.type === "axfer");

  // Two payments: the ALGO side and the storage payment. Identify by amount
  // rather than by index, then assert BOTH values — so a group that swapped
  // them cannot pass by matching one.
  const algoLeg = pays.find((t) => big(t.payment?.amount) === shown.algoMicro);
  const storageLeg = pays.find((t) => t !== algoLeg && big(t.payment?.amount) === shown.storagePaymentMicro);
  if (!algoLeg) {
    fail("algo_leg", `no payment of ${shown.algoMicro} µALGO; found ${pays.map((t) => big(t.payment?.amount)).join(", ")}`);
  }
  if (!storageLeg) {
    fail("storage_leg",
      `no payment of ${shown.storagePaymentMicro} µALGO for the account record; `
      + `found ${pays.map((t) => big(t.payment?.amount)).join(", ")}`);
  }
  for (const [name, leg] of [["algo_leg", algoLeg], ["storage_leg", storageLeg]] as const) {
    if (leg && String(leg.payment?.receiver) !== dest) {
      fail(`${name}_receiver`, `${name} pays ${String(leg.payment?.receiver).slice(0, 10)}…, not the pool`);
    }
  }
  if (algoLeg && storageLeg) {
    did(`ALGO leg is ${shown.algoMicro} µALGO and the account record ${shown.storagePaymentMicro} µALGO, both to the pool`);
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
      fail("usdc_receiver", `USDC leg pays ${String(a.assetTransfer?.receiver).slice(0, 10)}…, not the pool`);
    }
    did(`USDC leg is ${shown.usdcMicro} µUSDC to the pool`);
  }

  // ── the call that does the work ──
  const calls = txns.filter((t) => Number(t.applicationCall?.appIndex) === PEX_APPS.adminOps);
  if (calls.length !== 1) {
    fail("adminops_calls", `expected exactly 1 AdminOps call, found ${calls.length}`);
  } else {
    const args = (calls[0].applicationCall?.appArgs ?? []) as Uint8Array[];
    if (args.length !== 5 || hex(args[0]) !== LIQUIDITY_SELECTORS.depositLiquidity) {
      fail("deposit_selector",
        `AdminOps call is selector ${hex(args[0] ?? new Uint8Array())} with ${args.length} args, `
        + `expected ${LIQUIDITY_SELECTORS.depositLiquidity} with 5`);
    } else {
      if (u64(args[1]) !== BigInt(shown.marketId)) {
        fail("market_id", `call is for market ${u64(args[1])}, displayed ${shown.marketId}`);
      }
      // The slippage floor. A group that quietly lowered it would still move the
      // user's funds and could return fewer shares than they accepted.
      if (u64(args[2]) !== shown.minShares) {
        fail("min_shares", `minimum shares in the call is ${u64(args[2])}, displayed ${shown.minShares}`);
      }
      assertOracleArgs(args[3], args[4], shown.oracleMessage, shown.oracleSignature, fail, did);
      did(`the call is deposit_liquidity for market ${shown.marketId} at no worse than ${shown.minShares} shares`);
    }
  }

  return { ok: findings.length === 0, findings, checked };
}

/** Assert a direct-pool WITHDRAWAL against what was displayed. */
export function assertWithdrawGroup(txnsIn: unknown[], shown: DisplayedWithdraw): GroupAssertion {
  const txns = normalise(txnsIn);
  const findings: GroupFinding[] = [];
  const checked: string[] = [];
  const fail = (code: string, detail: string) => findings.push({ code, detail });
  const did = (name: string) => checked.push(name);

  // Nothing leaves the wallet on a withdrawal: both sides arrive by inner
  // transfer. So a pay or axfer leg in this group is money moving the wrong
  // way, and the exact-zero counts are the check that catches it.
  // Measured: 10 transactions, all app calls, on a both-leg recall.
  shapeAndBudget(txns, { pay: 0, axfer: 0, applMin: 1, applMax: 13 }, fail, did);

  const totalFee = checkEveryTransaction(txns, {
    sender: shown.sender,
    collateralAssetId: PEX_ASSETS.usdc,
    allowAccounts: new Set(shown.recall.accounts),
    allowAssets: new Set(shown.recall.assets),
    allowApps: new Set<number>([
      PEX_APPS.adminOps, PEX_APPS.cvaVault, ...shown.recall.apps,
    ]),
  }, fail, did);
  if (totalFee > BigInt(MAX_LIQUIDITY_GROUP_FEE_MICRO_ALGO)) {
    fail("fee_cap", `group fee ${totalFee} µALGO exceeds ${MAX_LIQUIDITY_GROUP_FEE_MICRO_ALGO}`);
  } else {
    did(`group fee is within ${MAX_LIQUIDITY_GROUP_FEE_MICRO_ALGO} µALGO`);
  }
  checkMathCarriers(txns, fail, did, {
    accounts: new Set(shown.recall.accounts), assets: new Set(shown.recall.assets),
  });
  did("the recall touches only the accounts, assets and apps our own registry names");

  const calls = txns.filter((t) => Number(t.applicationCall?.appIndex) === PEX_APPS.adminOps);
  if (calls.length !== 1) {
    fail("adminops_calls", `expected exactly 1 AdminOps call, found ${calls.length}`);
    return { ok: false, findings, checked };
  }
  const args = (calls[0].applicationCall?.appArgs ?? []) as Uint8Array[];
  if (args.length !== 10 || hex(args[0]) !== LIQUIDITY_SELECTORS.withdrawLiquidity) {
    fail("withdraw_selector",
      `AdminOps call is selector ${hex(args[0] ?? new Uint8Array())} with ${args.length} args, `
      + `expected ${LIQUIDITY_SELECTORS.withdrawLiquidity} with 10`);
    return { ok: false, findings, checked };
  }
  // withdraw_liquidity(marketId, shareAmount, minLong, minShort, msg, sig,
  //                    yieldRecallMode, maxLongReceipt, maxShortReceipt)
  const pairs: Array<[string, bigint, bigint]> = [
    ["market_id", u64(args[1]), BigInt(shown.marketId)],
    ["share_amount", u64(args[2]), shown.shareAmount],
    ["min_algo", u64(args[3]), shown.minAlgoMicro],
    ["min_usdc", u64(args[4]), shown.minUsdcMicro],
    ["yield_recall_mode", u64(args[7]), shown.yieldRecallMode],
    ["max_long_receipt", u64(args[8]), shown.maxLongReceipt],
    ["max_short_receipt", u64(args[9]), shown.maxShortReceipt],
  ];
  for (const [name, got, want] of pairs) {
    if (got !== want) fail(name, `${name} in the call is ${got}, displayed ${want}`);
  }
  assertOracleArgs(args[5], args[6], shown.oracleMessage, shown.oracleSignature, fail, did);
  did(`the call burns exactly ${shown.shareAmount} shares of market ${shown.marketId}`);
  did(`payout floors are ${shown.minAlgoMicro} µALGO and ${shown.minUsdcMicro} µUSDC`);

  return { ok: findings.length === 0, findings, checked };
}

/**
 * The oracle bytes in the group are the bytes we verified.
 *
 * `getOraclePayload` already checked the signature, the signer, the target app,
 * the market, the network and the age. None of that transfers unless the group
 * actually carries the same bytes — so this compares them, rather than
 * re-checking a payload nobody is going to sign.
 */
function assertOracleArgs(
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

// ── Building ─────────────────────────────────────────────────────────────────

/** Everything both builders need, assembled once. */
function appRefs(marketId: number) {
  return {
    marketId,
    // Market 1 is ALGO/USD and market 2 the synthetic BTC index; both are
    // ALGO-long / USDC-short, which is why both share these asset refs.
    indexAssetId: marketId === 2 ? PEX_ASSETS.btcIndex : PEX_ASSETS.algo,
    longAssetId: PEX_ASSETS.algo,
    shortAssetId: PEX_ASSETS.usdc,
    v2MathAppId: PEX_APPS.math,
    v2MarketsAppId: PEX_APPS.markets,
    v2TradingAppId: PEX_APPS.trading,
    v2TradingRiskOpsAppId: PEX_APPS.tradingRiskOps,
    v2OrderOpsAppId: PEX_APPS.orderOps,
    v2AdminOpsAppId: PEX_APPS.adminOps,
    v2AdminControlAppId: PEX_APPS.adminControl,
    v2MarketXalgoYieldVaultAppId: PEX_APPS.marketXAlgoYieldVault,
  };
}

/**
 * What the contract itself says it will do, decoded from a simulation.
 *
 * ── Why this exists, and why it is NOT the SDK quote ──
 * `quoteV2LpDeposit` was measured **1.65% high** on shares minted, and
 * `quoteV2LpWithdraw` about 1.6% low on both payouts, consistently and in
 * mirror directions — the quotes value the pool below what the chain does,
 * almost certainly by the quantity lent into the yield vaults.
 *
 * That is more than any sane slippage tolerance, which made it a shipping bug
 * rather than a rounding note: a 1% floor derived from the deposit quote is
 * **unsatisfiable**, and MainNet rejected exactly that group at
 * `AdminOps pc=1541` (`dig 18; >=; assert`) — the on-chain minimum-shares
 * check. A Deposit button that always fails.
 *
 * So the number of record is the chain's. Both apps return an ABI receipt whose
 * fields the vendored manifest names, and `decodeReceipt` reads them:
 *
 *   v2_lp_deposited   market_id long_amount short_amount shares_minted
 *                     long_pool_amount_after short_pool_amount_after
 *                     market_share_supply_after
 *   v2_lp_withdrawn   market_id shares_burned long_out short_out
 *                     long_pool_amount_after short_pool_amount_after
 *                     market_share_supply_after storage_refund_microalgo
 */
export type LiquidityReceipt = {
  eventType: string;
  fields: Record<string, bigint>;
};

/** ABI return values are logged with this 4-byte prefix. */
const ABI_RETURN_PREFIX = "151f7c75";

/**
 * Pull the one receipt we expect out of a simulation's logs.
 *
 * Returns null rather than throwing, and every caller treats null as "cannot
 * preview" rather than falling back to the quote — a silent fallback to a
 * figure known to be 1.65% out is the failure this whole path exists to avoid.
 *
 * Requires the protocol manifest to be installed: `decodeReceipt` resolves the
 * field NAMES from it. Both builders call `installProtocolManifest()` first,
 * and without it this returns null rather than guessing at offsets.
 */
export function receiptFromLogs(
  logs: Uint8Array[] | undefined, eventType: string,
): LiquidityReceipt | null {
  for (const log of logs ?? []) {
    if (hex(log.slice(0, 4)) !== ABI_RETURN_PREFIX) continue;
    const body = log.slice(4);
    // byte[] return: a two-byte big-endian length, then the receipt.
    if (body.length < 2) continue;
    const len = (body[0] << 8) | body[1];
    if (body.length < 2 + len) continue;
    try {
      const r = decodeReceipt(body.slice(2, 2 + len)) as unknown as {
        eventType?: string; fields?: Record<string, bigint | string>;
      };
      if (r.eventType !== eventType) continue;
      const fields: Record<string, bigint> = {};
      for (const [k, v] of Object.entries(r.fields ?? {})) {
        if (typeof v === "bigint") fields[k] = v;
        else if (typeof v === "string" && /^-?\d+$/.test(v)) fields[k] = BigInt(v);
      }
      return { eventType: r.eventType, fields };
    } catch {
      // A receipt we cannot decode is one we do not trust; keep looking.
      continue;
    }
  }
  return null;
}

const field = (r: LiquidityReceipt, name: string): bigint => {
  const v = r.fields[name];
  if (v === undefined) {
    throw new Error(`liquidity: receipt ${r.eventType} has no field ${name} — the pinned layout is stale`);
  }
  return v;
};

/** Apply a slippage tolerance to a figure the chain itself produced. */
export const withTolerance = (amount: bigint, slippageBps: number): bigint =>
  amount * BigInt(10_000 - Math.max(0, Math.min(10_000, Math.round(slippageBps)))) / BigInt(10_000);

export type BuildResult = {
  txns: algosdk.Transaction[];
  assertion: GroupAssertion;
  /** Seconds of the oracle's life left when the group was handed over. */
  signingBudgetSec: number;
  /**
   * The contract's own figures for this exact group, from the final simulation.
   * This is what the confirm screen shows.
   */
  receipt: LiquidityReceipt;
};

export type Stage = (s: string) => void;

/**
 * Build, assert and simulate a direct-pool deposit.
 *
 * ── Two passes, because the chain is the only honest source of the figure ──
 * Pass one builds with a floor of zero purely to simulate it and read the
 * contract's `v2_lp_deposited` receipt. Pass two sets the real floor from that
 * figure, rebuilds, asserts and simulates again. The floor then protects
 * against what it should — state moving between now and the signature — rather
 * than against an SDK quote that is 1.65% out. See `LiquidityReceipt`.
 *
 * Throws rather than returning a half-checked group: every caller's next step
 * is a wallet prompt, and there is no safe way to prompt with a group that
 * failed its own assertion.
 */
export async function buildDeposit(input: {
  algod: algosdk.Algodv2;
  sender: string;
  marketId: number;
  algoMicro: bigint;
  usdcMicro: bigint;
  storagePaymentMicro: bigint;
  /** Tolerance applied to the chain's own share figure. */
  slippageBps: number;
  stage?: Stage;
}): Promise<BuildResult> {
  const { algod, sender, marketId, stage = () => {} } = input;
  await installProtocolManifest();

  stage("pricing");
  const oracleFetchedAt = Date.now();
  const oracle = await getOraclePayload(PEX_APPS.adminOps, marketId);
  /**
   * Local verification is not optional.
   *
   * `getOraclePayload` records the result rather than throwing, and this path
   * did not check it — so a payload whose signature does not verify would be
   * built, asserted, and refused on chain at `ed25519verify_bare`, after the
   * wallet prompt. The close path has always checked; these two did not.
   */
  if (!oracle.signatureVerified) {
    throw new Error("The price could not be verified against PEX's signing key. Nothing was sent.");
  }

  const sp = await algod.getTransactionParams().do();
  // Pin the fee. algod's suggestion scales with congestion, and the cap above
  // is the only thing between a congested network and a multi-ALGO group.
  sp.fee = sp.minFee;
  sp.flatFee = true;

  const build = (minShares: bigint) => buildV2DepositLiquidityTransactions({
    sender,
    longAmount: input.algoMicro,
    shortAmount: input.usdcMicro,
    storagePaymentMicroAlgo: input.storagePaymentMicro,
    minMarketShares: minShares,
    oracleMessage: oracle.message,
    oracleSignature: oracle.signature,
    ...appRefs(marketId),
  } as never, sp) as algosdk.Transaction[];

  const displayed = (minShares: bigint): DisplayedDeposit => ({
    sender, marketId,
    algoMicro: input.algoMicro,
    usdcMicro: input.usdcMicro,
    minShares,
    storagePaymentMicro: input.storagePaymentMicro,
    oracleMessage: oracle.message,
    oracleSignature: oracle.signature,
  });

  // ── pass one: ask the contract what it will mint ──
  stage("pricing");
  const probe = await simulateGroup(algod, build(BigInt(0)));
  if (!probe.ok) {
    throw new Error(`The pre-flight check did not pass, so nothing was sent: ${probe.message ?? "unknown"}`);
  }
  const probeReceipt = receiptFromLogs(probe.logs, "v2_lp_deposited");
  if (!probeReceipt) {
    throw new Error("PEX did not report what this deposit would mint, so nothing was sent.");
  }
  const minShares = withTolerance(field(probeReceipt, "shares_minted"), input.slippageBps);

  // ── pass two: the group the user actually signs ──
  stage("building");
  const txns = build(minShares);

  stage("checking");
  const assertion = assertDepositGroup(txns, displayed(minShares));
  if (!assertion.ok) {
    console.warn("liquidity: deposit failed its assertion", assertion.findings);
    throw new Error(
      `The safety check did not pass, so nothing was sent: ${assertion.findings[0]?.detail ?? "unknown"}`);
  }

  stage("simulating");
  const trial = await simulateGroup(algod, txns);
  if (!trial.ok) {
    throw new Error(`The pre-flight check did not pass, so nothing was sent: ${trial.message ?? "unknown"}`);
  }
  const receipt = receiptFromLogs(trial.logs, "v2_lp_deposited");
  if (!receipt) {
    throw new Error("PEX did not report what this deposit would mint, so nothing was sent.");
  }

  const signingBudgetSec =
    ORACLE_MAX_AGE_SEC - oracle.ageSeconds - (Date.now() - oracleFetchedAt) / 1000;
  if (signingBudgetSec < MIN_SIGNING_BUDGET_SEC) {
    throw new Error("Preparing this took longer than the price is valid for. Nothing was sent — try again.");
  }
  return { txns, assertion, signingBudgetSec, receipt };
}

/**
 * Build, assert and simulate a direct-pool withdrawal.
 *
 * ── Why this needs a yield recall, on BOTH legs ──
 * The pool's assets are deployed into yield, so there is usually not enough
 * idle to pay an exit from: `yieldRecallMode: 0` builds fine and then fails
 * inside the Markets app at `inner tx 0`. Mode 1 needs the registry, and it
 * needs non-zero receipt caps on both sides — each of these was found by
 * simulating against MainNet, and the SDK's types accept all three mistakes:
 *
 *   caps 0/0            MainNet rejects at Markets `pc=12259` (`frame_dig -1; <=; assert`)
 *   long cap only       same rejection — a withdrawal pays out BOTH assets, so
 *                       unlike a CLOSE it cannot recall just the index leg
 *   both caps           10 transactions, 117,000 µALGO, accepted
 *
 * The close path's "index leg only, then both" fallback is therefore wrong here
 * and is not used: the tighter shape is not merely unlikely to fit, it cannot
 * satisfy the contract.
 *
 * ── Two passes, as the deposit does ──
 * Pass one simulates with floors of zero to read the `v2_lp_withdrawn` receipt;
 * pass two sets the real floors from the chain's own `long_out`/`short_out`.
 * The SDK's withdraw quote is ~1.6% low on both, in the opposite direction from
 * its deposit quote. See `LiquidityReceipt`.
 */
export async function buildWithdraw(input: {
  algod: algosdk.Algodv2;
  sender: string;
  marketId: number;
  shareAmount: bigint;
  /**
   * Receipt caps for the recall, from `recallCaps(quoteWithdraw(...))`.
   *
   * ── A unit note ──
   * These cap RECEIPT tokens (xALGO, fUSDC) while the quote is denominated in
   * the UNDERLYING, and receipts appreciate against underlying — so a cap taken
   * from an underlying figure is generous rather than tight. Safe in the only
   * direction a maximum can be, and the same choice the close path makes. The
   * assertion pins whatever value is used into the signed bytes.
   */
  maxLongReceipt: bigint;
  maxShortReceipt: bigint;
  /** The yield registry, read from chain by `readRecallContext`. */
  registry: Record<string, unknown>;
  /** That registry's `recall` set — see the note on `DisplayedWithdraw`. */
  recall: { accounts: string[]; assets: number[]; apps: number[] };
  /** Tolerance applied to the chain's own payout figures. */
  slippageBps: number;
  stage?: Stage;
}): Promise<BuildResult> {
  const { algod, sender, marketId, stage = () => {} } = input;
  await installProtocolManifest();

  stage("pricing");
  const oracleFetchedAt = Date.now();
  const oracle = await getOraclePayload(PEX_APPS.adminOps, marketId);
  /**
   * Local verification is not optional.
   *
   * `getOraclePayload` records the result rather than throwing, and this path
   * did not check it — so a payload whose signature does not verify would be
   * built, asserted, and refused on chain at `ed25519verify_bare`, after the
   * wallet prompt. The close path has always checked; these two did not.
   */
  if (!oracle.signatureVerified) {
    throw new Error("The price could not be verified against PEX's signing key. Nothing was sent.");
  }

  const sp = await algod.getTransactionParams().do();
  sp.fee = sp.minFee;
  sp.flatFee = true;

  const yieldRecallMode = BigInt(1);

  const build = (minAlgo: bigint, minUsdc: bigint) => buildV2WithdrawLiquidityTransactions({
    sender,
    shareAmount: input.shareAmount,
    minLongAmount: minAlgo,
    minShortAmount: minUsdc,
    yieldRecallMode,
    maxLongReceiptAmount: input.maxLongReceipt,
    maxShortReceiptAmount: input.maxShortReceipt,
    marketYieldRegistry: input.registry,
    oracleMessage: oracle.message,
    oracleSignature: oracle.signature,
    ...appRefs(marketId),
  } as never, sp) as algosdk.Transaction[];

  const displayed = (minAlgo: bigint, minUsdc: bigint): DisplayedWithdraw => ({
    sender, marketId,
    shareAmount: input.shareAmount,
    minAlgoMicro: minAlgo,
    minUsdcMicro: minUsdc,
    yieldRecallMode,
    maxLongReceipt: input.maxLongReceipt,
    maxShortReceipt: input.maxShortReceipt,
    oracleMessage: oracle.message,
    oracleSignature: oracle.signature,
    recall: input.recall,
  });

  // ── pass one: ask the contract what it will pay out ──
  const probe = await simulateGroup(algod, build(BigInt(0), BigInt(0)));
  if (!probe.ok) {
    throw new Error(`The pre-flight check did not pass, so nothing was sent: ${probe.message ?? "unknown"}`);
  }
  const probeReceipt = receiptFromLogs(probe.logs, "v2_lp_withdrawn");
  if (!probeReceipt) {
    throw new Error("PEX did not report what this withdrawal would pay out, so nothing was sent.");
  }
  const minAlgo = withTolerance(field(probeReceipt, "long_out"), input.slippageBps);
  const minUsdc = withTolerance(field(probeReceipt, "short_out"), input.slippageBps);

  // ── pass two: the group the user actually signs ──
  stage("building");
  const txns = build(minAlgo, minUsdc);

  stage("checking");
  const assertion = assertWithdrawGroup(txns, displayed(minAlgo, minUsdc));
  if (!assertion.ok) {
    console.warn("liquidity: withdrawal failed its assertion", assertion.findings);
    throw new Error(
      `The safety check did not pass, so nothing was sent: ${assertion.findings[0]?.detail ?? "unknown"}`);
  }

  stage("simulating");
  const trial = await simulateGroup(algod, txns);
  if (!trial.ok) {
    throw new Error(`The pre-flight check did not pass, so nothing was sent: ${trial.message ?? "unknown"}`);
  }
  const receipt = receiptFromLogs(trial.logs, "v2_lp_withdrawn");
  if (!receipt) {
    throw new Error("PEX did not report what this withdrawal would pay out, so nothing was sent.");
  }

  const signingBudgetSec =
    ORACLE_MAX_AGE_SEC - oracle.ageSeconds - (Date.now() - oracleFetchedAt) / 1000;
  if (signingBudgetSec < MIN_SIGNING_BUDGET_SEC) {
    throw new Error("Preparing this took longer than the price is valid for. Nothing was sent — try again.");
  }
  return { txns, assertion, signingBudgetSec, receipt };
}
