// Perps — `assertOpenLimitGroup`'s argument offsets, position by position.
//
// ── Why this test exists, and why it is shaped like this ────────────────────
// Audit 8 found `assertOpenLimitGroup` reading three ABI arguments at the wrong
// offsets: `A[1]` as orderKind, `A[3]` as marketId, `A[4]` as ownerOrderId. It
// passed everything anyone ran because `ORDER_KIND_OPEN_LIMIT`,
// `ORDER_TARGET_PAIR`, ALGO/USD's `marketId` and a fresh account's
// `baseOrderId` are all the literal 1 — a four-way coincidence.
//
// The live tamper table that was meant to cover it touched the escrow amount,
// the trigger (`A[9]`), a carrier account and the MBR receiver. **Not one of the
// three broken indices.** A tamper table that tests around a bug reads as
// thorough and proves nothing.
//
// So this walks EVERY argument position and asserts each one is bound to
// something. A future offset error cannot hide in an index nobody touched.

import { describe, expect, it } from "vitest";
import algosdk from "algosdk";
import {
  assertOpenLimitGroup,
  ORDER_LINK_MODE_CHILD_WAIT_PARENT,
  ORDER_KIND_OPEN_LIMIT,
  ORDER_KIND_TAKE_PROFIT,
  ORDER_KIND_STOP_LOSS,
  ORDER_LINK_MODE_BRACKET_PARENT,
  ORDER_TARGET_PAIR,
  PEX_SELECTORS,
  type DisplayedLimit,
} from "./perpsGroup";
import {
  ALGORAND_MAINNET_GENESIS_HASH_HEX, BUILDER_ADDRESS, COLLATERAL_ASSET_ID,
  PEX_APPS, POSITION_BUILDER_FEE_BPS, TAKE_PROFIT_TIME_IN_FORCE,
} from "./perps";

const SENDER = "5YCWR662A5HIOFYYS2CTIHHYBCIXESVLAOVLZ7CL27PK5SKBROCSRFIJMA";
const u64 = (v: bigint | number) => algosdk.encodeUint64(BigInt(v));
const hexBytes = (h: string) => Uint8Array.from((h.match(/../g) ?? []).map((b) => parseInt(b, 16)));

/**
 * Deliberately NOT all-1.
 *
 * Market 2, base order id 7, target PAIR. If any offset is read wrongly these
 * disagree, which is exactly what market 1 / base 1 could not reveal.
 */
const MARKET = 2;
const BASE = BigInt(7);
const SIZE = BigInt(60_000_000);
const STAKE = BigInt(6_000_000);
const KEEPER = BigInt(100_000);
const TRIGGER = BigInt(80_000_000_000_000_000);
const ACCEPT = BigInt(80_400_000_000_000_000);
/**
 * A realistic signed payload: the app the message is addressed to sits at
 * `ORACLE_TARGET_APP_OFFSET` (37), and for an OrderOps leg it must be OrderOps.
 *
 * This was `fill(9)` throughout, so offset 37 read as garbage. It went unnoticed
 * while nothing checked an oracle target here — the positive control below is
 * what surfaced it, on a group that is otherwise entirely correct. A fixture
 * that cannot pass a correct check is a fixture that hides the check.
 */
const ORACLE_MSG = (() => {
  const m = new Uint8Array(133).fill(9);
  new DataView(m.buffer).setBigUint64(37, BigInt(PEX_APPS.orderOps), false);
  return m;
})();
const ORACLE_SIG = new Uint8Array(64).fill(8);

/** The tail `decodeLinkedTail` expects: 7 uint64s, a 40-byte builder tuple, two offsets. */
function tail(linkMode: bigint = ORDER_LINK_MODE_BRACKET_PARENT): Uint8Array {
  const head: number[] = [];
  for (const v of [0, TAKE_PROFIT_TIME_IN_FORCE, 0, Number(linkMode), Number(BASE), 0, 0]) {
    head.push(...u64(v));
  }
  head.push(...algosdk.decodeAddress(BUILDER_ADDRESS).publicKey, ...u64(POSITION_BUILDER_FEE_BPS));
  const o1 = head.length + 4;
  const o2 = o1 + 2 + ORACLE_MSG.length;
  return Uint8Array.from([
    ...head, (o1 >> 8) & 0xff, o1 & 0xff, (o2 >> 8) & 0xff, o2 & 0xff,
    (ORACLE_MSG.length >> 8) & 0xff, ORACLE_MSG.length & 0xff, ...ORACLE_MSG,
    (ORACLE_SIG.length >> 8) & 0xff, ORACLE_SIG.length & 0xff, ...ORACLE_SIG,
  ]);
}

/** The entry leg's args, in the SDK's real order. */
const entryArgs = (): Uint8Array[] => [
  hexBytes(PEX_SELECTORS.submitLinkedOrder),
  u64(BASE),                       // 1  ownerOrderId
  u64(ORDER_KIND_OPEN_LIMIT),      // 2  orderKind
  u64(ORDER_TARGET_PAIR),          // 3  targetKind
  u64(MARKET),                     // 4  marketId
  u64(1),                          // 5  side (long)
  u64(COLLATERAL_ASSET_ID),        // 6  collateralAssetId
  u64(SIZE),                       // 7  sizeUsdDelta
  u64(STAKE),                      // 8  collateralAmount
  u64(TRIGGER),                    // 9  triggerPrice
  u64(ACCEPT),                     // 10 acceptablePrice
  u64(COLLATERAL_ASSET_ID),        // 11 keeperFeeAssetId
  u64(KEEPER),                     // 12 keeperFeeAmount
  u64(0),                          // 13 outputSwapMode
  u64(0),                          // 14 minPrimaryOutputAmount
  tail(),                          // 15 packed tail
];

const ORDER_OPS_ADDR = algosdk.getApplicationAddress(PEX_APPS.orderOps).toString();
// The REAL MainNet genesis hash: `checkEveryTransaction` asserts it, and a
// zeroed fixture fails three times over for a reason unrelated to the test.
const sp = { fee: 1000, firstValid: 1, lastValid: 1001, genesisID: "mainnet-v1.0",
  genesisHash: hexBytes(ALGORAND_MAINNET_GENESIS_HASH_HEX), minFee: 1000, flatFee: true } as never;

function group(): algosdk.Transaction[] {
  const escrow = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: SENDER, receiver: ORDER_OPS_ADDR, amount: Number(STAKE + KEEPER),
    assetIndex: COLLATERAL_ASSET_ID, suggestedParams: sp });
  const mbr = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: SENDER, receiver: ORDER_OPS_ADDR, amount: 100_200, suggestedParams: sp });
  const submit = algosdk.makeApplicationNoOpTxnFromObject({
    sender: SENDER, appIndex: PEX_APPS.orderOps, appArgs: entryArgs(), suggestedParams: sp });
  const txns = [escrow, mbr, submit];
  algosdk.assignGroupID(txns);
  return txns;
}

const shown = (): DisplayedLimit => ({
  sender: SENDER, marketId: MARKET, side: 1,
  collateralAssetId: COLLATERAL_ASSET_ID,
  collateralAmountMicro: STAKE, sizeUsdDeltaMicro: SIZE,
  triggerPrice12: TRIGGER, acceptablePrice12: ACCEPT,
  keeperFeeMicro: KEEPER, baseOrderId: BASE, slippageBps: 50,
  oracleMessage: ORACLE_MSG, oracleSignature: ORACLE_SIG,
});

describe("assertOpenLimitGroup — the offsets audit 8 found wrong", () => {
  it("accepts a correct group on market 2 at order id 7", () => {
    // The case the old code could not pass. Market 1 / base 1 masked the bug
    // because every value involved was the literal 1.
    const a = assertOpenLimitGroup(group(), shown());
    expect(a.findings.map((f) => f.code)).toEqual([]);
    expect(a.ok).toBe(true);
  });

  it("binds every ENTRY-leg argument position to something", () => {
    // The point of the test. Each index is mutated in turn; any that produces no
    // finding is an argument the assertion is not reading — which is how three
    // wrong offsets survived.
    //
    // **Scope, stated honestly.** This sweeps `A[1..14]` of the ENTRY leg. It
    // does not sweep `A[15]`, the packed tail — the code binds all nine of its
    // fields, so there is no gap, only no test. And the CHILD leg is bound at
    // `C[7]`, `C[9]`, `C[10]` and four tail fields, leaving `C[1..6]`, `C[8]`
    // and `C[11..14]` unchecked, including the child's own orderKind and
    // marketId. That is pre-existing rather than introduced here, and PEX
    // rejects every one of those tampers on chain — but SB1's lesson was that an
    // offset error must not be able to hide in an untested index, and on the
    // child leg it still could.
    const unbound: number[] = [];
    for (let i = 1; i <= 14; i++) {
      const g = group();
      const args = g[2].applicationCall!.appArgs as Uint8Array[];
      const original = algosdk.decodeUint64(args[i], "bigint");
      args[i] = u64(original + BigInt(1));
      if (assertOpenLimitGroup(g, shown()).ok) unbound.push(i);
    }
    expect(unbound).toEqual([]);
  });

  it("catches each of the three offsets that were misread", () => {
    const cases: [number, string][] = [
      [1, "limit_order_id"],    // was read at A[4]
      // Mutating orderKind makes the entry leg unfindable, which is the right
      // answer: the group no longer contains an OPEN_LIMIT. Before the fix the
      // find used A[1], so this mutation went completely unnoticed.
      [2, "limit_entry_missing"],
      [4, "limit_market"],      // was read at A[3]
    ];
    for (const [idx, code] of cases) {
      const g = group();
      const args = g[2].applicationCall!.appArgs as Uint8Array[];
      args[idx] = u64(algosdk.decodeUint64(args[idx], "bigint") + BigInt(1));
      const a = assertOpenLimitGroup(g, shown());
      expect(a.ok, `arg ${idx} should fail`).toBe(false);
      expect(a.findings.map((f) => f.code), `arg ${idx}`).toContain(code);
    }
  });

  it("catches a targetKind swap, which nothing checked before", () => {
    const g = group();
    const args = g[2].applicationCall!.appArgs as Uint8Array[];
    args[3] = u64(2);   // not PAIR
    const a = assertOpenLimitGroup(g, shown());
    expect(a.findings.map((f) => f.code)).toContain("limit_target_kind");
  });

  it("refuses an entry whose orderKind is a reduce order", () => {
    // Previously passed the assertion: `orderKind` was never compared, and the
    // leg was located by the wrong index. PEX rejects it on chain, so this is
    // defence in depth — which is the point of having it.
    const g = group();
    const args = g[2].applicationCall!.appArgs as Uint8Array[];
    args[2] = u64(3);   // DECREASE_STOP_LOSS
    const a = assertOpenLimitGroup(g, shown());
    expect(a.ok).toBe(false);
  });

  it("refuses a group whose total fee exceeds the cap", () => {
    // Audit 8 HIGH 3: this path discarded checkEveryTransaction's return value,
    // and MainNet accepted a 5.03 ALGO group.
    const g = group();
    for (const t of g) (t as unknown as { fee: bigint }).fee = BigInt(5_000_000);
    expect(assertOpenLimitGroup(g, shown()).findings.map((f) => f.code)).toContain("fee_cap");
  });
});

describe("the attached child's KIND is bound — audit 9's arg gap, closed", () => {
  // This leg checked C[7], C[9], C[10] and the tail and nothing else. With only
  // a take-profit reachable that was a recorded weakness; with a stop-loss
  // reachable it is a protection inversion — the screen promises a stop and the
  // group submits a target, so a long's downside is uncapped and its upside
  // closes instead. These are the tests that leg never had.
  const CHILD_TP = BASE + BigInt(1);
  const CHILD_SL = BASE + BigInt(2);
  const SL_TRIGGER = TRIGGER / BigInt(2);   // a long's stop, below its entry

  /** The child's args, mirroring the entry's real order. */
  const childArgs = (kind: bigint, ownerOrderId: bigint, trigger: bigint): Uint8Array[] => [
    hexBytes(PEX_SELECTORS.submitLinkedOrder),
    u64(ownerOrderId),               // 1  ownerOrderId
    u64(kind),                       // 2  orderKind  <- the field that was unbound
    u64(ORDER_TARGET_PAIR),          // 3
    u64(MARKET),                     // 4
    u64(1),                          // 5  side
    u64(COLLATERAL_ASSET_ID),        // 6
    u64(SIZE),                       // 7  sizeUsdDelta
    u64(0),                          // 8  collateralAmount — a child closes
    u64(trigger),                    // 9
    u64(trigger),                    // 10 acceptablePrice (bound separately)
    u64(COLLATERAL_ASSET_ID),        // 11
    u64(KEEPER),                     // 12
    u64(0),                          // 13
    u64(0),                          // 14
    tail(ORDER_LINK_MODE_CHILD_WAIT_PARENT), // 15 — a CHILD, not the parent
  ];

  const withChild = (
    kind: bigint, ownerOrderId: bigint, trigger: bigint,
    mutate?: (a: Uint8Array[]) => void,
  ) => {
    const escrow = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: SENDER, receiver: ORDER_OPS_ADDR, amount: Number(STAKE + KEEPER),
      assetIndex: COLLATERAL_ASSET_ID, suggestedParams: sp });
    const childEscrow = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: SENDER, receiver: ORDER_OPS_ADDR, amount: Number(KEEPER),
      assetIndex: COLLATERAL_ASSET_ID, suggestedParams: sp });
    const mbr = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: SENDER, receiver: ORDER_OPS_ADDR, amount: 100_200, suggestedParams: sp });
    const childMbr = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: SENDER, receiver: ORDER_OPS_ADDR, amount: 99_700, suggestedParams: sp });
    const entry = algosdk.makeApplicationNoOpTxnFromObject({
      sender: SENDER, appIndex: PEX_APPS.orderOps, appArgs: entryArgs(), suggestedParams: sp });
    const child = algosdk.makeApplicationNoOpTxnFromObject({
      sender: SENDER, appIndex: PEX_APPS.orderOps,
      appArgs: (() => { const a = childArgs(kind, ownerOrderId, trigger); mutate?.(a); return a; })(),
      suggestedParams: sp });
    const txns = [escrow, childEscrow, mbr, childMbr, entry, child];
    algosdk.assignGroupID(txns);
    return txns;
  };

  const shownChild = (kind: bigint, childOrderId: bigint, trigger: bigint) => ({
    orderKind: kind, childOrderId,
    triggerPrice12: trigger, acceptablePrice12: trigger,
    sizeUsdDeltaMicro: SIZE, keeperFeeMicro: KEEPER,
    baseOrderId: BASE, slippageBps: 50,
    oracleMessage: ORACLE_MSG, oracleSignature: ORACLE_SIG,
  });

  it("refuses a take-profit when the screen promised a stop-loss", () => {
    // The inversion. The group submits kind 2 at the take-profit slot; the card
    // told the user their loss was capped.
    const g = withChild(ORDER_KIND_TAKE_PROFIT, CHILD_SL, SL_TRIGGER);
    const a = assertOpenLimitGroup(g, shown(), shownChild(ORDER_KIND_STOP_LOSS, CHILD_SL, SL_TRIGGER));
    expect(a.ok).toBe(false);
    expect(a.findings.map((f) => f.code)).toContain("child_order_kind");
  });

  it("refuses a stop-loss when the screen promised a take-profit", () => {
    const g = withChild(ORDER_KIND_STOP_LOSS, CHILD_TP, TRIGGER * BigInt(2));
    const a = assertOpenLimitGroup(g, shown(),
      shownChild(ORDER_KIND_TAKE_PROFIT, CHILD_TP, TRIGGER * BigInt(2)));
    expect(a.ok).toBe(false);
    expect(a.findings.map((f) => f.code)).toContain("child_order_kind");
  });

  it("refuses a child sitting in the wrong reserved slot", () => {
    // A stop-loss belongs at base+2. At base+1 it is mislabelled, whatever its
    // kind field says.
    const g = withChild(ORDER_KIND_STOP_LOSS, CHILD_TP, SL_TRIGGER);
    const a = assertOpenLimitGroup(g, shown(), shownChild(ORDER_KIND_STOP_LOSS, CHILD_SL, SL_TRIGGER));
    expect(a.ok).toBe(false);
    expect(a.findings.map((f) => f.code)).toContain("child_order_id");
  });

  it("binds the child's collateral amount to zero", () => {
    // C[8] was unbound. A child CLOSES; pulling collateral in is not a close.
    const g = withChild(ORDER_KIND_STOP_LOSS, CHILD_SL, SL_TRIGGER, (a) => { a[8] = u64(STAKE); });
    const a = assertOpenLimitGroup(g, shown(), shownChild(ORDER_KIND_STOP_LOSS, CHILD_SL, SL_TRIGGER));
    expect(a.findings.map((f) => f.code)).toContain("child_collateral_amount");
  });

  it("binds the child's keeper fee to what was escrowed", () => {
    // C[12] was unbound: the arg could claim a different fee from the transfer.
    const g = withChild(ORDER_KIND_STOP_LOSS, CHILD_SL, SL_TRIGGER,
      (a) => { a[12] = u64(KEEPER * BigInt(9)); });
    const a = assertOpenLimitGroup(g, shown(), shownChild(ORDER_KIND_STOP_LOSS, CHILD_SL, SL_TRIGGER));
    expect(a.findings.map((f) => f.code)).toContain("child_keeper_fee");
  });

  it("ACCEPTS a correct limit entry with a stop-loss", () => {
    // The positive control, and the one that matters most. Every test above
    // asserts a specific failure code, and a `toContain` passes just as happily
    // when the assertion is rejecting the group for five other reasons too. If
    // this suite had only negative cases, an assertion that refused EVERY
    // correct stop-loss bracket would look fully covered — the feature would be
    // dead on arrival and the tests would be green.
    const g = withChild(ORDER_KIND_STOP_LOSS, CHILD_SL, SL_TRIGGER);
    const a = assertOpenLimitGroup(g, shown(), shownChild(ORDER_KIND_STOP_LOSS, CHILD_SL, SL_TRIGGER));
    expect(a.findings.map((f) => f.code)).toEqual([]);
    expect(a.ok).toBe(true);
  });

  it("ACCEPTS a correct limit entry with a take-profit", () => {
    // The same control for the kind that already shipped, so this change is
    // shown not to have broken it.
    const TP_TRIGGER = TRIGGER * BigInt(2);
    const g = withChild(ORDER_KIND_TAKE_PROFIT, CHILD_TP, TP_TRIGGER);
    const a = assertOpenLimitGroup(g, shown(), shownChild(ORDER_KIND_TAKE_PROFIT, CHILD_TP, TP_TRIGGER));
    expect(a.findings.map((f) => f.code)).toEqual([]);
    expect(a.ok).toBe(true);
  });
});
