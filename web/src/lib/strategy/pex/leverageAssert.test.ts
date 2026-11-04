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
  SHAPE_OPEN_ALGO_STORAGE, openShapeFor, PEX_SELECTORS, type DisplayedOpen,
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

  it("is skipped when the screen showed no leverage", () => {
    const r = run(group(base), shown({
      collateralAmountMicro: USDC_25, sizeUsdDeltaMicro: SIZE_100,
      asRenderedLeverage: 0,
    }));
    expect(codes(r)).not.toContain("leverage");
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
