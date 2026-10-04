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
  ORDER_KIND_OPEN_LIMIT,
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
const ORACLE_MSG = new Uint8Array(133).fill(9);
const ORACLE_SIG = new Uint8Array(64).fill(8);

/** The tail `decodeLinkedTail` expects: 7 uint64s, a 40-byte builder tuple, two offsets. */
function tail(): Uint8Array {
  const head: number[] = [];
  for (const v of [0, TAKE_PROFIT_TIME_IN_FORCE, 0, Number(ORDER_LINK_MODE_BRACKET_PARENT), Number(BASE), 0, 0]) {
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
