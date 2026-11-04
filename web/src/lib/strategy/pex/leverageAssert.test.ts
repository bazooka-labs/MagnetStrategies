/**
 * The leverage check on an open — the one SPEC.md:117 calls the whole point.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * The previous check COULD NOT FAIL. It compared
 *
 *     aSize / legAmount           (from the group)
 *     shown.sizeUsdDeltaMicro / shown.collateralAmountMicro
 *
 * while `size_usd_delta` had already pinned `aSize` to
 * `shown.sizeUsdDeltaMicro` and `transfer_amount` had pinned `legAmount` to
 * `shown.collateralAmountMicro`, both by exact equality. Both sides were the
 * same two numbers. It passed on every group for every collateral, and its
 * `did(...)` line claimed a guarantee that did not exist. Found by review,
 * not by a failure — which is exactly how a tautological guard is found.
 *
 * The replacement compares against `asRenderedLeverage` (what the SCREEN
 * showed, which is not in the group) and values the collateral at a price
 * taken from the group's OWN signed oracle message (which the frontend does
 * not choose). The first test below is the one that matters: it builds a
 * group where every equality check passes and the leverage is still a lie.
 */

import { describe, expect, it } from "vitest";
import algosdk from "algosdk";
import {
  assertOpenGroup, SHAPE_OPEN, SHAPE_OPEN_STORAGE, SHAPE_OPEN_ALGO,
  SHAPE_OPEN_ALGO_STORAGE, openShapeFor, PEX_SELECTORS,
  STORAGE_ESCROW_MICRO_ALGO, type DisplayedOpen,
} from "@/lib/strategy/pex/group";
import {
  PEX_APPS, PEX_ASSETS, POSITION_BUILDER_FEE_BPS,
  BUILDER_ADDRESS, MAX_LEVERAGE_DRIFT_BPS,
} from "@/lib/strategy/pex/config";

const USER = "MAGNETTESTADDRESSMAGNETTESTADDRESSMAGNETTESTADDRESSMAG";
const TRADING_ADDR = algosdk.getApplicationAddress(PEX_APPS.trading).toString();
const EXEC = BigInt(90_000_000_000);
const INDEX = EXEC;
/** The live signed bands, 2026-11-03. USDC is NOT par. */
const USDC_PRICE12 = BigInt(999_799_062_875);
const ALGO_PRICE12 = BigInt(90_665_762_000);

const u64 = (v: bigint) => algosdk.encodeUint64(v);
const abiBytes = (b: Uint8Array) => {
  const out = new Uint8Array(2 + b.length);
  out[0] = (b.length >> 8) & 0xff; out[1] = b.length & 0xff; out.set(b, 2);
  return out;
};
const builderTuple = () => {
  const out = new Uint8Array(40);
  out.set(algosdk.decodeAddress(BUILDER_ADDRESS).publicKey, 0);
  out.set(u64(BigInt(POSITION_BUILDER_FEE_BPS)), 32);
  return out;
};
const sel = (h: string) => Uint8Array.from((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));

function oracleMessage(o: { longPrice?: bigint; shortPrice?: bigint; shortAssetId?: bigint } = {}) {
  const out = new Uint8Array(133);
  out.set([0x50, 0x44, 0x58, 0x32], 0);
  out[4] = 3;
  out.fill(0x11, 5, 37);
  const dv = new DataView(out.buffer);
  [
    BigInt(PEX_APPS.trading), BigInt(1), BigInt(0),
    BigInt(0), o.shortAssetId ?? BigInt(PEX_ASSETS.usdc),
    INDEX, INDEX,
    o.longPrice ?? ALGO_PRICE12, o.longPrice ?? ALGO_PRICE12,
    o.shortPrice ?? USDC_PRICE12, o.shortPrice ?? USDC_PRICE12,
    BigInt(1_790_000_000),
  ].forEach((w, i) => dv.setBigUint64(37 + i * 8, w, false));
  return out;
}

type Leg = Record<string, unknown> & { txID: () => string };
let nonce = 0;
const leg = (o: Record<string, unknown>): Leg => {
  const id = `TX${(nonce += 1)}`;
  return { fee: BigInt(1000), sender: USER, ...o, txID: () => id };
};

/** A structurally valid open: collateral leg, open call, math carrier. */
function group(opts: {
  assetId?: number; collateralMicro: bigint; sizeMicro: bigint; msg?: Uint8Array;
}): Leg[] {
  const msg = opts.msg ?? oracleMessage();
  const assetId = opts.assetId ?? PEX_ASSETS.usdc;
  const transfer = assetId === 0
    ? leg({ type: "pay", payment: { amount: opts.collateralMicro, receiver: TRADING_ADDR } })
    : leg({
      type: "axfer",
      assetTransfer: {
        assetIndex: BigInt(assetId), amount: opts.collateralMicro, receiver: TRADING_ADDR,
      },
    });
  return [
    transfer,
    leg({
      type: "appl", fee: BigInt(30_000),
      applicationCall: {
        appIndex: BigInt(PEX_APPS.trading),
        // A real open references the pool's short asset. With USDC collateral
        // that IS the collateral; with ALGO it is not, which is why the
        // allowed set had to be extended.
        foreignAssets: [BigInt(PEX_ASSETS.usdc)],
        appArgs: [
          sel(PEX_SELECTORS.openOrIncrease),
          u64(BigInt(1)), u64(BigInt(1)), u64(opts.sizeMicro),
          u64((EXEC * BigInt(10_030)) / BigInt(10_000)),
          builderTuple(),
          abiBytes(msg), abiBytes(new Uint8Array(64).fill(9)),
        ],
        accounts: [USER],
      },
    }),
    leg({
      type: "appl",
      applicationCall: { appIndex: BigInt(PEX_APPS.math), appArgs: [sel(PEX_SELECTORS.mathNoop)] },
    }),
  ];
}

const shown = (o: Partial<DisplayedOpen> & {
  collateralAmountMicro: bigint; sizeUsdDeltaMicro: bigint; asRenderedLeverage: number;
}): DisplayedOpen => ({
  storagePaymentMicro: BigInt(0),
  sender: USER, marketId: 1, side: 1,
  collateralAssetId: PEX_ASSETS.usdc,
  acceptablePrice12: (EXEC * BigInt(10_030)) / BigInt(10_000),
  executionPrice12: EXEC, indexPrice12: INDEX, slippageBps: 50,
  oracleMessage: oracleMessage(), oracleSignature: new Uint8Array(64).fill(9),
  poolAssets: [PEX_ASSETS.algo, PEX_ASSETS.usdc],
  ...o,
} as DisplayedOpen);

const codes = (r: { findings: { code: string }[] }) => r.findings.map((f) => f.code);
const run = (g: Leg[], s: DisplayedOpen) =>
  assertOpenGroup(g as never, s, SHAPE_OPEN);

const USDC_25 = BigInt(25_000_000);
const SIZE_100 = BigInt(100_000_000);

describe("the check the old one could not do", () => {
  it("catches a group that is honest about its parts and lying about its leverage", () => {
    /**
     * THE test. Size and collateral both match `shown` EXACTLY, so
     * `size_usd_delta` and `transfer_amount` both pass — and under the old
     * rule the leverage check was then guaranteed to pass too, because it
     * divided those same two numbers.
     *
     * Here the screen said 4x while the group encodes $100 against $25 of
     * USDC, which is very nearly 4x... so to make the lie real we say the
     * screen showed 2x. A user who was shown 2x is signing 4x.
     */
    const g = group({ collateralMicro: USDC_25, sizeMicro: SIZE_100 });
    const r = run(g, shown({
      collateralAmountMicro: USDC_25, sizeUsdDeltaMicro: SIZE_100,
      asRenderedLeverage: 2.0,
    }));
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("leverage");
    // and the parts really did pass, which is the point
    expect(codes(r)).not.toContain("size_usd_delta");
    expect(codes(r)).not.toContain("transfer_amount");
  });

  it("accepts the same group when the screen showed the truth", () => {
    const g = group({ collateralMicro: USDC_25, sizeMicro: SIZE_100 });
    // $100 / ($25 x 0.9998) = 4.0008x
    const r = run(g, shown({
      collateralAmountMicro: USDC_25, sizeUsdDeltaMicro: SIZE_100,
      asRenderedLeverage: 4.0,
    }));
    expect(codes(r)).not.toContain("leverage");
  });
});

describe("ALGO collateral is priced, not counted", () => {
  const ALGO_100 = BigInt(100_000_000);               // 100 ALGO
  // 100 ALGO at 0.090665762 = $9.0665762
  const algoShown = (lev: number) => shown({
    collateralAssetId: PEX_ASSETS.algo,
    collateralAmountMicro: ALGO_100,
    sizeUsdDeltaMicro: BigInt(27_000_000),            // $27 notional
    asRenderedLeverage: lev,
  });

  it("values 100 ALGO at the signed price, not at $100", () => {
    // $27 / $9.0666 = 2.978x. If µALGO were counted as µUSD it would be 0.27x.
    const g = group({
      assetId: PEX_ASSETS.algo, collateralMicro: ALGO_100, sizeMicro: BigInt(27_000_000),
    });
    const r = run(g, algoShown(2.978));
    expect(codes(r)).not.toContain("leverage");
  });

  it("rejects the µALGO-as-µUSD reading, which is the ~10x bug", () => {
    const g = group({
      assetId: PEX_ASSETS.algo, collateralMicro: ALGO_100, sizeMicro: BigInt(27_000_000),
    });
    // What a card would show if it treated 100 ALGO as $100.
    const r = run(g, algoShown(0.27));
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("leverage");
  });
});

describe("the price comes from the group's own message", () => {
  it("refuses when that message prices no such collateral", () => {
    // A message whose short asset is something else entirely: the collateral
    // is then unpriceable and the check refuses rather than guessing.
    const msg = oracleMessage({ shortAssetId: BigInt(1234567) });
    const g = group({ collateralMicro: USDC_25, sizeMicro: SIZE_100, msg });
    const r = run(g, shown({
      collateralAmountMicro: USDC_25, sizeUsdDeltaMicro: SIZE_100,
      asRenderedLeverage: 4.0, oracleMessage: msg,
    }));
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("leverage_unpriceable");
  });

  it("follows the message's price, so a different price moves the verdict", () => {
    // Same group, same screen figure, ALGO signed 50% lower: the collateral is
    // worth half as much, so the real leverage doubles and the check fires.
    const cheap = oracleMessage({ longPrice: ALGO_PRICE12 / BigInt(2) });
    const g = group({
      assetId: PEX_ASSETS.algo, collateralMicro: BigInt(100_000_000),
      sizeMicro: BigInt(27_000_000), msg: cheap,
    });
    const r = run(g, shown({
      collateralAssetId: PEX_ASSETS.algo,
      collateralAmountMicro: BigInt(100_000_000),
      sizeUsdDeltaMicro: BigInt(27_000_000),
      asRenderedLeverage: 2.978, oracleMessage: cheap,
    }));
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("leverage");
  });
});

describe("the drift budget", () => {
  const base = { collateralMicro: USDC_25, sizeMicro: SIZE_100 };
  /** The group's true leverage at the signed USDC price. */
  const TRUE_LEV = Number(SIZE_100) / (Number(USDC_25) * Number(USDC_PRICE12) / 1e12);

  it("tolerates drift inside the budget", () => {
    const inside = TRUE_LEV * (1 - (MAX_LEVERAGE_DRIFT_BPS - 20) / 10_000);
    const r = run(group(base), shown({
      collateralAmountMicro: USDC_25, sizeUsdDeltaMicro: SIZE_100,
      asRenderedLeverage: inside,
    }));
    expect(codes(r)).not.toContain("leverage");
  });

  it("fails just outside it", () => {
    const outside = TRUE_LEV * (1 - (MAX_LEVERAGE_DRIFT_BPS + 20) / 10_000);
    const r = run(group(base), shown({
      collateralAmountMicro: USDC_25, sizeUsdDeltaMicro: SIZE_100,
      asRenderedLeverage: outside,
    }));
    expect(codes(r)).toContain("leverage");
  });

  it("FAILS, rather than skipping, when the screen's leverage is unusable", () => {
    /**
     * This test used to assert the opposite — that a zero was skipped — and
     * review showed the skip was a hole in the only guard against reading
     * µALGO as µUSD. Any caller passing 0 silently lost it.
     *
     * Infinity was worse than a skip: it reached the comparison, produced a
     * NaN drift, and `NaN > MAX` is false, so the group PASSED. The bound is
     * now written negated so NaN fails.
     */
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const r = run(group(base), shown({
        collateralAmountMicro: USDC_25, sizeUsdDeltaMicro: SIZE_100,
        asRenderedLeverage: bad,
      }));
      expect(r.ok, `leverage ${bad} was accepted`).toBe(false);
      expect(codes(r), `leverage ${bad}`).toContain("leverage_missing");
    }
  });
});

describe("the open shapes keep their transfer budget", () => {
  it("pins an EXACT count per transfer kind, so none can be added", () => {
    /**
     * The reason these are four constants rather than one widened shape.
     *
     * Note what the invariant is NOT: `SHAPE_OPEN_STORAGE` is
     * `axfer: 1, pay: 1`, because a USDC open that funds storage carries the
     * collateral transfer AND the storage payment. An earlier version of this
     * test asserted "never both kinds" and went red here — correctly.
     *
     * The real property is that every count is exact, so a range like
     * `axfer: 0..1, pay: 0..1` would let a non-storage open carry two
     * transfers where an honest one carries a single leg.
     */
    for (const [name, sh] of Object.entries({
      SHAPE_OPEN, SHAPE_OPEN_STORAGE, SHAPE_OPEN_ALGO, SHAPE_OPEN_ALGO_STORAGE,
    })) {
      expect(Number.isInteger(sh.axfer), `${name} axfer is not an exact count`).toBe(true);
      expect(Number.isInteger(sh.pay), `${name} pay is not an exact count`).toBe(true);
    }
    // One transfer bare, two when storage is funded — for either collateral.
    expect(SHAPE_OPEN.axfer + SHAPE_OPEN.pay).toBe(1);
    expect(SHAPE_OPEN_ALGO.axfer + SHAPE_OPEN_ALGO.pay).toBe(1);
    expect(SHAPE_OPEN_STORAGE.axfer + SHAPE_OPEN_STORAGE.pay).toBe(2);
    expect(SHAPE_OPEN_ALGO_STORAGE.axfer + SHAPE_OPEN_ALGO_STORAGE.pay).toBe(2);
  });

  it("moves the collateral leg between budgets without adding one", () => {
    // Same total transfers, reclassified: ALGO collateral is a payment.
    expect(SHAPE_OPEN.axfer + SHAPE_OPEN.pay).toBe(SHAPE_OPEN_ALGO.axfer + SHAPE_OPEN_ALGO.pay);
    expect(SHAPE_OPEN_STORAGE.axfer + SHAPE_OPEN_STORAGE.pay)
      .toBe(SHAPE_OPEN_ALGO_STORAGE.axfer + SHAPE_OPEN_ALGO_STORAGE.pay);
  });

  it("picks by collateral and by whether storage is funded", () => {
    expect(openShapeFor(PEX_ASSETS.usdc, false)).toBe(SHAPE_OPEN);
    expect(openShapeFor(PEX_ASSETS.usdc, true)).toBe(SHAPE_OPEN_STORAGE);
    expect(openShapeFor(PEX_ASSETS.algo, false)).toBe(SHAPE_OPEN_ALGO);
    expect(openShapeFor(PEX_ASSETS.algo, true)).toBe(SHAPE_OPEN_ALGO_STORAGE);
  });
});


describe("the pool-asset enumeration", () => {
  const algoShownBase = {
    collateralAssetId: PEX_ASSETS.algo,
    collateralAmountMicro: BigInt(100_000_000),
    sizeUsdDeltaMicro: BigInt(27_000_000),
    asRenderedLeverage: 2.978,
  };
  const algoGroup = () => group({
    assetId: PEX_ASSETS.algo, collateralMicro: BigInt(100_000_000),
    sizeMicro: BigInt(27_000_000),
  });

  it("lets an ALGO group reference the pool's USDC side", () => {
    // Without the enumeration this is `foreign_asset` and every ALGO open
    // and close fails. That was the live symptom.
    const r = run(algoGroup(), shown({
      ...algoShownBase, poolAssets: [PEX_ASSETS.algo, PEX_ASSETS.usdc],
    }));
    expect(codes(r)).not.toContain("foreign_asset");
  });

  it("refuses that reference when the pool assets are NOT supplied", () => {
    // Proves the allowance is doing the work, rather than something else
    // having quietly stopped checking.
    const r = run(algoGroup(), shown({ ...algoShownBase, poolAssets: [] }));
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("foreign_asset");
  });

  it("PINS what may be enumerated, so a caller cannot widen it", () => {
    /**
     * The enumeration is supplied by the caller from its own chain read. The
     * pin is what stops that becoming "allow whatever you like". Review found
     * it had no test at all: replacing the condition with `if (false)` left
     * the whole suite green.
     */
    const r = run(algoGroup(), shown({
      ...algoShownBase, poolAssets: [PEX_ASSETS.algo, 999_999],
    }));
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("pool_asset_unpinned");
  });

  it("does not let a pinned-out asset through on the back of a valid one", () => {
    // The junk id must be rejected AND not silently added to the allowed set.
    const r = run(algoGroup(), shown({
      ...algoShownBase, poolAssets: [999_999],
    }));
    expect(codes(r)).toContain("pool_asset_unpinned");
    expect(codes(r)).toContain("foreign_asset");
  });
});


describe("where value may go", () => {
  const ATTACKER = "7777777777777777777777777777777777777777777777777774MSJUVU";
  const pay = (to: string, amount: bigint) =>
    leg({ type: "pay", payment: { amount, receiver: to } });

  it("refuses a payment to anywhere that is not a PEX app", () => {
    /**
     * The hole review built by hand. Each LEG had its receiver bound — the
     * collateral, the keeper escrow, the storage payment — and a payment
     * belonging to none of them was bound by nothing. Survivable while a
     * group could hold one transfer; `SHAPE_OPEN_ALGO_STORAGE` allows two.
     *
     * 50 ALGO to an arbitrary address, beside an otherwise honest group.
     */
    const g = group({ collateralMicro: USDC_25, sizeMicro: SIZE_100 });
    g.splice(1, 0, pay(ATTACKER, BigInt(50_000_000)));
    const r = run(g, shown({
      collateralAmountMicro: USDC_25, sizeUsdDeltaMicro: SIZE_100,
      asRenderedLeverage: 4.0,
    }));
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("value_leaves_pex");
  });

  it("refuses an asset transfer to anywhere that is not a PEX app", () => {
    const g = group({ collateralMicro: USDC_25, sizeMicro: SIZE_100 });
    g.splice(1, 0, leg({
      type: "axfer",
      assetTransfer: {
        assetIndex: BigInt(PEX_ASSETS.usdc), amount: BigInt(9_000_000), receiver: ATTACKER,
      },
    }));
    const r = run(g, shown({
      collateralAmountMicro: USDC_25, sizeUsdDeltaMicro: SIZE_100,
      asRenderedLeverage: 4.0,
    }));
    expect(codes(r)).toContain("value_leaves_pex");
  });

  it("still accepts an honest group, so the rule is not simply refusing everything", () => {
    const r = run(group({ collateralMicro: USDC_25, sizeMicro: SIZE_100 }), shown({
      collateralAmountMicro: USDC_25, sizeUsdDeltaMicro: SIZE_100,
      asRenderedLeverage: 4.0,
    }));
    expect(codes(r)).not.toContain("value_leaves_pex");
  });
});

describe("the storage payment is not confused with the collateral", () => {
  it("refuses when the collateral is the only thing that looks like storage", () => {
    /**
     * The exact shape review described, built so the SHAPE GATE cannot be
     * what catches it — two payments, which `SHAPE_OPEN_ALGO_STORAGE` allows.
     *
     *   [0] collateral: exactly the storage constant, to Trading
     *   [1] open call            <- collateral is at openIdx - 1, as required
     *   [2] 50 ALGO to Trading   <- examined by nothing
     *
     * Taking the FIRST payment to Trading finds the collateral, matches the
     * pinned storage amount, and passes — leaving the 50 ALGO unaccounted
     * for. Trading is a PEX app, so the receiver rule does not catch it
     * either. Only excluding the collateral leg by identity does.
     */
    const msg = oracleMessage();
    const collateral = leg({
      type: "pay",
      payment: { amount: STORAGE_ESCROW_MICRO_ALGO, receiver: TRADING_ADDR },
    });
    const openCall = leg({
      type: "appl", fee: BigInt(30_000),
      applicationCall: {
        appIndex: BigInt(PEX_APPS.trading),
        foreignAssets: [BigInt(PEX_ASSETS.usdc)],
        appArgs: [
          sel(PEX_SELECTORS.openOrIncrease),
          u64(BigInt(1)), u64(BigInt(1)), u64(BigInt(27_000)),
          u64((EXEC * BigInt(10_030)) / BigInt(10_000)),
          builderTuple(),
          abiBytes(msg), abiBytes(new Uint8Array(64).fill(9)),
        ],
        accounts: [USER],
      },
    });
    const siphon = leg({
      type: "pay",
      payment: { amount: BigInt(50_000_000), receiver: TRADING_ADDR },
    });
    const math = leg({
      type: "appl",
      applicationCall: { appIndex: BigInt(PEX_APPS.math), appArgs: [sel(PEX_SELECTORS.mathNoop)] },
    });

    // The storage shape leads with fund_storage, so the group needs it too —
    // otherwise the call budget refuses before the storage logic is reached
    // and the test proves nothing about what it claims to.
    const fundStorage = leg({
      type: "appl",
      applicationCall: {
        appIndex: BigInt(PEX_APPS.trading),
        appArgs: [sel(PEX_SELECTORS.fundStorage)],
      },
    });

    const r = assertOpenGroup([collateral, fundStorage, openCall, siphon, math] as never, shown({
      collateralAssetId: PEX_ASSETS.algo,
      collateralAmountMicro: STORAGE_ESCROW_MICRO_ALGO,
      sizeUsdDeltaMicro: BigInt(27_000),
      asRenderedLeverage: 2.7,
      storagePaymentMicro: STORAGE_ESCROW_MICRO_ALGO,
      oracleMessage: msg,
    }), SHAPE_OPEN_ALGO_STORAGE);

    expect(r.ok, "a group with an unaccounted 50 ALGO payment was accepted").toBe(false);
    // Specifically a STORAGE finding: the shape gate is satisfied here, so if
    // this passes on `pay_count` the test is proving nothing.
    expect(codes(r).join(",")).toMatch(/storage_payment_/);
  });

  it("ACCEPTS the honest ALGO group that funds storage", () => {
    /**
     * The other half, and the one that pins the EXCLUSION specifically.
     *
     * An honest ALGO open with storage carries two payments to Trading: the
     * escrow and the collateral. Refusing the pair as "ambiguous" would block
     * every first ALGO trade — so the collateral is excluded by identity
     * before the ambiguity rule is applied, and what remains is the one real
     * storage payment.
     *
     * Without that exclusion this group is refused, which is how the two
     * rules are told apart.
     */
    const msg = oracleMessage();
    const storagePay = leg({
      type: "pay",
      payment: { amount: STORAGE_ESCROW_MICRO_ALGO, receiver: TRADING_ADDR },
    });
    const fundStorage = leg({
      type: "appl",
      applicationCall: {
        appIndex: BigInt(PEX_APPS.trading),
        appArgs: [sel(PEX_SELECTORS.fundStorage)],
      },
    });
    const collateral = leg({
      type: "pay",
      payment: { amount: BigInt(100_000_000), receiver: TRADING_ADDR },
    });
    const openCall = leg({
      type: "appl", fee: BigInt(30_000),
      applicationCall: {
        appIndex: BigInt(PEX_APPS.trading),
        foreignAssets: [BigInt(PEX_ASSETS.usdc)],
        appArgs: [
          sel(PEX_SELECTORS.openOrIncrease),
          u64(BigInt(1)), u64(BigInt(1)), u64(BigInt(27_000_000)),
          u64((EXEC * BigInt(10_030)) / BigInt(10_000)),
          builderTuple(),
          abiBytes(msg), abiBytes(new Uint8Array(64).fill(9)),
        ],
        accounts: [USER],
      },
    });
    const math = leg({
      type: "appl",
      applicationCall: { appIndex: BigInt(PEX_APPS.math), appArgs: [sel(PEX_SELECTORS.mathNoop)] },
    });

    const r = assertOpenGroup(
      [storagePay, fundStorage, collateral, openCall, math] as never,
      shown({
        collateralAssetId: PEX_ASSETS.algo,
        collateralAmountMicro: BigInt(100_000_000),
        sizeUsdDeltaMicro: BigInt(27_000_000),
        asRenderedLeverage: 2.978,
        storagePaymentMicro: STORAGE_ESCROW_MICRO_ALGO,
        oracleMessage: msg,
      }),
      SHAPE_OPEN_ALGO_STORAGE,
    );
    expect(codes(r)).not.toContain("storage_payment_ambiguous");
    expect(codes(r)).not.toContain("storage_payment_missing");
    expect(codes(r)).not.toContain("value_leaves_pex");
  });
});
